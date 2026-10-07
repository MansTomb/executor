import {
  permitsApp,
  permitsTarget,
  permitsTool,
  requiresToolMetadata,
} from "@executor-js/authorization";
import type { AppId, DeploymentId, ProfileId, ToolKind, ToolName } from "@executor-js/sdk/core";
import { Effect } from "effect";
import { CurrentAuthorization } from "../contracts/authorization.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { OrganizationForbidden } from "../contracts/organization.ts";

/** Check the shared app policy before reading or evaluating an app; ownership is checked separately. */
export const authorizeApp = (app: AppId) =>
  Effect.gen(function* () {
    const policy = yield* CurrentAuthorization;
    if (!permitsApp(policy, app)) return yield* new OrganizationForbidden();
    return policy;
  });
/** Check the app and how it runs: an omitted profile is the account-free app itself. */
export const authorizeTarget = (app: AppId, profile: ProfileId | undefined) =>
  Effect.gen(function* () {
    const policy = yield* authorizeApp(app);
    if (!permitsTarget(policy, app, profile)) return yield* new OrganizationForbidden();
    return policy;
  });
/**
 * Check exact tool identity before executing or resuming work, independent of HTTP/MCP
 * authentication, and return the kind the work must run as. A read-only rule reads the tool's
 * live metadata from the pinned deployment; an unknown tool or missing flag is forbidden. A tool
 * permitted only as read-only runs as a query, so one that has become a mutation since this check
 * is refused before it runs. Callers resolve the deployment first.
 */
export const authorizeTool = (input: {
  readonly app: AppId;
  readonly tool: ToolName;
  readonly profile?: ProfileId | undefined;
  readonly expectedProfileRevision?: number | undefined;
  readonly deployment?: DeploymentId | undefined;
  readonly kind?: ToolKind | undefined;
}) =>
  Effect.gen(function* () {
    const policy = yield* CurrentAuthorization;
    const request = { app: input.app, profile: input.profile, tool: { name: input.tool } };
    if (!requiresToolMetadata(policy.tools, input.app)) {
      if (!permitsTool(policy, request)) return yield* new OrganizationForbidden();
      return input.kind;
    }
    const executor = yield* Effect.flatten(HostedExecutor);
    const page = yield* executor.tools.list({
      app: input.app,
      profile: input.profile,
      expectedProfileRevision: input.expectedProfileRevision,
      deployment: input.deployment,
      tools: [input.tool],
    });
    const tool = page.items.find((item) => item.name === input.tool);
    if (tool === undefined || !permitsTool(policy, { ...request, tool }))
      return yield* new OrganizationForbidden();
    if (permitsTool(policy, { ...request, tool: { ...tool, readOnly: false } })) return input.kind;
    if (input.kind === "mutation") return yield* new OrganizationForbidden();
    return "query" as const;
  });
