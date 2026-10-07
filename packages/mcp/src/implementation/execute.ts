/** Build a live catalog and execute code against configured apps. */
import { CodeMode, Namespace, Tool, toolError } from "@opencode-ai/codemode";
import { parse, tokTypes, type AnyNode, type CallExpression, type Token } from "acorn";
import {
  Json,
  AppSlug,
  JsonObject,
  routerFailure,
  AppEvaluationFailed,
  ToolApprovalRequired,
  ToolListingTimedOut,
  type App,
  type AppId,
  type Cursor,
  type DeploymentId,
  type Tool as AppTool,
  type ToolListOptions,
  type ToolSummary,
  type ToolRouter,
} from "@executor-js/sdk/core";
import { Clock, Deferred, Duration, Effect, Option, Schema, Semaphore } from "effect";
import { diagnostic, executionDiagnostic } from "./diagnostics.ts";
import type { McpTarget } from "../contracts/targets.ts";
import type { McpBackend } from "../contracts/backend.ts";
import {
  AppDiscoveryTimedOut,
  AppProfileRequired,
  defaultMcpRuntimeLimits,
  defaultSearchLimits,
  DescribeInput,
  DescribeResult,
  SearchInput,
  SearchResult,
  SearchItem,
  searchPageBytes,
  type McpLimits,
  type SearchNamespace,
  type McpToolCall,
  type UnavailableApp,
} from "../contracts/execute.ts";

type Catalog = Record<string, Record<string, Tool.Tool>>;

/** Keywords that only document a schema; they never change which values it accepts. */
const annotations = new Set([
  "description",
  "title",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
]);
/** Keywords that also judge `null`, so they cannot sit beside a `null` type unchanged. */
const nullConstraints = new Set([
  "$ref",
  "$defs",
  "definitions",
  "const",
  "enum",
  "not",
  "allOf",
  "anyOf",
  "oneOf",
  "if",
  "then",
  "else",
]);
const isNullSchema = (schema: Tool.JsonSchema) =>
  schema.type === "null" && Object.keys(schema).length === 1;

/**
 * Optional and nullable values arrive as `anyOf: [value, { type: "null" }]`. The signature
 * renderer documents only a property's own keywords, so the value's pattern, bounds, format and
 * description would be lost. `{ ...value, type: [value.type, "null"] }` accepts the same values,
 * because each remaining keyword of the value applies only to its own type, and it renders the
 * same TypeScript type with those constraints in its documentation.
 */
function documentedNullable(schema: Tool.JsonSchema): Tool.JsonSchema {
  const { anyOf, oneOf, ...rest } = schema;
  const members = anyOf === undefined ? oneOf : oneOf === undefined ? anyOf : undefined;
  if (members?.length !== 2 || !members.some(isNullSchema)) return schema;
  const value = members.find((member) => !isNullSchema(member));
  if (
    value === undefined ||
    typeof value.type !== "string" ||
    value.type === "null" ||
    Object.keys(value).some((key) => nullConstraints.has(key)) ||
    !Object.keys(rest).every((key) => annotations.has(key))
  )
    return schema;
  // The property's own documentation describes this use of the value, so it takes precedence.
  return { ...value, ...rest, type: [value.type, "null"] };
}

/**
 * Effect emits a property's documentation as `allOf: [{ description }]` when the property also
 * has constraints JSON Schema cannot express. A member holding only annotations accepts every
 * value, so moving its keywords onto the schema accepts the same values and puts the
 * documentation where the signature renderer reads it. Members whose keywords the schema
 * already has stay in `allOf`.
 */
function documentedAllOf(schema: Tool.JsonSchema): Tool.JsonSchema {
  const { allOf, ...rest } = schema;
  if (allOf === undefined) return schema;
  let merged: Tool.JsonSchema = rest;
  const kept: Array<Tool.JsonSchema> = [];
  for (const member of allOf) {
    const keys = Object.keys(member);
    if (keys.length > 0 && keys.every((key) => annotations.has(key) && !Object.hasOwn(merged, key)))
      merged = { ...merged, ...member };
    else kept.push(member);
  }
  return kept.length === 0 ? merged : { ...merged, allOf: kept };
}
const documented = (schema: Tool.JsonSchema) => documentedNullable(documentedAllOf(schema));

// Equivalent JSON Schema normalizations: the upstream signature renderer only renders index
// signatures when additionalProperties is a schema, rather than true, and documents only a
// property's own keywords.
function renderableSchema(input: Tool.JsonSchema): Tool.JsonSchema {
  return documented({
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
  });
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

/** A target's live tool names and descriptions; schemas are read only for selected tools. */
function indexTools<E extends Error>(backend: McpBackend<E>, app: AppId, target: McpTarget) {
  return Effect.gen(function* () {
    const selection =
      target.kind === "app" ? {} : { profile: target.id, expectedProfileRevision: target.revision };
    const index = yield* backend.indexTools({ app, ...selection });
    return {
      tools: index.items,
      routers: index.routers,
      deployment: index.deployment,
      selection,
    };
  });
}

/** Every page of a target's tools with schemas, or only the named tools. */
function listTools<E extends Error>(
  backend: McpBackend<E>,
  input: Parameters<McpBackend<E>["listTools"]>[0],
  options?: ToolListOptions,
) {
  return Effect.gen(function* () {
    const tools: AppTool[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = yield* backend.listTools({ ...input, cursor, limit: 2_000 }, options);
      tools.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
    return tools;
  });
}

/**
 * Projections of described tools, keyed by the described objects, so nothing here outlives the
 * description it was derived from.
 */
const renderedSchemas = new WeakMap<
  AppTool,
  { readonly input: Tool.JsonSchema; readonly output: Tool.JsonSchema | undefined }
>();
const renderSchemas = (tool: AppTool) =>
  Effect.gen(function* () {
    const known = renderedSchemas.get(tool);
    if (known !== undefined) return known;
    const input = yield* Schema.decodeUnknownEffect(JsonObject)(tool.inputSchema);
    const rendered = {
      input: renderableSchema(input),
      output: tool.outputSchema === undefined ? undefined : renderableSchema(tool.outputSchema),
    };
    renderedSchemas.set(tool, rendered);
    return rendered;
  });
type RenderedSchemas = Effect.Success<ReturnType<typeof renderSchemas>>;

/**
 * A loaded target: an app's own tools, or one of its profiles. Search results list each target
 * once instead of labelling every tool with it.
 */
type Target = {
  readonly slug: string;
  /** Canonical path below `tools`: the slug, or `slug.profiles.<id>`. */
  readonly path: string;
  readonly app: string;
  readonly profile?: string;
  readonly accounts?: string;
  /** The target's routers by router path. The root router has path "". */
  readonly routers: ReadonlyMap<string, ToolRouter>;
};
/** Where a target's schemas are read: its app, deployment and profile selection. */
type Source = {
  readonly input: Parameters<McpBackend<Error>["listTools"]>[0] & {
    readonly deployment: DeploymentId;
  };
  /** How many tools the target lists. */
  readonly size: number;
};
/** One callable tool of a loaded target, listed without schemas. */
type Entry = {
  /** Canonical path below `tools`. */
  readonly path: string;
  readonly tool: ToolSummary;
  readonly source: Source;
  /** The program's own tool at this path. */
  readonly program: Tool.Tool;
  readonly target: Target;
};
/** A selected tool's live description and its rendered schemas. */
type Described = { readonly tool: AppTool; readonly schemas: RenderedSchemas };
/** A search candidate: one tool, and the same tool under the app's other profiles. */
type Candidate = { readonly entry: Entry; readonly others: ReadonlyArray<Entry> };

/**
 * What makes two profiles' tools the same tool for search: name aside, everything listed without
 * schemas. Each path's own signature is read when it is described.
 */
const identities = new WeakMap<ToolSummary, string>();
const identity = (tool: ToolSummary) => {
  const known = identities.get(tool);
  if (known !== undefined) return known;
  const computed = JSON.stringify([
    tool.description,
    tool.title ?? null,
    tool.router ?? null,
    tool.readOnly ?? null,
  ]);
  identities.set(tool, computed);
  return computed;
};

/**
 * Merge each tool that several of an app's targets expose with the same signature into one
 * candidate at its first path. `entries` are in path order.
 */
const candidates = (entries: ReadonlyArray<Entry>): ReadonlyArray<Candidate> => {
  const named = new Map<string, Array<Entry>>();
  for (const entry of entries) {
    const key = `${entry.target.slug}\u0000${entry.tool.name}`;
    const known = named.get(key);
    if (known === undefined) named.set(key, [entry]);
    else known.push(entry);
  }
  const others = new Map<Entry, Array<Entry>>();
  const merged = new Set<Entry>();
  for (const group of named.values()) {
    if (group.length < 2) continue;
    const first = new Map<string, Entry>();
    for (const entry of group) {
      const kept = first.get(identity(entry.tool));
      if (kept === undefined) {
        first.set(identity(entry.tool), entry);
        continue;
      }
      merged.add(entry);
      const known = others.get(kept);
      if (known === undefined) others.set(kept, [entry]);
      else known.push(entry);
    }
  }
  return entries.flatMap((entry) =>
    merged.has(entry) ? [] : [{ entry, others: others.get(entry) ?? [] }],
  );
};

/** Text CodeMode's search matches for every tool below a namespace. */
const labels = (...parts: ReadonlyArray<string | undefined>) =>
  parts.filter((part): part is string => part !== undefined && part !== "").join(" ");

/** A stand-in that CodeMode ranks by its description, without rendering a signature. */
const rankingStubs = new WeakMap<ToolSummary, Tool.Tool>();
const rankingStub = (entry: Entry) => {
  const known = rankingStubs.get(entry.tool);
  if (known !== undefined) return known;
  const stub = Tool.make({
    description: entry.tool.description,
    input: { type: "object" },
    execute: () => Effect.void,
  });
  rankingStubs.set(entry.tool, stub);
  return stub;
};

/**
 * The tool tree CodeMode ranks: every candidate at its own path, with its other text as namespace
 * descriptions, which CodeMode's search matches for each tool below them: the app's name, the
 * profile's label and accounts, router titles, and on each tool's own node a merged tool's other
 * profiles. Schemas are not listed, so the stand-ins rank by paths, descriptions and labels.
 */
const rankingTree = (ranked: ReadonlyArray<Candidate>) => {
  const tree: Record<string, Tool.Tool | Namespace.Namespace> = Object.create(null);
  const apps = new Map<string, { names: Array<string>; namespaces: Map<string, Array<string>> }>();
  const seen = new Set<Target>();
  for (const { entry, others } of ranked) {
    const { target } = entry;
    const app = apps.get(target.slug) ?? { names: [target.app], namespaces: new Map() };
    apps.set(target.slug, app);
    // Namespaces are relative to the app's own namespace.
    const note = (path: string, text: string) => {
      if (text === "") return;
      const key = path.slice(target.slug.length + 1);
      app.namespaces.set(key, [...(app.namespaces.get(key) ?? []), text]);
    };
    if (!seen.has(target)) {
      seen.add(target);
      const root = target.routers.get("");
      const own = labels(target.profile, target.accounts, root?.title, root?.description);
      if (target.path === target.slug) app.names.push(own);
      else note(target.path, own);
      for (const [path, router] of target.routers)
        if (path !== "")
          note(`${target.path}.${toolPath(path)}`, labels(router.title, router.description));
    }
    note(
      entry.path,
      labels(...others.flatMap((other) => [other.target.profile, other.target.accounts])),
    );
    tree[entry.path] = rankingStub(entry);
  }
  // Each app's namespace and its tools' paths below it meet in one CodeMode node per segment.
  for (const [slug, app] of apps) {
    const name = labels(...app.names);
    tree[slug] = Namespace.make({
      ...(name === "" ? {} : { description: name }),
      tools: Object.fromEntries(
        [...app.namespaces].map(([path, texts]) => [
          path,
          Namespace.make({ description: labels(...texts), tools: {} }),
        ]),
      ),
    });
  }
  return tree;
};

const RankedPage = Schema.Struct({
  items: Schema.Array(Schema.Struct({ path: Schema.String })),
  remaining: Schema.Int,
});
type RankRequest = { readonly query: string; readonly offset: number; readonly limit: number };
/** CodeMode's search over one set of candidates, as the paths it ranks for a request. */
type Ranking = (
  request: RankRequest,
) => Effect.Effect<{ readonly paths: ReadonlyArray<string>; readonly remaining: number }>;
/**
 * Rank candidates with CodeMode's own `search()`, the same ranking a program's global `search()`
 * uses. The pinned CodeMode exports no ranking function, so a one-line program calls it. The
 * ranking holds only listing data, never an execution's own objects.
 */
const ranking = (ranked: ReadonlyArray<Candidate>): Ranking => {
  const runtime = ranked.length === 0 ? undefined : CodeMode.make({ tools: rankingTree(ranked) });
  return (request) =>
    Effect.gen(function* () {
      if (runtime === undefined) return { paths: [], remaining: 0 };
      const result = yield* runtime.execute(`return search(${JSON.stringify(request)});`);
      if (!result.ok) return yield* Effect.die(result.error.message);
      const page = yield* Schema.decodeUnknownEffect(RankedPage)(result.value).pipe(Effect.orDie);
      return { paths: page.items.map((item) => item.path), remaining: page.remaining };
    });
};
/** Everything a ranking depends on: each candidate's path and listed tool, and every label. */
const rankingBasis = (ranked: ReadonlyArray<Candidate>) => {
  const basis: Array<unknown> = [];
  const seen = new Set<Target>();
  for (const { entry, others } of ranked) {
    basis.push(entry.path, entry.tool, others.length);
    for (const other of others) basis.push(other.target.profile, other.target.accounts);
    if (seen.has(entry.target)) continue;
    seen.add(entry.target);
    basis.push(entry.target.app, entry.target.profile, entry.target.accounts);
    for (const router of entry.target.routers.values())
      basis.push(router.path, router.title, router.description);
  }
  return basis;
};
/**
 * Rankings reused across executions. A kept tool listing serves the same tool objects, so a
 * ranking is kept by its first candidate's tool, reused while its basis is unchanged, and goes
 * when the listing does. Each tool keeps the last few, for the namespaces searched below it.
 */
const keptRankings = new WeakMap<
  ToolSummary,
  ReadonlyArray<{ readonly basis: ReadonlyArray<unknown>; readonly ranking: Ranking }>
>();
const rankingFor = (ranked: ReadonlyArray<Candidate>) => {
  const anchor = ranked[0]?.entry.tool;
  if (anchor === undefined) return ranking(ranked);
  const basis = rankingBasis(ranked);
  const kept = keptRankings.get(anchor) ?? [];
  const same = kept.find(
    (item) =>
      item.basis.length === basis.length &&
      item.basis.every((value, index) => value === basis[index]),
  );
  if (same !== undefined) return same.ranking;
  const made = ranking(ranked);
  keptRankings.set(anchor, [{ basis, ranking: made }, ...kept].slice(0, 4));
  return made;
};
/** Ranks this execution's candidates and returns them in rank order. */
const ranker = (ranked: ReadonlyArray<Candidate>) => {
  const rank = rankingFor(ranked);
  const byPath = new Map(
    ranked.map((candidate) => [CodeMode.toolExpression(candidate.entry.path), candidate]),
  );
  return (request: RankRequest) =>
    rank(request).pipe(
      Effect.map(({ paths, remaining }) => ({
        items: paths.flatMap((path) => {
          const candidate = byPath.get(path);
          return candidate === undefined ? [] : [candidate];
        }),
        remaining,
      })),
    );
};
type Ranker = ReturnType<typeof ranker>;

/** CodeMode's signature for the schemas given, `(input: ...): Promise<...>`, without a path. */
const signatureOf = (
  input: Tool.JsonSchema,
  output: Tool.JsonSchema | typeof Schema.Json | undefined,
) => {
  const [described] = CodeMode.make({
    tools: {
      t: Tool.make({ description: "", input, output, execute: () => Effect.die("render only") }),
    },
  }).catalog();
  return described === undefined
    ? Effect.die("CodeMode described no signature for a one-tool catalog")
    : Effect.succeed(described.signature.slice("tools.t".length));
};

/**
 * CodeMode's multi-line type on one line without its documentation comments. Its renderer puts
 * each comment on lines of its own and ends every member with a comma; a comma before a closing
 * brace is dropped outside string literals.
 */
const singleLine = (pretty: string) => {
  const lines: Array<string> = [];
  let comment = false;
  for (const line of pretty.split("\n")) {
    const text = line.trim();
    if (comment) comment = text !== "*/";
    else if (text.startsWith("/**")) comment = !text.endsWith("*/");
    else lines.push(text);
  }
  const joined = lines.join(" ");
  let result = "";
  let quoted = false;
  for (let index = 0; index < joined.length; index++) {
    const character = joined.charAt(index);
    if (quoted) {
      if (character === "\\") {
        result += character + joined.charAt(index + 1);
        index++;
        continue;
      }
      quoted = character !== '"';
    } else if (character === '"') quoted = true;
    else if (character === "," && joined.startsWith(" }", index + 1)) continue;
    result += character;
  }
  return result;
};

/**
 * A tool's input type on one line, before any cut. CodeMode renders a tool without output as
 * `(input: <type>): Promise<void>`, or `(): Promise<void>` when its input is empty.
 */
const inputTypes = new WeakMap<AppTool, string>();
const inputType = (entry: Described) =>
  Effect.gen(function* () {
    const known = inputTypes.get(entry.tool);
    if (known !== undefined) return known;
    const rendered = yield* signatureOf(entry.schemas.input, undefined);
    const prefix = "(input: ";
    const suffix = "): Promise<void>";
    const computed =
      rendered === "(): Promise<void>"
        ? "{}"
        : rendered.startsWith(prefix) && rendered.endsWith(suffix)
          ? singleLine(rendered.slice(prefix.length, -suffix.length))
          : yield* Effect.die(`Unexpected CodeMode input signature: ${rendered.slice(0, 80)}`);
    inputTypes.set(entry.tool, computed);
    return computed;
  });
/** A tool's whole signature, `(input: ...): Promise<...>`, with its documentation. */
const signatures = new WeakMap<AppTool, string>();
const signature = (entry: Described) =>
  Effect.gen(function* () {
    const known = signatures.get(entry.tool);
    if (known !== undefined) return known;
    const computed = yield* signatureOf(entry.schemas.input, entry.schemas.output ?? Schema.Json);
    signatures.set(entry.tool, computed);
    return computed;
  });

const cut = (text: string, characters: number) =>
  text.length <= characters ? text : `${text.slice(0, characters - 1)}…`;
/** The first line of a tool's description, or its title when it has none. */
const summary = (tool: ToolSummary) =>
  cut(
    tool.description
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ??
      tool.title ??
      "",
    defaultSearchLimits.descriptionChars,
  );

/** A target's namespace, as results list it once. */
const targetNamespace = (target: Target): SearchNamespace => ({
  path: CodeMode.toolExpression(target.path),
  app: target.app,
  ...(target.profile === undefined ? {} : { profile: target.profile }),
  ...(target.accounts === undefined ? {} : { accounts: target.accounts }),
});
/** The namespaces an entry's path sits in: its target, and its router when that has a title. */
const namespacesOf = (entry: Entry): ReadonlyArray<SearchNamespace> => {
  const { target } = entry;
  const router =
    entry.tool.router === undefined ? undefined : target.routers.get(entry.tool.router);
  return [
    targetNamespace(target),
    ...(router?.title === undefined
      ? []
      : [
          {
            path: CodeMode.toolExpression(`${target.path}.${toolPath(router.path)}`),
            app: target.app,
            router: router.title,
          },
        ]),
  ];
};
const encoder = new TextEncoder();
const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;

/** One `.name` or `["name"]` member of a tool expression. */
const expressionMember =
  /^(?:\.([A-Za-z_$][\w$]*)|\[("(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")\])/;
/**
 * The canonical path of a name an agent passes: a tool expression such as
 * `tools.acme.profiles["ins_1"].issues` becomes `acme.profiles.ins_1.issues`, and `tools` alone
 * becomes "". Other names are already canonical paths.
 */
const canonical = (name: string) => {
  const trimmed = name.trim();
  if (trimmed !== "tools" && !trimmed.startsWith("tools.") && !trimmed.startsWith("tools["))
    return trimmed;
  const segments: Array<string> = [];
  for (let rest = trimmed.slice("tools".length); rest !== "";) {
    const member = expressionMember.exec(rest);
    if (member === null) return trimmed;
    const [matched, identifier, quoted] = member;
    segments.push(identifier ?? (quoted === undefined ? "" : String(JSON.parse(quoted))));
    rest = rest.slice(matched.length);
  }
  return segments.join(".");
};
/** Whether a canonical path lies in a canonical namespace. */
const within = (path: string, namespace: string) =>
  path === namespace || path.startsWith(`${namespace}.`);

/** Loads the apps named (or every app) and returns their tools in path order. */
type Searchable<E> = (
  names: ReadonlyArray<string> | "all",
) => Effect.Effect<ReadonlyArray<Entry>, E>;
/** Reads the live schemas of entries, in the order given. */
type Describe = (
  entries: ReadonlyArray<Entry>,
) => Effect.Effect<ReadonlyArray<Described>, ReturnType<typeof toolError>>;

/** A batch larger than this that names every tool of a target reads its whole catalog live instead. */
const bulkDescribe = 64;

/**
 * Read the selected entries' schemas live, batched by target. Every read authorizes the app, its
 * deployment and its profile again; an entry described earlier in this execution is not read again.
 */
const describeEntries = (
  backend: McpBackend<Error>,
  described: Map<Entry, Described>,
  entries: ReadonlyArray<Entry>,
) =>
  Effect.gen(function* () {
    const groups = new Map<Source, Array<Entry>>();
    for (const entry of new Set(entries)) {
      if (described.has(entry)) continue;
      const group = groups.get(entry.source);
      if (group === undefined) groups.set(entry.source, [entry]);
      else group.push(entry);
    }
    yield* Effect.forEach(
      groups,
      ([source, selected]) =>
        Effect.gen(function* () {
          const filtered = { ...source.input, tools: selected.map((entry) => entry.tool.name) };
          const tools = yield* (
            selected.length > bulkDescribe && selected.length === source.size
              ? listTools(backend, source.input, { live: true }).pipe(
                  Effect.catch((error) =>
                    Schema.is(AppEvaluationFailed)(error)
                      ? listTools(backend, filtered)
                      : Effect.fail(error),
                  ),
                )
              : listTools(backend, filtered)
          ).pipe(Effect.mapError((error) => toolError(diagnostic(error))));
          const byName = new Map(tools.map((tool) => [tool.name, tool]));
          for (const entry of selected) {
            const tool = byName.get(entry.tool.name);
            if (tool === undefined)
              return yield* Effect.fail(
                toolError(
                  `Tool metadata is no longer available for '${CodeMode.toolExpression(entry.path)}'`,
                ),
              );
            const schemas = yield* renderSchemas(tool).pipe(
              Effect.mapError(() => toolError("Tool metadata is invalid")),
            );
            described.set(entry, { tool, schemas });
          }
        }),
      { concurrency: defaultMcpRuntimeLimits.discoveryConcurrency, discard: true },
    );
    return yield* Effect.forEach(entries, (entry) => {
      const found = described.get(entry);
      return found === undefined
        ? Effect.fail(toolError("Tool metadata is unavailable"))
        : Effect.succeed(found);
    });
  }).pipe(Effect.withSpan("mcp.discovery.schemas"));

/**
 * One page of ranked tools. Items are added in rank order until the next would take the page past
 * its byte budget, so a page never exceeds the execute output limit; it always holds at least one
 * match. `remaining` and `next` count from the last item the page holds. A namespace's apps load
 * once per execution, so its ranker is kept in `rankers` for the execution's later searches.
 */
const searchPage = <E>(
  searchable: Searchable<E>,
  describe: Describe,
  rankers: Map<string, Ranker>,
  limits: McpLimits,
  input: typeof SearchInput.Type,
) =>
  Effect.gen(function* () {
    const namespace = input.namespace === undefined ? "" : canonical(input.namespace);
    const offset = input.offset ?? 0;
    const entries = yield* searchable(namespace === "" ? "all" : [namespace]);
    const rank =
      rankers.get(namespace) ??
      ranker(
        candidates(
          namespace === "" ? entries : entries.filter((entry) => within(entry.path, namespace)),
        ),
      );
    rankers.set(namespace, rank);
    const ranked = yield* rank({
      query: input.query ?? "",
      offset,
      limit: input.limit ?? defaultSearchLimits.defaultItems,
    });
    const budget = searchPageBytes(limits);
    let used = jsonBytes({ items: [], namespaces: [], remaining: 0, next: { ...input, offset } });
    const items: Array<typeof SearchItem.Type> = [];
    const namespaces = new Map<string, SearchNamespace>();
    // Only the ranked page's schemas are read.
    const details = yield* describe(ranked.items.map(({ entry }) => entry));
    for (const [index, { entry, others }] of ranked.items.entries()) {
      const detail = details[index];
      if (detail === undefined) return yield* Effect.die("Each ranked tool has a description");
      const type = yield* inputType(detail);
      const item = {
        path: CodeMode.toolExpression(entry.path),
        description: summary(entry.tool),
        input: cut(type, defaultSearchLimits.inputChars),
        ...(type.length > defaultSearchLimits.inputChars ? { inputTruncated: true as const } : {}),
        ...(others.length === 0
          ? {}
          : { alsoAt: others.map((other) => CodeMode.toolExpression(other.path)) }),
      };
      const added = new Map<string, SearchNamespace>();
      for (const space of [
        ...namespacesOf(entry),
        ...others.map((other) => targetNamespace(other.target)),
      ])
        if (!namespaces.has(space.path)) added.set(space.path, space);
      const cost =
        jsonBytes(item) +
        1 +
        [...added.values()].reduce((sum, space) => sum + jsonBytes(space) + 1, 0);
      if (items.length > 0 && used + cost > budget) break;
      used += cost;
      items.push(item);
      for (const [path, space] of added) namespaces.set(path, space);
    }
    const remaining = ranked.remaining + ranked.items.length - items.length;
    return {
      items,
      namespaces: [...namespaces.values()],
      remaining,
      next: remaining > 0 ? { ...input, offset: offset + items.length } : null,
    };
  });

/**
 * Full detail for exact tool paths. A path that names no tool is reported with the closest paths
 * in its app, ranked as search ranks them.
 */
const describeTools = <E>(
  searchable: Searchable<E>,
  describe: Describe,
  paths: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const named = paths.map(canonical);
    const entries = yield* searchable(named.filter((path) => path !== ""));
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    const found = named.flatMap((name) => {
      const entry = byPath.get(name);
      return entry === undefined ? [] : [entry];
    });
    const details = new Map(
      (yield* describe(found)).map((detail, index) => [found[index], detail] as const),
    );
    const items: Array<(typeof DescribeResult.Type.items)[number]> = [];
    const namespaces = new Map<string, SearchNamespace>();
    const missing: Array<(typeof DescribeResult.Type.missing)[number]> = [];
    for (const [index, path] of paths.entries()) {
      const name = named[index] ?? "";
      const entry = byPath.get(name);
      if (entry === undefined) {
        const closest = yield* ranker(
          entries
            .filter((candidate) => within(name, candidate.target.slug))
            .map((candidate) => ({ entry: candidate, others: [] })),
        )({ query: name, offset: 0, limit: 3 });
        missing.push({
          path,
          matches: closest.items.map((candidate) => CodeMode.toolExpression(candidate.entry.path)),
        });
        continue;
      }
      const detail = details.get(entry);
      if (detail === undefined) return yield* Effect.die("Each found tool has a description");
      items.push({
        path: CodeMode.toolExpression(entry.path),
        description: detail.tool.description,
        signature: yield* signature(detail),
      });
      for (const space of namespacesOf(entry)) namespaces.set(space.path, space);
    }
    return { items, namespaces: [...namespaces.values()], missing };
  });

const isNode = (value: unknown): value is AnyNode =>
  typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";

/** The node naming `search` in `search(...)`, `tools.search(...)` or `tools["search"](...)`. */
const searchCallee = (call: CallExpression) => {
  const callee = call.callee;
  if (callee.type === "Identifier") return callee.name === "search" ? callee : undefined;
  if (
    callee.type !== "MemberExpression" ||
    callee.object.type !== "Identifier" ||
    callee.object.name !== "tools"
  )
    return undefined;
  const property = callee.property;
  if (!callee.computed && property.type === "Identifier" && property.name === "search")
    return property;
  if (callee.computed && property.type === "Literal" && property.value === "search")
    return property;
  return undefined;
};

/**
 * The app a search names with one literal `namespace` in its only argument, such as
 * `{ namespace: "acme.issues", query }`. Computed, spread or repeated namespaces name none, and
 * neither does a namespace written as a tool expression.
 */
const searchedApp = (call: CallExpression) => {
  const [input, ...rest] = call.arguments;
  if (input?.type !== "ObjectExpression" || rest.length > 0) return undefined;
  const namespaces = [];
  for (const property of input.properties) {
    if (property.type !== "Property" || property.computed) return undefined;
    const key =
      property.key.type === "Identifier"
        ? property.key.name
        : property.key.type === "Literal"
          ? property.key.value
          : undefined;
    if (key === "namespace") namespaces.push(property);
  }
  const [namespace, ...duplicates] = namespaces;
  if (
    namespace === undefined ||
    duplicates.length > 0 ||
    namespace.kind !== "init" ||
    namespace.value.type !== "Literal" ||
    typeof namespace.value.value !== "string"
  )
    return undefined;
  const [app] = namespace.value.value.split(/[.[]/);
  return app === "tools" || app === "" ? undefined : app;
};

/** The app each scoped search names, by the source position of the `search` naming it. */
const scopedSearches = (node: unknown, scopes: Map<number, string>): void => {
  if (Array.isArray(node)) {
    for (const child of node) scopedSearches(child, scopes);
    return;
  }
  if (!isNode(node)) return;
  if (node.type === "CallExpression") {
    const callee = searchCallee(node);
    const app = callee === undefined ? undefined : searchedApp(node);
    if (callee !== undefined && app !== undefined) scopes.set(callee.start, app);
  }
  for (const child of Object.values(node)) scopedSearches(child, scopes);
};

/**
 * The apps a program can reach. Every tool path starts at the `tools` global, so a program whose
 * uses of `tools` are all static members, such as `tools.github`, `tools["my-app"]` or
 * `tools["my-app.queries.version"]`, reaches only those apps. A search, through `tools.search` or
 * CodeMode's global `search()`, reaches only the app its literal `namespace` names. Any other use
 * of `tools` or `search` (`tools[name]`, `Object.keys(tools)`, an unscoped, computed or spread
 * search) reaches every app, and so does source that does not parse; CodeMode then reports its
 * parse error.
 */
export const programReach = (code: string) =>
  Effect.sync((): ReadonlySet<string> | "all" => {
    // Acorn's declarations omit the token value it sets: cooked identifier and string text.
    const tokens: Array<{
      readonly type: Token["type"];
      readonly start: number;
      readonly value?: string;
    }> = [];
    const scopes = new Map<number, string>();
    try {
      scopedSearches(
        parse(code, {
          ecmaVersion: "latest",
          sourceType: "module",
          allowReturnOutsideFunction: true,
          allowAwaitOutsideFunction: true,
          onToken: (token: Token & { readonly value?: unknown }) =>
            tokens.push({
              type: token.type,
              start: token.start,
              ...(typeof token.value === "string" ? { value: token.value } : {}),
            }),
        }),
        scopes,
      );
    } catch {
      return "all";
    }
    const at = (index: number) => tokens[index] ?? { type: tokTypes.eof, start: -1 };
    const member = (index: number) =>
      at(index).type === tokTypes.dot || at(index).type === tokTypes.questionDot;
    const apps = new Set<string>();
    for (const [index, token] of tokens.entries()) {
      if (token.type !== tokTypes.name) continue;
      if (token.value === "search") {
        // Another object's own `search` member is not the program's search.
        if (member(index - 1) && at(index - 2).value !== "tools") continue;
        // tools.search.describe loads only the apps its exact paths name, when it runs.
        if (member(index - 1) && member(index + 1) && at(index + 2).value === "describe") continue;
        const app = scopes.get(token.start);
        if (app === undefined) return "all";
        apps.add(app);
        continue;
      }
      if (token.value !== "tools" || member(index - 1)) continue;
      // tools.slug and tools?.slug; property names may be keywords. tools.search is the search.
      const name = at(index + 2);
      if (
        member(index + 1) &&
        name.value !== undefined &&
        (name.type === tokTypes.name || name.type.keyword !== undefined)
      ) {
        if (name.value !== "search") apps.add(name.value);
        continue;
      }
      // tools["slug"], tools["slug.queries.version"] and tools?.["slug"]
      const open = at(index + 1).type === tokTypes.questionDot ? index + 2 : index + 1;
      const key = at(open + 1);
      if (
        at(open).type === tokTypes.bracketL &&
        key.type === tokTypes.string &&
        key.value !== undefined &&
        at(open + 2).type === tokTypes.bracketR
      ) {
        if (key.value === "search.describe") continue;
        const app = key.value === "search" ? scopes.get(key.start) : key.value.split(".")[0];
        if (app === undefined || app === "" || app === "search") return "all";
        apps.add(app);
        continue;
      }
      return "all";
    }
    return apps;
  });

type ListedApp = Pick<App, "id" | "name" | "slug">;

/**
 * Discover apps on demand within one execution. Listing apps is cheap; listing an app's targets
 * and tools can mean evaluating thousands of definitions or reaching an upstream server, so each
 * app is discovered at most once and only when the program or its search needs it. The backend
 * may serve a tool listing it kept from an earlier execution; its rendered schemas and search
 * projections are then reused too. Everything else is per execution.
 */
function catalog(backend: McpBackend<Error>, progress: ExecutionProgress) {
  return Effect.gen(function* () {
    const {
      discoveryConcurrency: concurrency,
      discoveryWaitMs,
      discoveryIdleMs,
    } = defaultMcpRuntimeLimits;
    const slots = yield* Semaphore.make(concurrency);
    // Listings share one app runtime, so how long one takes depends on the others. Discovery
    // gives up on an app only when no listing has completed for a while, not on a per-app clock.
    let progressed = yield* Clock.currentTimeMillis;
    const settled = Clock.currentTimeMillis.pipe(
      Effect.map((now) => {
        progressed = now;
      }),
    );
    /** Listings each app is running, when it started its first, and when it was given up on. */
    const running = new Map<AppId, number>();
    const started = new Map<AppId, number>();
    const stopped = new Map<AppId, number>();
    const stops = new Map<AppId, Deferred.Deferred<number>>();
    const stopOf = (app: AppId) => {
      const known = stops.get(app);
      if (known !== undefined) return known;
      const created = Deferred.makeUnsafe<number>();
      stops.set(app, created);
      return created;
    };
    /** Give up on an app: its running listings stop and its queued ones fail without running. */
    const stop = (app: AppId) =>
      Effect.gen(function* () {
        if (stopped.has(app)) return;
        const now = yield* Clock.currentTimeMillis;
        stopped.set(app, now);
        yield* Deferred.succeed(stopOf(app), now);
      });
    const timedOut = (app: AppId, at: number) =>
      new AppDiscoveryTimedOut({ app, elapsedMs: at - (started.get(app) ?? at) });
    // A listing holds a permit while it runs and stops with the rest of its app. Once an app is
    // given up on, its queued listings fail without running.
    const discover = <A, E, R>(name: string, app: AppId, work: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const queued = yield* Clock.currentTimeMillis;
        return yield* slots.withPermits(1)(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            yield* Effect.annotateCurrentSpan("executor.discovery.wait_ms", now - queued);
            const at = stopped.get(app);
            if (at !== undefined) return yield* Effect.fail(timedOut(app, at));
            if (!started.has(app)) started.set(app, now);
            running.set(app, (running.get(app) ?? 0) + 1);
            return yield* work.pipe(
              Effect.tap(() => settled),
              Effect.raceFirst(
                Deferred.await(stopOf(app)).pipe(
                  Effect.flatMap((at) => Effect.fail(timedOut(app, at))),
                ),
              ),
              Effect.ensuring(Effect.sync(() => running.set(app, (running.get(app) ?? 1) - 1))),
            );
          }),
        );
      }).pipe(Effect.withSpan(name));
    const apps = yield* backend.listApps().pipe(Effect.withSpan("mcp.discovery.apps"));
    yield* Effect.annotateCurrentSpan({
      "executor.discovery.apps": apps.length,
      "executor.discovery.concurrency": concurrency,
    });
    const counts = new Map<string, number>();
    for (const app of apps) counts.set(app.slug, (counts.get(app.slug) ?? 0) + 1);
    const unique = (app: ListedApp) => Schema.is(AppSlug)(app.slug) && counts.get(app.slug) === 1;
    const tools: Catalog = Object.create(null);
    const failures = new Map<AppId, Array<typeof UnavailableApp.Type>>();
    // Tool path prefixes that expose no tools in this execution, and those that do. A call is
    // attributed to the longest matching prefix, so a typo inside a loaded namespace stays unknown.
    const namespaces: Namespaces = new Map();
    const unavailableApps = () => apps.flatMap((app) => failures.get(app.id) ?? []);
    /** Each loaded app's callable tools, for search. */
    const listed = new Map<string, ReadonlyArray<Entry>>();

    const discoverApp = (app: ListedApp) =>
      Effect.gen(function* () {
        if (!unique(app))
          return {
            targets: [],
            error: !Schema.is(AppSlug)(app.slug) ? "AppSlugInvalid" : "AppSlugAmbiguous",
          };
        return yield* discover(
          "mcp.discovery.targets",
          app.id,
          backend.listTargets({ app: app.id }),
        ).pipe(
          Effect.flatMap((targets) =>
            Effect.forEach(
              targets,
              (target) =>
                discover("mcp.discovery.tools", app.id, indexTools(backend, app.id, target)).pipe(
                  Effect.map((catalog) => ({ target, catalog, error: undefined })),
                  Effect.catch((error) =>
                    Effect.gen(function* () {
                      // This app's listing has run for longer than discovery waits, or recently
                      // timed out. Give up on the app now, as discovery would after waiting,
                      // rather than wait for its other listings again.
                      if (Schema.is(ToolListingTimedOut)(error)) yield* stop(app.id);
                      return { target, catalog: undefined, error: diagnostic(error) };
                    }),
                  ),
                ),
              { concurrency: "unbounded" },
            ),
          ),
          Effect.map((targets) => ({ targets, error: undefined })),
          Effect.catch((error) => Effect.succeed({ targets: [], error: diagnostic(error) })),
        );
      });

    const project = (
      app: ListedApp,
      { targets, error }: Effect.Success<ReturnType<typeof discoverApp>>,
    ) =>
      Effect.gen(function* () {
        const failed: Array<typeof UnavailableApp.Type> = [];
        failures.set(app.id, failed);
        if (error !== undefined) {
          const entry = { app: app.id, name: app.name, reason: error };
          failed.push(entry);
          if (unique(app)) namespaces.set(app.slug, entry);
          return;
        }
        // An app that needs accounts exposes no target when the caller has no enabled profile.
        // Report that only when the program calls into it: most members never set up most of
        // their organization's account apps.
        if (targets.length === 0) {
          namespaces.set(app.slug, {
            app: app.id,
            name: app.name,
            reason: diagnostic(new AppProfileRequired({ app: app.id })),
          });
          tools[app.slug] = {};
          return;
        }
        const entries: Array<readonly [string, Tool.Tool]> = [];
        const found: Array<Entry> = [];
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
            failed.push(entry);
            namespaces.set(namespace, entry);
            continue;
          }
          namespaces.set(namespace, "available");
          // A router that could not list its tools is reported like an app, at its own namespace,
          // so a call into it explains why instead of reporting an unknown tool.
          const groups = new Map(catalog.routers.map((router) => [router.path, router]));
          for (const router of catalog.routers) {
            if (router.error === undefined) continue;
            const entry = {
              app: app.id,
              name: `${app.name} ${router.title ?? router.path}`,
              ...(target.kind === "profile" ? { profile: target.id } : {}),
              router: router.path,
              reason: diagnostic(
                routerFailure({ app: app.id, deployment: catalog.deployment }, router.error),
              ),
            };
            failed.push(entry);
            namespaces.set(`${namespace}.${toolPath(router.path)}`, entry);
          }
          const described: Target = {
            slug: app.slug,
            path: namespace,
            app: app.name,
            ...(target.kind === "app"
              ? {}
              : {
                  profile: target.label,
                  ...(target.accounts === undefined ? {} : { accounts: target.accounts }),
                }),
            routers: groups,
          };
          const source: Source = {
            input: { app: app.id, deployment: catalog.deployment, ...catalog.selection },
            size: catalog.tools.length,
          };
          const projected = catalog.tools.map((tool) => {
            const name =
              target.kind === "app"
                ? toolPath(tool.name)
                : `profiles.${toolPath(target.id)}.${toolPath(tool.name)}`;
            // Schemas are read only when search or describe selects the tool; the app
            // validates every call's input against its live schema.
            const program = Tool.make({
              description: tool.description,
              input: {},
              output: Schema.Json,
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
                        kind: tool.readOnly === true ? "query" : "mutation",
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
                        Effect.mapError((error) =>
                          toolError(diagnostic(error, `${app.slug}.${name}`)),
                        ),
                      ),
                  ),
                ),
            });
            found.push({
              path: `${app.slug}.${name}`,
              tool,
              source,
              program,
              target: described,
            });
            return [name, program] as const;
          });
          entries.push(...projected);
        }
        // An app none of whose targets loaded is unavailable as a whole.
        const whole = failed[0];
        if (entries.length === 0 && whole !== undefined && !namespaces.has(app.slug))
          namespaces.set(app.slug, whole);
        tools[app.slug] = Object.fromEntries(entries);
        listed.set(app.slug, found);
      });

    // Each app is discovered at most once, by whichever of the program or a search needs it first.
    const discovered = yield* Effect.forEach(apps, (app) =>
      Effect.cached(
        discoverApp(app).pipe(
          Effect.flatMap((result) => project(app, result)),
          Effect.andThen(
            Effect.sync(() => {
              progress.unavailableApps = unavailableApps();
            }),
          ),
        ),
      ).pipe(Effect.map((load) => ({ app, load }))),
    );
    /**
     * Wait for the selected apps. After `discoveryWaitMs`, once no listing has completed for
     * `discoveryIdleMs`, give up on every selected app still running a listing, however many
     * there are. Apps still queued then start, with a new idle period.
     */
    const load = (selected: ReadonlyArray<(typeof discovered)[number]>) =>
      Effect.gen(function* () {
        const began = yield* Clock.currentTimeMillis;
        let restarted = began;
        const watch: Effect.Effect<never> = Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const due = Math.max(
            began + discoveryWaitMs,
            Math.max(progressed, restarted) + discoveryIdleMs,
          );
          if (now < due) {
            yield* Effect.sleep(Duration.millis(due - now));
            return yield* watch;
          }
          const stalled = selected.filter(({ app }) => (running.get(app.id) ?? 0) > 0);
          yield* Effect.annotateCurrentSpan("executor.discovery.stopped", stalled.length);
          for (const { app } of stalled) yield* stop(app.id);
          restarted = now;
          return yield* watch;
        });
        yield* Effect.raceFirst(
          Effect.forEach(selected, ({ load }) => load, { concurrency: "unbounded", discard: true }),
          watch,
        );
      });

    /**
     * The tools of every app the canonical names lie in, once those apps are loaded. A name is an
     * app slug, a target or router below it, or a tool path. Entries are in path order.
     */
    const searchable = (names: ReadonlyArray<string> | "all") =>
      Effect.gen(function* () {
        const selected =
          names === "all"
            ? discovered
            : discovered.filter(({ app }) => names.some((name) => within(name, app.slug)));
        yield* load(selected).pipe(Effect.withSpan("mcp.search.discovery"));
        return selected
          .flatMap(({ app }) => (unique(app) ? (listed.get(app.slug) ?? []) : []))
          .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
      });
    const reachable = (reach: ReadonlySet<string> | "all") =>
      reach === "all" ? discovered : discovered.filter(({ app }) => reach.has(app.slug));
    const schemas = new Map<Entry, Described>();
    const describe: Describe = (entries) => describeEntries(backend, schemas, entries);
    return { tools, namespaces, load, reachable, searchable, describe, unavailableApps };
  });
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
    if (found !== undefined) return { ...found, operation: path };
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

/** What a timed-out execution knows about one call it admitted. */
const timedOutCall = (call: McpToolCall) =>
  `${call.name}: ${
    call.outcome === "success"
      ? "completed"
      : call.outcome === "failure"
        ? "failed; external effects may have occurred"
        : call.outcome === "awaiting-approval"
          ? "not started; awaiting approval"
          : "outcome unknown"
  }`;

/**
 * The phase a timed-out execution was in, so callers can tell slow discovery from a slow program,
 * and each admitted call's confirmed completion, failure or unknown outcome.
 */
export const timeoutMessage = (
  timeoutMs: number,
  phase: "discovery" | "program",
  calls: ReadonlyArray<McpToolCall> = [],
) =>
  phase === "discovery"
    ? `Execution timed out after ${timeoutMs}ms while loading app tools. No program code ran and no action was attempted. Recovery: Use tools.search with the requested app's namespace, then try again.`
    : `Execution timed out after ${timeoutMs}ms. ${calls.length === 0 ? "No tool call was recorded." : `${calls.map(timedOutCall).join("; ")}.`} Recovery: Check current state with a safe read before repeating any mutation. A timeout does not establish that a mutation failed or that retrying is safe.`;

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
      // Discovery covers the apps the program can reach; search discovers others when it runs.
      const reach = yield* programReach(code);
      const loaded = yield* Effect.gen(function* () {
        const discovered = yield* catalog(tools, progress);
        const reachable = discovered.reachable(reach);
        yield* Effect.annotateCurrentSpan("executor.discovery.reachable", reachable.length);
        yield* discovered.load(reachable);
        yield* Effect.annotateCurrentSpan({
          "executor.discovery.tools": Object.values(discovered.tools).reduce(
            (sum, entries) => sum + Object.keys(entries).length,
            0,
          ),
          "executor.discovery.unavailable": progress.unavailableApps.length,
        });
        return discovered;
      }).pipe(
        Effect.withSpan("mcp.catalog"),
        Effect.map(Option.some),
        Effect.raceFirst(deadline.pipe(Effect.as(Option.none()))),
      );
      if (Option.isNone(loaded)) {
        yield* Effect.annotateCurrentSpan("executor.timeout.phase", "discovery");
        return failure("TimeoutExceeded", timeoutMessage(limits.timeoutMs, "discovery"));
      }
      const prepared = loaded.value;
      progress.phase = "program";
      // Discovery for a search runs on the real clock, like tool calls.
      const rankers = new Map<string, Ranker>();
      const search = Tool.make({
        description:
          "Find app tools by words in their paths, descriptions and labels. Returns exact callable paths, one-line descriptions and input types, with each app and profile listed once. Use tools.search.describe for output types and whole descriptions.",
        input: SearchInput,
        output: SearchResult,
        execute: (input) =>
          searchPage(prepared.searchable, prepared.describe, rankers, limits, input).pipe(
            Effect.provideService(Clock.Clock, clock),
          ),
      });
      const describe = Tool.make({
        description:
          "Read the whole description and TypeScript signature, with input and output types, of tools at exact paths from tools.search.",
        input: DescribeInput,
        output: DescribeResult,
        execute: ({ paths }) =>
          describeTools(prepared.searchable, prepared.describe, paths).pipe(
            Effect.provideService(Clock.Clock, clock),
          ),
      });
      const runtime = CodeMode.make({
        tools: { ...prepared.tools, search, "search.describe": describe },
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
            // A call interrupted while it waited for approval never ran, and a tool's semantic
            // failure stays a failure when the program receives its result.
            if (
              !(outcome === "interrupted" && call.outcome === "awaiting-approval") &&
              !(outcome === "success" && call.outcome === "failure")
            )
              call.outcome = outcome;
            call.durationMs = durationMs;
          }),
      });
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
      const execution = executionDiagnostic(
        {
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
                  message: timeoutMessage(limits.timeoutMs, "program", reportedCalls(progress)),
                },
              }
            : {}),
          toolCalls: reportedCalls(progress),
        },
        unavailable?.operation,
      );
      if (timedOut) yield* Effect.annotateCurrentSpan("executor.timeout.phase", "program");
      yield* Effect.annotateCurrentSpan("executor.outcome", execution.ok ? "completed" : "failed");
      return { execution, unavailableApps: prepared.unavailableApps() };
    }).pipe(
      Effect.catch((error) => Effect.succeed(failure("ExecutionFailure", diagnostic(error)))),
    );
  });
}
