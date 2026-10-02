/** Build a live catalog and execute code against configured apps. */
import { CodeMode, Tool, toolError } from "@opencode-ai/codemode";
import {
  Json,
  AppSlug,
  JsonObject,
  AppEvaluationFailed,
  ToolApprovalRequired,
  type AppId,
  type Cursor,
  type DeploymentId,
  type Tool as AppTool,
} from "@executor-js/sdk/core";
import { Clock, Duration, Effect, Option, Schema, Semaphore } from "effect";
import { diagnostic, executionDiagnostic } from "./diagnostics.ts";
import { referencedApps } from "./discovery.ts";
import type { McpTarget } from "../contracts/targets.ts";
import type { McpBackend } from "../contracts/backend.ts";
import {
  AppProfileRequired,
  defaultMcpRuntimeLimits,
  SearchInput,
  SearchResult,
  type McpLimits,
  type McpToolCall,
  type UnavailableApp,
} from "../contracts/execute.ts";

type Catalog = Record<string, Record<string, Tool.Tool>>;
type ToolSource = {
  readonly catalog: {
    readonly input: Parameters<McpBackend<Error>["indexTools"]>[0] & {
      readonly deployment: DeploymentId;
    };
    readonly size: number;
  };
  readonly name: AppTool["name"];
};

// Equivalent JSON Schema normalization: the upstream signature renderer only
// renders index signatures when additionalProperties is a schema, rather than true.
function renderableSchema(input: Tool.JsonSchema): Tool.JsonSchema {
  return {
    ...input,
    ...(input.type === "object" && input.additionalProperties !== false
      ? {
          additionalProperties:
            typeof input.additionalProperties === "object"
              ? renderableSchema(input.additionalProperties)
              : {},
        }
      : {}),
    ...(input.properties === undefined
      ? {}
      : {
          properties: Object.fromEntries(
            Object.entries(input.properties).map(([name, schema]) => [
              name,
              renderableSchema(schema),
            ]),
          ),
        }),
    ...(input.items === undefined ? {} : { items: renderableSchema(input.items) }),
    ...(input.anyOf === undefined ? {} : { anyOf: input.anyOf.map(renderableSchema) }),
    ...(input.oneOf === undefined ? {} : { oneOf: input.oneOf.map(renderableSchema) }),
    ...(input.allOf === undefined ? {} : { allOf: input.allOf.map(renderableSchema) }),
    ...(input.$defs === undefined
      ? {}
      : {
          $defs: Object.fromEntries(
            Object.entries(input.$defs).map(([name, schema]) => [name, renderableSchema(schema)]),
          ),
        }),
  };
}

// Codemode treats dots as namespace separators. Leave ordinary names readable;
// only escape characters needed to distinguish inaccessible/reserved segments.
function toolPath(name: string): string {
  return name
    .split(".")
    .map((segment) => {
      if (segment === "") return "%00";
      if (["__proto__", "prototype", "constructor"].includes(segment)) return `%${segment}`;
      return segment.replaceAll("%", "%25");
    })
    .join(".");
}

function indexTools<E extends Error>(backend: McpBackend<E>, app: AppId, target: McpTarget) {
  return Effect.gen(function* () {
    const selection =
      target.kind === "app" ? {} : { profile: target.id, expectedProfileRevision: target.revision };
    const index = yield* backend.indexTools({ app, ...selection });
    return { tools: index.items, deployment: index.deployment, selection };
  });
}

function listTools<E extends Error>(
  backend: McpBackend<E>,
  input: Parameters<McpBackend<E>["listTools"]>[0],
) {
  return Effect.gen(function* () {
    const tools: AppTool[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = yield* backend.listTools({
        ...input,
        cursor,
        limit: 2_000,
      });
      tools.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
    return tools;
  });
}

function catalog(backend: McpBackend<Error>, selected: ReadonlySet<string> | undefined) {
  return Effect.gen(function* () {
    const concurrency = defaultMcpRuntimeLimits.discoveryConcurrency;
    const slots = yield* Semaphore.make(concurrency);
    const discover = <A, E, R>(name: string, work: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const queued = yield* Clock.currentTimeMillis;
        return yield* slots.withPermits(1)(
          Effect.gen(function* () {
            yield* Effect.annotateCurrentSpan(
              "executor.discovery.wait_ms",
              (yield* Clock.currentTimeMillis) - queued,
            );
            return yield* work;
          }),
        );
      }).pipe(Effect.withSpan(name));
    const apps =
      selected?.size === 0
        ? []
        : yield* backend.listApps().pipe(
            Effect.map((apps) =>
              apps.filter((app) => selected === undefined || selected.has(app.slug)),
            ),
            Effect.withSpan("mcp.discovery.apps"),
          );
    yield* Effect.annotateCurrentSpan({
      "executor.discovery.apps": apps.length,
      "executor.discovery.concurrency": concurrency,
    });
    const counts = new Map<string, number>();
    for (const app of apps) counts.set(app.slug, (counts.get(app.slug) ?? 0) + 1);
    const discovered = yield* Effect.forEach(
      apps,
      (app) =>
        Effect.gen(function* () {
          if (!Schema.is(AppSlug)(app.slug) || counts.get(app.slug) !== 1)
            return {
              app,
              targets: [],
              error: !Schema.is(AppSlug)(app.slug) ? "AppSlugInvalid" : "AppSlugAmbiguous",
            };
          return yield* discover(
            "mcp.discovery.targets",
            backend.listTargets({ app: app.id }),
          ).pipe(
            Effect.flatMap((targets) =>
              Effect.forEach(
                targets,
                (target) =>
                  discover("mcp.discovery.tools", indexTools(backend, app.id, target)).pipe(
                    Effect.map((catalog) => ({ target, catalog, error: undefined })),
                    Effect.catch((error) =>
                      Effect.succeed({ target, catalog: undefined, error: diagnostic(error) }),
                    ),
                  ),
                { concurrency: "unbounded" },
              ),
            ),
            Effect.map((targets) => ({ app, targets, error: undefined })),
            Effect.catch((error) => Effect.succeed({ app, targets: [], error: diagnostic(error) })),
          );
        }),
      { concurrency: "unbounded" },
    );
    const tools: Catalog = Object.create(null);
    const sources = new Map<string, ToolSource>();
    const unavailableApps: Array<typeof UnavailableApp.Type> = [];
    // Tool path prefixes that expose no tools in this execution, and those that do. A call is
    // attributed to the longest matching prefix, so a typo inside a loaded namespace stays unknown.
    const namespaces: Namespaces = new Map();
    for (const { app, targets, error } of discovered) {
      const unique = Schema.is(AppSlug)(app.slug) && counts.get(app.slug) === 1;
      if (error !== undefined) {
        const entry = { app: app.id, name: app.name, reason: error };
        unavailableApps.push(entry);
        if (unique) namespaces.set(app.slug, entry);
        continue;
      }
      // An app that needs accounts exposes no target when the caller has no enabled profile.
      // Report that only when the program calls into it: every execute lists unavailable apps,
      // and most members never set up most of their organization's account apps.
      if (targets.length === 0) {
        if (unique)
          namespaces.set(app.slug, {
            app: app.id,
            name: app.name,
            reason: diagnostic(new AppProfileRequired({ app: app.id })),
          });
        tools[app.slug] = {};
        continue;
      }
      const entries: Array<readonly [string, Tool.Tool]> = [];
      for (const { target, catalog, error } of targets) {
        const namespace =
          target.kind === "app" ? app.slug : `${app.slug}.profiles.${toolPath(target.id)}`;
        if (catalog === undefined) {
          const entry = {
            app: app.id,
            name: app.name,
            ...(target.kind === "profile" ? { profile: target.id } : {}),
            reason: error,
          };
          unavailableApps.push(entry);
          namespaces.set(namespace, entry);
          continue;
        }
        namespaces.set(namespace, "available");
        const source = {
          input: {
            app: app.id,
            deployment: catalog.deployment,
            ...catalog.selection,
          },
          size: catalog.tools.length,
        };
        for (const tool of catalog.tools) {
          const path =
            target.kind === "app"
              ? toolPath(tool.name)
              : `profiles.${toolPath(target.id)}.${toolPath(tool.name)}`;
          sources.set(`${app.slug}.${path}`, { catalog: source, name: tool.name });
          entries.push([
            path,
            Tool.make({
              description: `${app.name}${target.kind === "profile" ? ` (${target.label})` : ""}: ${tool.description}`,
              input: {},
              output: {},
              execute: (input) =>
                Schema.decodeUnknownEffect(Json)(input).pipe(
                  Effect.mapError(() => toolError("Tool arguments must be JSON")),
                  Effect.flatMap((input) =>
                    backend
                      .callTool({
                        app: app.id,
                        deployment: catalog.deployment,
                        ...catalog.selection,
                        tool: tool.name,
                        input,
                      })
                      .pipe(
                        Effect.flatMap((result) =>
                          result.status === "completed"
                            ? Effect.succeed(result.value)
                            : Effect.fail(
                                new ToolApprovalRequired({
                                  app: result.invocation.app,
                                  deployment: result.invocation.deployment,
                                  tool: result.invocation.tool,
                                }),
                              ),
                        ),
                        Effect.mapError((error) => toolError(diagnostic(error))),
                      ),
                  ),
                ),
            }),
          ]);
        }
      }
      // An app none of whose targets loaded is unavailable as a whole.
      const failed = unavailableApps.find((entry) => entry.app === app.id);
      if (entries.length === 0 && failed !== undefined && !namespaces.has(app.slug))
        namespaces.set(app.slug, failed);
      tools[app.slug] = Object.fromEntries(entries);
    }
    yield* Effect.annotateCurrentSpan({
      "executor.discovery.targets": discovered.reduce((sum, app) => sum + app.targets.length, 0),
      "executor.discovery.tools": Object.values(tools).reduce(
        (sum, entries) => sum + Object.keys(entries).length,
        0,
      ),
      "executor.discovery.unavailable": unavailableApps.length,
    });
    return { tools, sources, unavailableApps, namespaces };
  });
}

function describeTools(
  backend: McpBackend<Error>,
  entries: readonly CodeMode.ToolDescription[],
  sources: ReadonlyMap<string, ToolSource>,
) {
  return Effect.gen(function* () {
    const groups = new Map<
      ToolSource["catalog"],
      Array<{ name: AppTool["name"]; entry: CodeMode.ToolDescription }>
    >();
    for (const entry of entries) {
      const source = sources.get(entry.path);
      if (source === undefined)
        return yield* Effect.fail(toolError("Tool metadata is unavailable"));
      const group = groups.get(source.catalog) ?? [];
      group.push({ name: source.name, entry });
      groups.set(source.catalog, group);
    }
    const batches = yield* Effect.forEach(
      groups,
      ([source, selected]) =>
        Effect.gen(function* () {
          const filtered = {
            ...source.input,
            tools: selected.map(({ name }) => name),
          };
          const tools = yield* (
            selected.length > 64 && selected.length === source.size
              ? listTools(backend, source.input).pipe(
                  Effect.catch((error) =>
                    Schema.is(AppEvaluationFailed)(error)
                      ? listTools(backend, filtered)
                      : Effect.fail(error),
                  ),
                )
              : listTools(backend, filtered)
          ).pipe(Effect.mapError((error) => toolError(diagnostic(error))));
          const byName = new Map(tools.map((tool) => [tool.name, tool]));
          return yield* Effect.forEach(selected, ({ name, entry }) =>
            Effect.gen(function* () {
              const tool = byName.get(name);
              if (tool === undefined)
                return yield* Effect.fail(
                  toolError(`Tool metadata is no longer available for '${entry.path}'`),
                );
              const schema = yield* Schema.decodeUnknownEffect(JsonObject)(tool.inputSchema).pipe(
                Effect.mapError(() => toolError("Tool metadata is invalid")),
              );
              return [
                entry.path,
                Tool.make({
                  description: entry.description,
                  input: renderableSchema(schema),
                  output:
                    tool.outputSchema === undefined
                      ? Schema.Json
                      : renderableSchema(tool.outputSchema),
                  execute: () => Effect.void,
                }),
              ] as const;
            }),
          );
        }),
      { concurrency: defaultMcpRuntimeLimits.discoveryConcurrency },
    );
    const descriptions = new Map(
      CodeMode.make({ tools: Object.fromEntries(batches.flat()) })
        .catalog()
        .map((entry) => [entry.path, entry]),
    );
    return yield* Effect.forEach(entries, (entry) => {
      const description = descriptions.get(entry.path);
      return description === undefined
        ? Effect.fail(toolError("Tool metadata is unavailable"))
        : Effect.succeed({ ...description, path: CodeMode.toolExpression(entry.path) });
    });
  }).pipe(Effect.withSpan("mcp.discovery.schemas"));
}

/** Unavailable namespaces map to their reason; loaded ones are marked available. */
type Namespaces = Map<string, typeof UnavailableApp.Type | "available">;

/** What one execution has done so far, so a result assembled by its driver stays accurate. */
export type ExecutionProgress = {
  /** Calls admitted by the program, updated as each call starts and ends. */
  readonly calls: Array<{
    readonly name: string;
    outcome: McpToolCall["outcome"] | "running";
    durationMs?: number;
  }>;
  /** The call index each running tool fiber serves, so the driver can mark its approval wait. */
  readonly callFibers: Map<number, number>;
  /** `program` once discovery has finished and program code may run. */
  phase: "discovery" | "program";
  unavailableApps: ReadonlyArray<typeof UnavailableApp.Type>;
};
export const executionProgress = (): ExecutionProgress => ({
  calls: [],
  callFibers: new Map(),
  phase: "discovery",
  unavailableApps: [],
});

/**
 * A call into an app that failed to load is not an unknown tool: report why the app is unavailable.
 * CodeMode names the unresolved canonical path in its UnknownTool diagnostic.
 */
const unavailableTarget = (error: CodeMode.Diagnostic, namespaces: Namespaces) => {
  if (error.kind !== "UnknownTool") return undefined;
  const path = /^(?:Unknown tool(?: namespace)? |Tool )'([^']*)'/.exec(error.message)?.[1];
  if (path === undefined) return undefined;
  const segments = path.split(".");
  for (let length = segments.length; length > 0; length--) {
    const found = namespaces.get(segments.slice(0, length).join("."));
    if (found === "available") return undefined;
    if (found !== undefined) return found;
  }
  return undefined;
};

/**
 * A snapshot for a result. A call still running when the execution ends is reported as
 * interrupted. A driver-assembled result lists only calls whose start was recorded.
 */
export const reportedCalls = (progress: ExecutionProgress): Array<McpToolCall> =>
  progress.calls.flatMap((call) =>
    call === undefined
      ? []
      : [
          {
            name: call.name,
            outcome: call.outcome === "running" ? "interrupted" : call.outcome,
            ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
          },
        ],
  );

/** The phase a timed-out execution was in, so callers can tell slow discovery from a slow program. */
export const timeoutMessage = (timeoutMs: number, phase: "discovery" | "program") =>
  phase === "discovery"
    ? `Execution timed out after ${timeoutMs}ms while loading app tools; no program code ran.`
    : `Execution timed out after ${timeoutMs}ms; earlier tool calls may have completed.`;

/**
 * After the budget is spent, CodeMode interrupts the program and returns its calls and logs.
 * The driver waits this long for that result. If it does not arrive, the driver reports the
 * calls it recorded (without logs); the run's cleanup continues in the background either way.
 */
export const timeoutDeliveryMs = 1_000;

// CodeMode's execution timeout sleeps for exactly `timeoutMs`. End that sleep at the host's
// deadline, so CodeMode stops the program itself and returns the calls and logs it has so far.
// Every other sleep keeps real time.
const deadlineClock = (
  clock: Clock.Clock,
  timeoutMs: number,
  deadline: Effect.Effect<void>,
): Clock.Clock => ({
  currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
  currentTimeMillis: clock.currentTimeMillis,
  currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
  currentTimeNanos: clock.currentTimeNanos,
  monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: clock.monotonicTimeNanos,
  sleep: (duration) =>
    Duration.toMillis(duration) === timeoutMs ? deadline : clock.sleep(duration),
});

/**
 * Internal interpreter entry. `deadline` completes when the execution's budget is spent; the
 * caller decides whether that is wall time or active time. Discovery stops at the deadline;
 * a running program is stopped by CodeMode so its admitted calls and logs are returned.
 */
export function executeProgram(
  backend: McpBackend<Error>,
  limits: McpLimits,
  code: string,
  deadline: Effect.Effect<void>,
  progress: ExecutionProgress,
) {
  return Effect.suspend(() => {
    const failure = (kind: CodeMode.DiagnosticKind, message: string) => ({
      execution: executionDiagnostic({
        ok: false as const,
        error: { kind, message },
        toolCalls: reportedCalls(progress),
      }),
      unavailableApps: progress.unavailableApps,
    });
    return Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      // Tools run on the real clock; only CodeMode's own timeout follows the deadline.
      const tools: McpBackend<Error> = {
        ...backend,
        callTool: (input, options) =>
          backend.callTool(input, options).pipe(Effect.provideService(Clock.Clock, clock)),
      };
      const loaded = yield* catalog(tools, referencedApps(code)).pipe(
        Effect.withSpan("mcp.catalog"),
        Effect.map(Option.some),
        Effect.raceFirst(deadline.pipe(Effect.as(Option.none()))),
      );
      if (Option.isNone(loaded)) {
        yield* Effect.annotateCurrentSpan("executor.timeout.phase", "discovery");
        return failure("TimeoutExceeded", timeoutMessage(limits.timeoutMs, "discovery"));
      }
      const prepared = loaded.value;
      progress.unavailableApps = prepared.unavailableApps;
      progress.phase = "program";
      const search = Tool.make({
        description: "Find available app tools and their callable signatures.",
        input: SearchInput,
        output: SearchResult,
        execute: ({ query = "", namespace, limit = 10, offset = 0 }) =>
          Effect.gen(function* () {
            const terms = query
              .replace(/([a-z])([A-Z])/g, "$1 $2")
              .toLowerCase()
              .split(/[^a-z0-9]+/)
              .filter(Boolean);
            const visible = entries.filter(
              (entry) =>
                namespace === undefined ||
                entry.path === namespace ||
                entry.path.startsWith(`${namespace}.`) ||
                CodeMode.toolExpression(entry.path).startsWith(`${namespace}.`),
            );
            const exact = visible.find(
              (entry) => query === entry.path || query === CodeMode.toolExpression(entry.path),
            );
            const matches =
              exact === undefined
                ? visible
                    .map((entry) => ({
                      entry,
                      score: terms.reduce(
                        (sum, term) =>
                          sum +
                          (entry.path.toLowerCase().includes(term) ? 3 : 0) +
                          (entry.description.toLowerCase().includes(term) ? 1 : 0),
                        0,
                      ),
                    }))
                    .filter(({ score }) => terms.length === 0 || score > 0)
                    .sort((a, b) => b.score - a.score)
                    .map(({ entry }) => entry)
                : [exact];
            const items = yield* describeTools(
              tools,
              matches.slice(offset, offset + limit),
              prepared.sources,
            );
            const remaining = Math.max(0, matches.length - offset - items.length);
            return {
              items,
              remaining,
              next: remaining > 0 ? { offset: offset + items.length } : null,
            };
          }),
      });
      const runtime = CodeMode.make({
        tools: { ...prepared.tools, search },
        limits,
        // Both hooks run on the fiber that makes the call.
        onToolCallStart: ({ index, name }) =>
          Effect.map(Effect.fiberId, (fiber) => {
            progress.calls[index] = { name, outcome: "running" };
            progress.callFibers.set(fiber, index);
          }),
        onToolCallEnd: ({ index, outcome, durationMs }) =>
          Effect.map(Effect.fiberId, (fiber) => {
            progress.callFibers.delete(fiber);
            const call = progress.calls[index];
            if (call === undefined) return;
            // A call interrupted while it waited for approval never ran.
            if (
              !(outcome === "interrupted" && call.outcome === "awaiting-approval") &&
              !(outcome === "success" && call.outcome === "failure")
            )
              call.outcome = outcome;
            call.durationMs = durationMs;
          }),
      });
      const entries: ReadonlyArray<CodeMode.ToolDescription> = runtime
        .catalog()
        .filter((entry) => entry.path !== "search");
      const result = yield* runtime
        .execute(code)
        .pipe(
          Effect.provideService(Clock.Clock, deadlineClock(clock, limits.timeoutMs, deadline)),
          Effect.flatMap(Schema.decodeUnknownEffect(CodeMode.Result)),
        );
      // CodeMode records a call before its start hook runs; report every admitted call in order.
      result.toolCalls.forEach(({ name }, index) => {
        progress.calls[index] ??= { name, outcome: "interrupted" };
      });
      const timedOut = !result.ok && result.error.kind === "TimeoutExceeded";
      const unavailable = result.ok
        ? undefined
        : unavailableTarget(result.error, prepared.namespaces);
      if (unavailable !== undefined)
        yield* Effect.annotateCurrentSpan("executor.unavailable_app.called", true);
      const execution = executionDiagnostic({
        ...result,
        ...(unavailable === undefined
          ? {}
          : {
              error: {
                kind: "ToolFailure" as const,
                message: unavailable.reason.startsWith("{")
                  ? unavailable.reason
                  : `${unavailable.name} could not be loaded in this execution (${unavailable.reason}); its tools cannot be called until it loads.`,
              },
            }),
        ...(timedOut
          ? {
              error: {
                kind: "TimeoutExceeded" as const,
                message: timeoutMessage(limits.timeoutMs, "program"),
              },
            }
          : {}),
        toolCalls: reportedCalls(progress),
      });
      if (timedOut) yield* Effect.annotateCurrentSpan("executor.timeout.phase", "program");
      yield* Effect.annotateCurrentSpan("executor.outcome", execution.ok ? "completed" : "failed");
      return { execution, unavailableApps: prepared.unavailableApps };
    }).pipe(
      Effect.catch((error) => Effect.succeed(failure("ExecutionFailure", diagnostic(error)))),
    );
  });
}
