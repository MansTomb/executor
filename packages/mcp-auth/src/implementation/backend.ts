/** Apply one grant at every shared MCP operation; hosts retain their existing resource checks. */
import type { McpBackend } from "@executor-js/mcp";
import {
  ElicitationFailed,
  type AppId,
  type DeploymentId,
  type ProfileId,
  type ToolKind,
  type ToolName,
} from "@executor-js/sdk/core";
import { Effect } from "effect";
import {
  permitsApp,
  permitsTarget,
  permitsRouter,
  permitsTool,
  permittedAppIds,
  requiresToolMetadata,
  type AuthorizationPolicy,
} from "@executor-js/authorization";
import {
  GrantForbidden,
  grantAuthorization,
  type Grant,
  type GrantRefusal,
} from "../contracts/grant.ts";

/** The exact tool an operation would run, before its live read-only flag is known. */
interface Invocation {
  readonly app: AppId;
  readonly tool: ToolName;
  readonly profile?: ProfileId | undefined;
  readonly expectedProfileRevision?: number | undefined;
  readonly deployment?: DeploymentId | undefined;
  /** The kind the caller runs it as; omitted, the call reads it from the catalog. */
  readonly kind?: ToolKind | undefined;
}

/** Re-read authority per operation, including while an execution resumes within one HTTP call. */
export const restrictMcpBackend = <E extends Error, G extends Error>(
  backend: McpBackend<E>,
  current: Effect.Effect<Grant, G>,
): McpBackend<E | G | GrantForbidden> => {
  const authority = current.pipe(Effect.map((grant) => grantAuthorization(grant.policy)));
  const refuse = (refusal: GrantRefusal | undefined) =>
    refusal === undefined ? Effect.void : Effect.fail(new GrantForbidden({ refusal }));
  /** The app, then how it runs: the first one the grant excludes, if either is. */
  const appRefusal = (
    policy: AuthorizationPolicy,
    app: AppId,
    profile: ProfileId | undefined,
  ): GrantRefusal | undefined =>
    !permitsApp(policy, app)
      ? { reason: "app", app }
      : !permitsTarget(policy, app, profile)
        ? { reason: "target", app, ...(profile === undefined ? {} : { profile }) }
        : undefined;
  const checkApp = (app: AppId, profile: ProfileId | undefined) =>
    authority.pipe(Effect.flatMap((policy) => refuse(appRefusal(policy, app, profile))));
  /** Describe one tool live, as the catalog this invocation would use lists it now. */
  const describe = (input: Invocation) =>
    backend
      .listTools({
        app: input.app,
        profile: input.profile,
        expectedProfileRevision: input.expectedProfileRevision,
        deployment: input.deployment,
        tools: [input.tool],
      })
      .pipe(
        Effect.map((page) => ({
          tool: page.items.find((item) => item.name === input.tool),
          deployment: page.deployment,
        })),
      );
  /**
   * Check the invocation against the grant and return what the call must run with. Exact names
   * and all-tools decide from the name; a read-only rule reads the tool's live metadata, and the
   * call then runs on that deployment as a query, so a tool that has become a mutation is
   * refused before it runs.
   */
  const authorize = (policy: AuthorizationPolicy, input: Invocation) =>
    Effect.gen(function* () {
      const request = { app: input.app, profile: input.profile, tool: { name: input.tool } };
      // A refused tool names its app or runs-as target instead when the grant excludes those.
      const toolRefusal = (allowed: boolean): GrantRefusal | undefined => {
        if (allowed) return undefined;
        const excluded = appRefusal(policy, input.app, input.profile);
        return excluded === undefined
          ? { reason: "tool", app: input.app, tool: input.tool }
          : excluded;
      };
      if (!requiresToolMetadata(policy.tools, input.app)) {
        yield* refuse(toolRefusal(permitsTool(policy, request)));
        return { deployment: input.deployment, kind: input.kind };
      }
      // An unknown tool or a missing flag is never read-only.
      const { tool, deployment } = yield* describe(input);
      const allowed = tool !== undefined && permitsTool(policy, { ...request, tool });
      const onlyAsQuery =
        allowed && !permitsTool(policy, { ...request, tool: { ...tool, readOnly: false } });
      yield* refuse(toolRefusal(allowed && !(onlyAsQuery && input.kind === "mutation")));
      return { deployment, kind: onlyAsQuery ? ("query" as const) : input.kind };
    });
  const check = (input: Invocation) =>
    Effect.flatMap(authority, (policy) => authorize(policy, input));
  return {
    listSkills: (input) =>
      checkApp(input.app, input.profile).pipe(Effect.andThen(() => backend.listSkills(input))),
    readSkill: (input) =>
      checkApp(input.app, input.profile).pipe(Effect.andThen(() => backend.readSkill(input))),
    listApps: (input) =>
      Effect.gen(function* () {
        const grant = yield* authority;
        const ids = permittedAppIds(grant, input?.ids);
        return yield* backend.listApps({ ids });
      }),
    listTargets: (input) =>
      Effect.gen(function* () {
        const policy = yield* authority;
        yield* refuse(
          permitsApp(policy, input.app) ? undefined : { reason: "app", app: input.app },
        );
        const targets = yield* backend.listTargets(input);
        return targets.filter((target) =>
          permitsTarget(policy, input.app, target.kind === "app" ? undefined : target.id),
        );
      }),
    indexTools: (input) =>
      Effect.gen(function* () {
        yield* checkApp(input.app, input.profile);
        const index = yield* backend.indexTools(input);
        const policy = yield* authority;
        return {
          ...index,
          items: index.items.filter((tool) =>
            permitsTool(policy, { app: input.app, profile: input.profile, tool }, "discover"),
          ),
          routers: index.routers.filter((router) =>
            permitsRouter(
              policy,
              { app: input.app, profile: input.profile, path: router.path },
              index.items,
            ),
          ),
        };
      }),
    listTools: (input, options) =>
      Effect.gen(function* () {
        yield* checkApp(input.app, input.profile);
        const page = yield* backend.listTools(input, options);
        const policy = yield* authority;
        return {
          ...page,
          items: page.items.filter((tool) =>
            permitsTool(policy, { app: input.app, profile: input.profile, tool }, "discover"),
          ),
          routers: page.routers.filter((router) =>
            permitsRouter(
              policy,
              { app: input.app, profile: input.profile, path: router.path },
              page.items,
            ),
          ),
        };
      }),
    callTool: (input, options) =>
      Effect.gen(function* () {
        const { deployment, kind } = yield* check(input);
        return yield* backend.callTool(
          {
            ...input,
            ...(deployment === undefined ? {} : { deployment }),
            ...(kind === undefined ? {} : { kind }),
          },
          options,
        );
      }),
    resumeInvocation: (request, response, options) =>
      check({
        app: request.invocation.app,
        tool: request.invocation.tool,
        profile: request.invocation.profile,
        expectedProfileRevision: request.invocation.profileRevision,
        deployment: request.invocation.deployment,
        // An approval saved without a kind reads it again when it resumes, so it cannot be bound.
        kind: request.invocation.kind ?? "mutation",
      }).pipe(Effect.andThen(() => backend.resumeInvocation(request, response, options))),
    authorizeElicitation: (input) =>
      check(input).pipe(
        Effect.mapError(() => new ElicitationFailed({ reason: "forbidden" })),
        Effect.andThen(() => backend.authorizeElicitation(input)),
      ),
  };
};
