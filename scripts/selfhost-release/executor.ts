import { createHash } from "node:crypto";
import { envFile, type ReleaseConfig } from "./config.ts";
import type { Access } from "./dokploy.ts";
import { must } from "./shell.ts";

type Json = Record<string, unknown>;

export const executorClient = (access: Access) => {
  const env = envFile("executor", ["EXECUTOR_URL", "EXECUTOR_API_KEY"]);
  const origin = env("EXECUTOR_URL")
    .replace(/\/+$/, "")
    .replace(/\/(mcp|api)$/, "");
  const authorization = `Bearer ${env("EXECUTOR_API_KEY")}`;
  const request = async (pathname: string, method: "GET" | "POST", body?: unknown) => {
    if (method !== "GET" && access !== "mutating")
      throw new Error(
        `Refusing the mutating Executor call ${method} ${pathname} in a read-only run`,
      );
    const response = await fetch(`${origin}${pathname}`, {
      method,
      headers: { authorization, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(85_000),
    });
    if (!response.ok) throw new Error(`Executor ${method} ${pathname} answered ${response.status}`);
    return (await response.json()) as unknown;
  };
  const mcp = async () => {
    const headers: Record<string, string> = {
      authorization,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    };
    let sequence = 0;
    const rpc = async (method: string, params: Json, notify = false) => {
      const message: Json = { jsonrpc: "2.0", method, params };
      if (!notify) message["id"] = ++sequence;
      const response = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(65_000),
      });
      if (!response.ok) throw new Error(`MCP ${method} answered ${response.status}`);
      const session = response.headers.get("mcp-session-id");
      if (session !== null) headers["mcp-session-id"] = session;
      const text = await response.text();
      if (text === "") return undefined;
      const payload = /^(event|data):/.test(text)
        ? text
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n")
        : text;
      const reply = JSON.parse(payload) as { readonly result?: Json; readonly error?: unknown };
      if (reply.error !== undefined) throw new Error(`MCP ${method} failed with a JSON-RPC error`);
      return reply.result;
    };
    const init = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "executor-release", version: "1" },
    });
    await rpc("notifications/initialized", {}, true);
    const execute = async (code: string) => {
      const result = (await rpc("tools/call", { name: "execute", arguments: { code } })) as {
        readonly isError?: boolean;
        readonly structuredContent: {
          readonly execution: { readonly ok: boolean; readonly value?: unknown };
        };
      };
      if (result.isError === true) throw new Error("MCP execute failed");
      if (!result.structuredContent.execution.ok) throw new Error("The MCP program failed");
      return result.structuredContent.execution.value;
    };
    return { rpc, execute, protocol: String(init?.["protocolVersion"] ?? "") };
  };
  return {
    origin,
    get: (pathname: string) => request(pathname, "GET"),
    post: (pathname: string, body: unknown) => request(pathname, "POST", body),
    mcp,
  };
};

export type Executor = ReturnType<typeof executorClient>;

type App = {
  readonly id: string;
  readonly slug: string;
  readonly activeVersion?: string | null;
  readonly activeDeployment?: string | null;
};

const apps = async (executor: Executor, config: ReleaseConfig) =>
  (await executor.get(`/api/organizations/${config.organization}/apps`)) as ReadonlyArray<App>;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const sweepProgram = `
const calls = CALLS;
const catalogs = CATALOGS;
const read = async ({app, path, input}) => {
  const started = Date.now();
  try {
    const names = path.replace(/\\["([^"\\]]+)"\\]/g, ".$1").split(".").slice(1);
    let fn = tools;
    for (const name of names) fn = fn[name];
    const value = await fn(input);
    if (value == null || value?.isError === true || value?.success === false || value?.error !== undefined)
      throw new Error("read did not succeed");
    return {app, ok: true, ms: Date.now() - started};
  } catch { throw new Error(app); }
};
const catalog = async ({app, query}) => {
  try {
    const result = await tools.search({namespace: app, query});
    if (!result.items.some(({path}) => path.includes(query))) throw new Error(app);
    return {app, ok: true};
  } catch { throw new Error(app); }
};
try {
  const [checked, catalogOnly] = await Promise.all([Promise.all(calls.map(read)), Promise.all(catalogs.map(catalog))]);
  return {checked, catalogOnly};
} catch (failure) {
  return {checked: [], catalogOnly: [], failedApp: failure?.message ?? "unknown"};
}`;

export type Sweep = {
  readonly status: "passed" | "failed" | "unavailable" | "app-census-mismatch";
  readonly detail?: unknown;
};

export const sweep = async (executor: Executor, config: ReleaseConfig): Promise<Sweep> => {
  try {
    const active = new Set(
      (await apps(executor, config))
        .filter((app) => app.activeVersion || app.activeDeployment)
        .map((app) => app.slug),
    );
    const known = new Set([...config.reads, ...config.catalogOnly].map((entry) => entry.app));
    const uncovered = [...active].filter((slug) => !known.has(slug)).sort();
    const inactive = [...known].filter((slug) => !active.has(slug)).sort();
    if (uncovered.length > 0 || inactive.length > 0)
      return { status: "app-census-mismatch", detail: { uncovered, inactive } };
    const session = await executor.mcp();
    const result = (await session.execute(
      sweepProgram
        .replace("CALLS", JSON.stringify(config.reads))
        .replace("CATALOGS", JSON.stringify(config.catalogOnly)),
    )) as {
      readonly checked: ReadonlyArray<{ readonly ok: boolean }>;
      readonly catalogOnly: ReadonlyArray<{ readonly ok: boolean }>;
      readonly failedApp?: string;
    };
    const passed =
      result.checked.length === config.reads.length &&
      result.catalogOnly.length === config.catalogOnly.length &&
      [...result.checked, ...result.catalogOnly].every((entry) => entry.ok);
    return { status: passed ? "passed" : "failed", detail: result };
  } catch (error) {
    return { status: "unavailable", detail: message(error) };
  }
};

const analyticsProgram = `
const scope = SCOPE;
const { organization } = await tools.executor.context.get({});
const path = { organization, app: scope.app };
const interval = { from: scope.from, to: scope.to };
const query = (event, groupBy) => tools.executor.analytics.summary({ path, query: { ...interval, event, groupBy } });
const summaries = await Promise.all([
  query("upstream_request", ["transport", "purpose", "phase"]),
  query("upstream_request", ["transport", "purpose", "outcome"]),
  query("tool_invocation", ["phase", "outcome"])
]);
return summaries.map((row, i) => ({
  matchedEvents: row.matchedEvents, truncated: row.truncated,
  groups: row.groups
    .filter((g) => i !== 0 || g.dimensions.phase === "started")
    .filter((g) => i !== 1 || g.dimensions.outcome !== null)
    .map(({dimensions, count}) => ({dimensions, count}))
}));`;

export type AnalyticsWindow = { readonly from: number; readonly to: number };

type Summary = {
  readonly matchedEvents: number;
  readonly truncated: boolean;
  readonly groups: ReadonlyArray<{ readonly dimensions: unknown; readonly count: number }>;
};

export type Analytics =
  | {
      readonly status: "available";
      readonly window: AnalyticsWindow;
      readonly summaries: ReadonlyArray<Summary>;
    }
  | { readonly status: "unavailable"; readonly window: AnalyticsWindow; readonly error: string };

export const analyticsWindow = (): AnalyticsWindow => {
  const to = Date.now();
  return { from: to - 7 * 86_400_000, to };
};

export const analytics = async (
  executor: Executor,
  config: ReleaseConfig,
  window: AnalyticsWindow,
): Promise<Analytics> => {
  try {
    const app = (await apps(executor, config)).find((entry) => entry.slug === config.analyticsApp);
    if (app === undefined) throw new Error(`No ${config.analyticsApp} app`);
    const session = await executor.mcp();
    const summaries = (await session.execute(
      analyticsProgram.replace(
        "SCOPE",
        JSON.stringify({ app: app.id, from: String(window.from), to: String(window.to) }),
      ),
    )) as ReadonlyArray<Summary>;
    if (!Array.isArray(summaries) || summaries.length !== 3)
      throw new Error("Unexpected analytics shape");
    return { status: "available", window, summaries };
  } catch (error) {
    return { status: "unavailable", window, error: message(error) };
  }
};

const groupKey = (summary: Summary) =>
  summary.groups
    .map((group) => `${JSON.stringify(group.dimensions)}=${group.count}`)
    .sort()
    .join(";");

export const analyticsRetained = (before: Analytics, after: Analytics) =>
  before.status === "available" &&
  after.status === "available" &&
  before.window.from === after.window.from &&
  before.window.to === after.window.to &&
  before.summaries.every((summary, index) => {
    const other = after.summaries[index];
    return (
      other !== undefined &&
      !other.truncated &&
      other.matchedEvents === summary.matchedEvents &&
      groupKey(other) === groupKey(summary)
    );
  });

type SourceFile = { readonly path: string; readonly content: string; readonly encoding?: string };

const normalize = (files: ReadonlyArray<SourceFile>) =>
  JSON.stringify(
    files
      .map((file) => [
        file.path,
        file.encoding === "base64" ? Buffer.from(file.content, "base64").toString() : file.content,
      ])
      .sort(([left = ""], [right = ""]) => left.localeCompare(right)),
  );

export type Management = {
  readonly files: ReadonlyArray<SourceFile>;
  readonly operations: ReadonlyArray<string>;
};

export const generateManagement = async (worktree: string, origin: string) =>
  JSON.parse(
    await must("node", ["scripts/selfhost-release/management-source.ts", origin], {
      cwd: worktree,
      timeoutSeconds: 120,
    }),
  ) as Management;

const managementPrefix = async (executor: Executor, config: ReleaseConfig) => {
  const app = (await apps(executor, config)).find((entry) => entry.slug === "executor");
  if (app === undefined) throw new Error("No Executor management app");
  return {
    prefix: `/api/organizations/${config.organization}/apps/${app.id}`,
    active: app.activeVersion ?? app.activeDeployment ?? "",
  };
};

export const managementDiffers = async (
  executor: Executor,
  config: ReleaseConfig,
  generated: Management,
) => {
  const { prefix } = await managementPrefix(executor, config);
  const deployed = (await executor.get(`${prefix}/source`)) as {
    readonly files: ReadonlyArray<SourceFile>;
  };
  return normalize(deployed.files) !== normalize(generated.files);
};

const linksHash = async (executor: Executor, prefix: string) =>
  createHash("sha256")
    .update(JSON.stringify(await executor.get(`${prefix}/accounts/user`)))
    .digest("hex");

export const deployManagement = async (
  executor: Executor,
  config: ReleaseConfig,
  generated: Management,
  label: string,
) => {
  const { prefix, active: previous } = await managementPrefix(executor, config);
  const links = await linksHash(executor, prefix);
  const workspace = (await executor.get(`${prefix}/workspace`)) as {
    readonly revision: { readonly commit: string };
  };
  const saved = (await executor.post(`${prefix}/commits`, {
    expected: workspace.revision.commit,
    files: generated.files,
    message: `Update default Executor app for ${label}`,
  })) as { readonly revision: { readonly commit: string } };
  const commit = saved.revision.commit;
  const deployed = (await executor.post(`${prefix}/deploy`, { commit })) as {
    readonly app: { readonly activeVersion: string };
  };
  const active = deployed.app.activeVersion;
  if (active === previous) throw new Error("The management app deployment did not change");
  const [source, current] = (await Promise.all([
    executor.get(`${prefix}/source`),
    executor.get(`${prefix}/workspace`),
  ])) as [
    { readonly files: ReadonlyArray<SourceFile> },
    { readonly files: ReadonlyArray<SourceFile>; readonly revision: { readonly commit: string } },
  ];
  const expected = normalize(generated.files);
  if (normalize(source.files) !== expected || normalize(current.files) !== expected)
    throw new Error("The deployed management files differ from the generated source");
  if (current.revision.commit !== commit) throw new Error("The saved workspace is not aligned");
  if ((await linksHash(executor, prefix)) !== links)
    throw new Error("The management app's account links changed");
  return { previous, active, workspaceCommit: commit, files: generated.files.length };
};

export const checkManagement = async (
  executor: Executor,
  generated: Management,
  active: string,
) => {
  const session = await executor.mcp();
  const allowed = new Set(generated.operations);
  const paths = new Set<string>();
  let request: Json | undefined = { namespace: "executor", limit: 200 };
  for (let page = 0; request !== undefined; page++) {
    if (page >= 20) throw new Error("The management catalog did not end within 20 pages");
    const result = (await session.rpc("tools/call", { name: "search", arguments: request })) as {
      readonly isError?: boolean;
      readonly structuredContent: {
        readonly items: ReadonlyArray<{ readonly path: string }>;
        readonly next?: Json | null;
      };
    };
    if (result.isError === true) throw new Error("The management catalog search failed");
    for (const { path } of result.structuredContent.items) {
      if (path.toLowerCase().includes("profile") || paths.has(path))
        throw new Error(`Unexpected management path ${path}`);
      if (!allowed.has(path.replace(/^tools\.executor\./, "")))
        throw new Error(`The management catalog lists ${path}, which the server API lacks`);
      paths.add(path);
    }
    request = result.structuredContent.next ?? undefined;
  }
  for (const required of ["tools.executor.analytics.summary", "tools.executor.context.get"])
    if (!paths.has(required)) throw new Error(`The management catalog lacks ${required}`);
  for (const name of ["executor", "code-mode"]) {
    const result = (await session.rpc("tools/call", {
      name: "skills",
      arguments: { app: "executor", name },
    })) as { readonly isError?: boolean };
    if (result.isError === true || !JSON.stringify(result).includes(active))
      throw new Error(`The ${name} skill does not load from ${active}`);
  }
  return { catalog: paths.size, skills: ["executor", "code-mode"], protocol: session.protocol };
};
