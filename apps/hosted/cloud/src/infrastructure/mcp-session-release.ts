/**
 * Release order for moving MCP session objects from the API Worker's `McpSessions` class to the
 * MCP server Worker's `McpSession`: add the MCP server Worker, forward to it, then delete the old
 * class. Deploys of a stage run one at a time, but a newer push replaces a pending one, so two of
 * these releases can arrive in one deploy, or one can follow a deploy that failed. The gate reads
 * the stage's live Workers before Alchemy plans anything and stops the deploy, with nothing
 * changed, when the step before is not live. A new stage, or one past the step, passes unchecked.
 */
import {
  listScriptDeployments,
  getScriptVersion,
  listScripts,
} from "@distilled.cloud/cloudflare/workers";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stage } from "alchemy/Stage";
import { Effect, Schema, Stream } from "effect";

export class McpSessionReleaseBlocked extends Schema.TaggedError<McpSessionReleaseBlocked>()(
  "McpSessionReleaseBlocked",
  { message: Schema.String },
) {}

const Bindings = Schema.Array(
  Schema.Struct({
    type: Schema.String,
    name: Schema.String,
    className: Schema.optional(Schema.String),
    scriptName: Schema.optional(Schema.String),
  }),
);
type Bindings = typeof Bindings.Type;

/** This stage's Workers by Alchemy logical id, from the ownership tags Alchemy writes. */
const stageWorkers = Effect.gen(function* () {
  const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
  const stage = yield* Stage;
  const owned = ["alchemy:stack:executor-next-hosted", `alchemy:stage:${stage}`];
  const scripts = yield* listScripts.items({ accountId }).pipe(Stream.runCollect);
  const workers = new Map<string, string>();
  for (const script of scripts) {
    const tags = script.tags ?? [];
    const id = tags.find((tag) => tag.startsWith("alchemy:id:"));
    if (script.id && id && owned.every((tag) => tags.includes(tag)))
      workers.set(id.slice("alchemy:id:".length), script.id);
  }
  return { accountId, workers };
});

/** The bindings of every version serving the script's active deployment. */
const liveVersions = (accountId: string, scriptName: string) =>
  Effect.gen(function* () {
    const { deployments } = yield* listScriptDeployments({ accountId, scriptName });
    // Cloudflare lists the deployment serving traffic first.
    const [active] = deployments;
    if (active === undefined) return [];
    return yield* Effect.forEach(active.versions, ({ versionId }) =>
      getScriptVersion({ accountId, scriptName, versionId }).pipe(
        Effect.flatMap((version) =>
          Schema.decodeUnknownEffect(Bindings)(version.resources.bindings),
        ),
      ),
    );
  });

const hostsSessions = (bindings: Bindings) =>
  bindings.some(
    (binding) =>
      binding.type === "durable_object_namespace" &&
      binding.className === "McpSession" &&
      binding.scriptName === undefined,
  );

/**
 * Alchemy uploads a placeholder for a Worker in a binding cycle that binds only its object
 * classes. The real MCP server also binds the API's app workflow.
 */
const runsMcpServer = (bindings: Bindings) =>
  hostsSessions(bindings) &&
  bindings.some((binding) => binding.type === "workflow" && binding.name === "AppWorkflows");

const forwardsTo = (server: string) => (bindings: Bindings) =>
  bindings.some(
    (binding) =>
      binding.type === "durable_object_namespace" &&
      binding.className === "McpSession" &&
      binding.scriptName === server,
  );

/**
 * Forward MCP sessions only to an MCP server Worker that already runs its own code. Forwarding in
 * the same deploy that adds the Worker sends live sessions to Alchemy's placeholder and then
 * resets them when the real code replaces it.
 */
export const mcpSessionForwardingGate = Effect.gen(function* () {
  if ((yield* AlchemyContext).dev) return;
  const { accountId, workers } = yield* stageWorkers;
  const api = workers.get("Api");
  if (api === undefined) return;
  const server = workers.get("McpServer");
  if (server !== undefined && (yield* liveVersions(accountId, api)).every(forwardsTo(server)))
    return;
  if (server === undefined)
    return yield* new McpSessionReleaseBlocked({
      message:
        `${api} would forward MCP sessions to an MCP server Worker this stage does not have. ` +
        "Deploy the release that adds the MCP server Worker first, then this one.",
    });
  const versions = yield* liveVersions(accountId, server);
  if (versions.length === 0 || !versions.every(runsMcpServer))
    return yield* new McpSessionReleaseBlocked({
      message:
        `${server} is not serving the MCP server's code (it is missing or Alchemy's placeholder, ` +
        "from a deploy that did not finish). Deploy the release that adds the MCP server Worker " +
        "until it succeeds, then this one.",
    });
});
