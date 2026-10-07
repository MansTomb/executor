import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import {
  beginCleanup,
  claimContainer,
  cleanupOwned,
  containerLogSync,
  dockerAsync,
  dockerSync,
  freePort,
  instanceOwner,
  interruptible,
  privateDirectory,
  session,
  sleep,
  uniqueName,
  waitForRoot,
  writePrivate,
} from "./lib.mjs";

const {
  values: { image, evidence, "deadline-seconds": deadlineSeconds = "1200" },
} = parseArgs({
  options: {
    image: { type: "string" },
    evidence: { type: "string" },
    "deadline-seconds": { type: "string" },
  },
});
const registry = process.env.SOAK_REGISTRY_URL;
const appsVersion = process.env.SOAK_APPS_VERSION;
if (!image || !evidence || !registry || !appsVersion)
  throw new Error("--image, --evidence, SOAK_REGISTRY_URL and SOAK_APPS_VERSION are required");

const workload = { deployments: 60, sessions: 200, searches: 500 };
const memoryLimit = "4g";
const protocolVersion = "2025-03-26";
const deleteStatuses = [200, 202, 204, 405];
const name = claimContainer(uniqueName("soak"));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const report = {
  image,
  appsVersion,
  startedAt: new Date().toISOString(),
  workload,
  memoryLimit,
  deadlineSeconds: Number(deadlineSeconds),
  sessionDelete: {},
  phases: [],
  samples: [],
};
let violation;
let settled = false;

const settle = () => {
  if (settled) return;
  settled = true;
  beginCleanup();
  try {
    dockerSync(["inspect", name], { timeout: 30_000 });
    writePrivate(evidence, "container.log", containerLogSync(name, "--tail", "1000"));
  } catch {}
  const errors = cleanupOwned();
  if (errors.length > 0) {
    report.cleanupError = errors.join("; ");
    process.exitCode = 1;
  }
  report.completedAt = new Date().toISOString();
  writePrivate(evidence, "soak.json", `${JSON.stringify(report, null, 2)}\n`);
  const { samples, ...summary } = report;
  console.log(JSON.stringify({ ...summary, samples: samples.length }, null, 2));
};

privateDirectory(evidence);
interruptible({
  deadlineSeconds: Number(deadlineSeconds),
  onInterrupt: (reason) => {
    report.passed = false;
    report.failure = reason;
    settle();
  },
});

const sample = async (phase) => {
  const state = JSON.parse(await dockerAsync(["inspect", name], { timeout: 30_000 }))[0];
  const stats = JSON.parse(
    await dockerAsync(["stats", "--no-stream", "--format", "{{json .}}", name], {
      timeout: 60_000,
    }),
  );
  report.samples.push({
    at: new Date().toISOString(),
    phase,
    memory: stats.MemUsage,
    cpu: stats.CPUPerc,
    restarts: state.RestartCount,
    oomKilled: state.State.OOMKilled,
    running: state.State.Running,
  });
  if (!state.State.Running || state.RestartCount > 0 || state.State.OOMKilled)
    violation ??= new Error("Soak container stopped, restarted or was OOM killed");
};

const login = async () => {
  const { request, signIn } = session(base);
  signIn((await request("/api/auth/self-host/setup", "POST", instanceOwner)).headers);
  const { data: organizations } = await request("/api/auth/organization/list");
  const organization = organizations[0].id;
  const { data: key } = await request("/api/auth/api-key/create", "POST", { name: "Soak" });
  return { request, organization, key: key.key };
};

const source = (version) => [
  { path: "package.json", content: JSON.stringify({ dependencies: { apps: appsVersion } }) },
  {
    path: "index.ts",
    content: `import { defineApp, query, object, number, router } from "apps"; export const version = query({input:object({}),output:number()},async()=>${version}); export default defineApp({accounts:{}},{tools:router({version})});`,
  },
];

const mcp = ({ organization, key }) => {
  let sequence = 0;
  let sessionId;
  const seen = new Set();
  const headers = (extra) => ({
    authorization: `Bearer ${key}`,
    "x-executor-organization": organization,
    ...extra,
  });
  const call = async (method, params) => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: headers({
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
      }),
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    assert.equal(response.status, 200, `${method}: HTTP ${response.status} ${text.slice(0, 400)}`);
    const data = /^(event|data):/.test(text)
      ? JSON.parse(
          text
            .split("\n")
            .find((line) => line.startsWith("data:"))
            .slice(5),
        )
      : JSON.parse(text);
    assert.equal(data.error, undefined, `${method}: ${JSON.stringify(data).slice(0, 400)}`);
    return { result: data.result, headers: response.headers };
  };
  const open = async () => {
    sessionId = undefined;
    const { result, headers: received } = await call("initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "soak", version: "1" },
    });
    assert.equal(result.protocolVersion, protocolVersion);
    assert.equal(result.serverInfo.name, "Executor");
    const id = received.get("mcp-session-id");
    assert(typeof id === "string" && id !== "", "initialize negotiated no session id");
    assert(!seen.has(id), `initialize reused session id ${id}`);
    seen.add(id);
    sessionId = id;
  };
  const close = async () => {
    if (sessionId === undefined) return;
    const response = await fetch(`${base}/mcp`, {
      method: "DELETE",
      headers: headers({ "mcp-session-id": sessionId }),
      signal: AbortSignal.timeout(30_000),
    });
    await response.text();
    assert(deleteStatuses.includes(response.status), `session DELETE answered ${response.status}`);
    report.sessionDelete[response.status] = (report.sessionDelete[response.status] ?? 0) + 1;
    sessionId = undefined;
  };
  const execute = async (code) => {
    const { result } = await call("tools/call", { name: "execute", arguments: { code } });
    assert.equal(result.isError, false, JSON.stringify(result).slice(0, 400));
    const outcome =
      result.structuredContent ??
      JSON.parse(result.content.find((item) => item.type === "text").text);
    assert.equal(outcome.status, "completed", JSON.stringify(outcome).slice(0, 400));
    assert.equal(outcome.execution.ok, true, JSON.stringify(outcome).slice(0, 400));
    return outcome.execution;
  };
  return { open, close, execute };
};

const phases = {
  deployments: async (auth, client, count) => {
    const { request, organization } = auth;
    const prefix = `/api/organizations/${organization}/apps`;
    const { data: app } = await request(`${prefix}/deploy`, "POST", {
      name: "Soak",
      files: source(0),
    });
    for (let index = 1; index <= count; index++) {
      const { data: before } = await request(`${prefix}/${app.id}/workspace`);
      const { data: saved } = await request(`${prefix}/${app.id}/commits`, "POST", {
        expected: before.revision.commit,
        files: source(index),
        message: "Soak revision",
      });
      await request(`${prefix}/${app.id}/deploy`, "POST", { commit: saved.revision.commit });
      const { data: result } = await request(`${prefix}/${app.id}/tools/call`, "POST", {
        tool: "version",
        input: {},
      });
      assert.equal(result, index, `Deployment ${index} served version ${result}`);
      if (violation) throw violation;
    }
  },
  sessions: async (auth, client, count) => {
    for (let index = 1; index <= count; index++) {
      await client.close();
      await client.open();
      assert.equal((await client.execute(`return ${index}+1;`)).value, index + 1);
      if (violation) throw violation;
    }
  },
  searches: async (auth, client, count) => {
    await client.open();
    assert.equal(
      (await client.execute("return await tools.soak.version({})")).value,
      workload.deployments,
    );
    for (let index = 1; index <= count; index++) {
      const { value, toolCalls } = await client.execute(
        'return await tools.search({query:"version",limit:10})',
      );
      assert.deepEqual(
        value.items.filter((item) => item.path === "tools.soak.version"),
        [{ path: "tools.soak.version", description: "Query version", input: "{}" }],
      );
      assert.deepEqual(
        value.namespaces.filter((namespace) => namespace.path === "tools.soak"),
        [{ path: "tools.soak", app: "Soak" }],
      );
      assert.equal(toolCalls.length, 1);
      assert.equal(toolCalls[0].name, "search");
      assert.equal(toolCalls[0].outcome, "success");
      if (violation) throw violation;
    }
    await client.close();
  },
};

try {
  await dockerAsync([
    "run",
    "-d",
    "--name",
    name,
    "--memory",
    memoryLimit,
    "--network",
    "host",
    "-e",
    `PORT=${port}`,
    "-e",
    "HOST=127.0.0.1",
    "-e",
    `BETTER_AUTH_URL=${base}`,
    "-e",
    "EXECUTOR_APPS_ALLOW_PRIVATE_FETCH=true",
    "-e",
    `EXECUTOR_NPM_REGISTRY=${registry}`,
    "-e",
    "DO_NOT_TRACK=1",
    image,
  ]);
  await waitForRoot(base);
  report.imageId = await dockerAsync(["inspect", "--format", "{{.Image}}", name], {
    timeout: 30_000,
  });
  await sample("ready");
  const auth = await login();
  const client = mcp(auth);
  for (const [phase, count] of [
    ["deployments", workload.deployments],
    ["sessions", workload.sessions],
    ["searches", workload.searches],
  ]) {
    const began = Date.now();
    let finished = false;
    const sampler = (async () => {
      while (!finished) {
        try {
          await sample(phase);
        } catch (error) {
          violation ??= error;
          return;
        }
        await sleep(8000);
      }
    })();
    try {
      await phases[phase](auth, client, count);
    } finally {
      finished = true;
      await sampler;
    }
    await sample(`${phase}-complete`);
    if (violation) throw violation;
    report.phases.push({ phase, count, durationSeconds: (Date.now() - began) / 1000 });
  }
  await client.close();
  report.cgroup = await dockerAsync(
    [
      "exec",
      name,
      "sh",
      "-c",
      "cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory.events",
    ],
    { timeout: 30_000 },
  );
  if (!/^oom_kill 0$/m.test(report.cgroup)) throw new Error("cgroup recorded an OOM kill");
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error.message;
  process.exitCode = 1;
} finally {
  settle();
}
