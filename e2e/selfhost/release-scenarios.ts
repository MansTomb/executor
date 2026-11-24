import { scenarios } from "../test-plan.ts";

export type ScenarioKey = keyof typeof scenarios;
export type RunTarget = "self-host" | "local";

export const runTarget = (key: ScenarioKey): RunTarget | undefined => {
  const { targets } = scenarios[key];
  if (targets["self-host"].status === "scheduled") return "self-host";
  if (targets.local.status === "scheduled") return "local";
  return undefined;
};

export const scenariosInFile = (file: string): ReadonlyArray<ScenarioKey> =>
  (Object.keys(scenarios) as Array<ScenarioKey>).filter(
    (key) => scenarios[key].file === file && runTarget(key) !== undefined,
  );

export const focused: ReadonlyArray<ScenarioKey> = [
  "appWorkerLifetime",
  "oauthRegistrationApplicationType",
  "appFetchUserAgent",
  "appLoadFailureContainment",
  "securityObservability",
  "accountCheckFailureDetail",
  "mcpDiscoverySelection",
  "mcpDiscoverySchemas",
  "mcpSlowListing",
  "mcpSlowRouter",
  "mcpSlowRouterSummaries",
  "mcpSlowListingRecovery",
  "mcpOutputRecovery",
  "mcpOutputTruncation",
  "mcpDirectCalls",
  "mcpMediaContent",
  "toolCallLogMcp",
  "mcpExecuteApprovalSize",
  "mcpExecuteToolReportedError",
  "mcpExecuteReach",
  "mcpRefreshRejectionLog",
  "mcpProtocolVersions",
  "appManagementContractsHosted",
  "dashboardBatchAuthentication",
  "dashboardBatchIsolation",
  "storageMigrationDiagnostics",
  "personalAccountsMigration",
  "personalAccountsAppLinkConversion",
  "telemetryStoreIdleAtBound",
  "mcpResultContract",
  "thrownAppError",
  "mutationTimeoutBoundary",
  "expiredAccountBoundary",
  "observabilityOutcomes",
  "appFetchUnsupportedOption",
  "mcpInterceptor",
  "clickupFresh",
  "openapiPaths",
  "sharedAuthorization",
  "apiGrantRestrictions",
  "liveGrantRestrictions",
  "readOnlyGrantLiveKind",
  "readOnlyGrantRetainedMetadata",
  "toolCallHeldCheck",
  "toolCallHeldAccess",
  "patMcpApprovals",
  "scopedConnectionAccess",
  "scopedConnectionAccounts",
  "activeVersionTools",
  "activeVersionResume",
  "analytics",
  "mcpSearchConcise",
  "oauthRefreshRedirectUri",
  "localMcpOfflineGrantLifetime",
  "localMcpExpiredSessionGrant",
];

export const smoke: ReadonlyArray<ScenarioKey> = [
  "mcpDirectCalls",
  "mcpExecuteReach",
  "mcpProtocolVersions",
  "mcpOutputTruncation",
  "appManagementContractsHosted",
  "mcpRefreshRejectionLog",
  "localMcpOfflineGrantLifetime",
];

export type PathRule =
  | { readonly kind: "schema"; readonly reason: string; readonly paths: ReadonlyArray<string> }
  | { readonly kind: "full"; readonly reason: string; readonly paths: ReadonlyArray<string> }
  | { readonly kind: "manifest"; readonly reason: string; readonly paths: ReadonlyArray<string> }
  | { readonly kind: "untested"; readonly reason: string; readonly paths: ReadonlyArray<string> }
  | { readonly kind: "spec"; readonly reason: string; readonly paths: ReadonlyArray<string> }
  | { readonly kind: "plan"; readonly reason: string; readonly paths: ReadonlyArray<string> }
  | {
      readonly kind: "scenarios";
      readonly reason: string;
      readonly paths: ReadonlyArray<string>;
      readonly scenarios: ReadonlyArray<ScenarioKey>;
    };

const mcp: ReadonlyArray<ScenarioKey> = [
  "mcpDirectCalls",
  "mcpMediaContent",
  "mcpDiscoverySelection",
  "mcpDiscoverySchemas",
  "mcpOutputRecovery",
  "mcpOutputTruncation",
  "mcpExecuteApprovalSize",
  "mcpExecuteToolReportedError",
  "mcpExecuteReach",
  "mcpProtocolVersions",
  "mcpResultContract",
  "toolCallLogMcp",
  "observabilityOutcomes",
  "mcpSearchConcise",
];

const mcpAuth: ReadonlyArray<ScenarioKey> = [
  "mcpRefreshRejectionLog",
  "oauthRegistrationApplicationType",
  "oauthRefreshRedirectUri",
  "localMcpOfflineGrantLifetime",
  "localMcpExpiredSessionGrant",
  "patMcpApprovals",
  "scopedConnectionAccess",
  "scopedConnectionAccounts",
];

const grants: ReadonlyArray<ScenarioKey> = [
  "sharedAuthorization",
  "apiGrantRestrictions",
  "liveGrantRestrictions",
  "readOnlyGrantLiveKind",
  "readOnlyGrantRetainedMetadata",
  "toolCallHeldCheck",
  "toolCallHeldAccess",
];

const appFramework: ReadonlyArray<ScenarioKey> = [
  "mcpInterceptor",
  "clickupFresh",
  "openapiPaths",
  "thrownAppError",
  "expiredAccountBoundary",
  "appFetchUserAgent",
  "appFetchUnsupportedOption",
  "appLoadFailureContainment",
  "mcpResultContract",
  "mcpDiscoverySchemas",
];

const listings: ReadonlyArray<ScenarioKey> = [
  "mcpSlowListing",
  "mcpSlowRouter",
  "mcpSlowRouterSummaries",
  "mcpSlowListingRecovery",
];

const hostedServer: ReadonlyArray<ScenarioKey> = [
  "appManagementContractsHosted",
  "dashboardBatchAuthentication",
  "dashboardBatchIsolation",
  "securityObservability",
  "accountCheckFailureDetail",
  "activeVersionTools",
  "activeVersionResume",
  "patMcpApprovals",
];

export const pathRules: ReadonlyArray<PathRule> = [
  {
    kind: "schema",
    reason: "storage schema or migration",
    paths: [
      "packages/sdk/src/implementation/storage*.ts",
      "packages/sdk/src/implementation/database.ts",
      "packages/sdk/src/implementation/worker-build-migration.ts",
      "packages/sdk/src/workerd-migration.ts",
      "packages/fumadb-effect/",
      "apps/hosted/server/src/implementation/migrations.ts",
      "apps/hosted/self-host/src/implementation/workerd/storage-migration.ts",
    ],
  },
  {
    kind: "untested",
    reason: "documentation",
    paths: ["*.md", "notes/", "patches/*.md", "e2e/**/*.md", "scripts/**/*.md", "apps/docs/"],
  },
  {
    kind: "full",
    reason: "dependency lockfile or patch",
    paths: ["bun.lock", "patches/", "bunfig.toml", ".npmrc"],
  },
  {
    kind: "full",
    reason: "image, runtime or workerd configuration",
    paths: [
      ".dockerignore",
      "apps/hosted/self-host/Dockerfile",
      "apps/hosted/self-host/entrypoint.sh",
      "apps/hosted/self-host/compose.yaml",
      "apps/hosted/self-host/scripts/",
      "apps/hosted/self-host/native/",
      "apps/hosted/self-host/src/implementation/workerd/",
      "packages/telemetry/collector/",
      "packages/telemetry/scripts/",
    ],
  },
  {
    kind: "full",
    reason: "default Executor management app source",
    paths: ["packages/app-templates/", "apps/hosted/server/src/implementation/executor-app.ts"],
  },
  {
    kind: "manifest",
    reason: "package manifest",
    paths: ["package.json", "**/package.json"],
  },
  {
    kind: "untested",
    reason: "release tooling, exercised by the gate itself",
    paths: ["scripts/selfhost-release/", "scripts/selfhost-verify/", "e2e/selfhost/"],
  },
  {
    kind: "untested",
    reason: "not part of the self-host image",
    paths: [
      ".github/",
      "apps/hosted/cloud/",
      "apps/local/desktop/",
      "apps/local/web/",
      "apps/marketing/",
      "apps/cli/",
      "scripts/releases/",
      "scripts/ci/",
    ],
  },
  { kind: "spec", reason: "scenario file", paths: ["e2e/tests/*.spec.ts"] },
  { kind: "plan", reason: "scenario registration", paths: ["e2e/test-plan.ts"] },
  { kind: "scenarios", reason: "E2E harness", paths: ["e2e/"], scenarios: [] },
  { kind: "scenarios", reason: "MCP server", paths: ["packages/mcp/"], scenarios: mcp },
  {
    kind: "scenarios",
    reason: "MCP OAuth and grants",
    paths: ["packages/mcp-auth/"],
    scenarios: mcpAuth,
  },
  {
    kind: "scenarios",
    reason: "authorization",
    paths: ["packages/authorization/"],
    scenarios: grants,
  },
  {
    kind: "scenarios",
    reason: "app framework",
    paths: ["packages/apps/"],
    scenarios: appFramework,
  },
  {
    kind: "scenarios",
    reason: "app catalog cache",
    paths: ["packages/app-cache/"],
    scenarios: listings,
  },
  {
    kind: "scenarios",
    reason: "telemetry",
    paths: ["packages/telemetry/src/"],
    scenarios: ["observabilityOutcomes", "telemetryStoreIdleAtBound", "securityObservability"],
  },
  {
    kind: "scenarios",
    reason: "hosted server",
    paths: ["apps/hosted/server/"],
    scenarios: [...hostedServer, ...mcp, ...grants],
  },
  {
    kind: "scenarios",
    reason: "local server",
    paths: ["apps/local/server/"],
    scenarios: [
      "analytics",
      "mcpSearchConcise",
      "oauthRefreshRedirectUri",
      "localMcpOfflineGrantLifetime",
    ],
  },
];
