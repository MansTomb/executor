import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  beginCleanup,
  claimContainer,
  claimVolume,
  cleanupOwned,
  containerLogAsync,
  containerLogSync,
  dockerAsync,
  dockerStream,
  freePort,
  instanceOwner,
  interruptible,
  privateDirectory,
  releaseContainer,
  session,
  sleep,
  uniqueName,
  waitForRoot,
  writePrivate,
} from "./lib.mjs";
import { seeds } from "./seeds.mjs";

const {
  values: {
    previous,
    candidate,
    evidence,
    "previous-api": previousApi = "router",
    "deadline-seconds": deadlineSeconds = "480",
  },
} = parseArgs({
  options: {
    previous: { type: "string" },
    "previous-api": { type: "string" },
    candidate: { type: "string" },
    evidence: { type: "string" },
    "deadline-seconds": { type: "string" },
  },
});
if (!previous || !candidate || !evidence)
  throw new Error("--previous, --candidate and --evidence are required");
if (!/@sha256:[0-9a-f]{64}$/.test(previous))
  throw new Error("--previous must be an immutable image reference ending in @sha256:<digest>");

if (!Object.hasOwn(seeds, previousApi))
  throw new Error(`--previous-api must be one of ${Object.keys(seeds).join(", ")}`);

privateDirectory(evidence);
const name = claimContainer(uniqueName("upgrade"));
const volume = claimVolume(`${name}-data`);
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const { request, signIn } = session(base);
const report = {
  previous,
  previousApi,
  candidate,
  checks: [],
  startedAt: new Date().toISOString(),
  deadlineSeconds: Number(deadlineSeconds),
};
const backup = path.join(evidence, "baseline-volume.tar");
const unreachableRegistry = "http://127.0.0.1:9";
const stopGraceSeconds = 40;
let running = false;
let settled = false;

const settle = () => {
  if (settled) return;
  settled = true;
  beginCleanup();
  const errors = cleanupOwned();
  if (errors.length > 0) {
    report.cleanupError = errors.join("; ");
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  writePrivate(evidence, "upgrade-drain.json", `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      success: report.success,
      analyticsSeeded: report.analyticsSeeded,
      previousAppsVersion: report.previousAppsVersion,
      checks: report.checks,
      drain: report.drain,
    }),
  );
};

interruptible({
  deadlineSeconds: Number(deadlineSeconds),
  onInterrupt: (reason) => {
    report.success = false;
    report.error = reason;
    settle();
  },
});

const start = async (image, registry) => {
  claimContainer(name);
  await dockerAsync([
    "run",
    "-d",
    "--name",
    name,
    "--memory",
    "4g",
    "--network",
    "host",
    "-v",
    `${volume}:/app/data`,
    "-e",
    `PORT=${port}`,
    "-e",
    "HOST=127.0.0.1",
    "-e",
    `BETTER_AUTH_URL=${base}`,
    "-e",
    "EXECUTOR_APPS_ALLOW_PRIVATE_FETCH=true",
    "-e",
    "DO_NOT_TRACK=1",
    ...(registry === undefined ? [] : ["-e", `EXECUTOR_NPM_REGISTRY=${registry}`]),
    image,
  ]);
  running = true;
  await waitForRoot(base);
};

const stop = async () => {
  if (!running) return;
  await dockerAsync(["stop", "--time", String(stopGraceSeconds), name], {
    timeout: (stopGraceSeconds + 30) * 1000,
  });
  writePrivate(evidence, `server-${report.checks.length}.log`, await containerLogAsync(name));
  await releaseContainer(name);
  running = false;
};

const keyDigests = async () => {
  const temporary = path.join(evidence, "key-digests");
  privateDirectory(temporary);
  try {
    const digests = [];
    for (const file of ["auth-secret.key", "encryption.key"]) {
      await dockerAsync(["cp", `${name}:/app/data/${file}`, path.join(temporary, file)]);
      digests.push(
        `${file} ${createHash("sha256")
          .update(fs.readFileSync(path.join(temporary, file)))
          .digest("hex")}`,
      );
    }
    return digests.join("\n");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
};

const copyVolumeWithImage = async (command) => {
  const holder = claimContainer(uniqueName("volume"));
  try {
    await dockerAsync(["create", "--name", holder, "-v", `${volume}:/app/data`, previous]);
    await command(holder);
  } finally {
    await releaseContainer(holder);
  }
};

try {
  await dockerAsync(["volume", "create", volume]);
  await start(previous);
  signIn((await request("/api/auth/self-host/setup", "POST", instanceOwner)).headers);
  const { data: organizations } = await request("/api/auth/organization/list");
  const prefix = `/api/organizations/${organizations[0].id}`;
  const deploy = (files) =>
    request(`${prefix}/apps/deploy`, "POST", { name: "Fork upgrade", files });
  const source = { path: "index.ts", content: seeds[previousApi] };
  const { data: app } = await deploy([source]).catch(async (error) => {
    const version = /apps\\": \\"([^"\\]+)\\"/.exec(error.message)?.[1];
    if (version === undefined) throw error;
    report.previousAppsVersion = version;
    return deploy([
      source,
      { path: "package.json", content: JSON.stringify({ dependencies: { apps: version } }) },
    ]);
  });
  const { data: profile } = await request(`${prefix}/apps/${app.id}/profiles`, "POST", {
    accounts: {},
    idempotencyKey: crypto.randomUUID(),
  });
  const { data: connection } = await request(`${prefix}/apps/${app.id}/connections`, "POST", {
    requirement: "service",
    profile: profile.id,
  });
  const { data: account } = await request(`${prefix}/connections/${connection.id}/submit`, "POST", {
    method: "key",
    label: "Retained credential",
    fields: { token: "synthetic-upgrade-token" },
  });
  // A second profile of the same member selects a different account. The candidate's storage
  // upgrade keeps the app with the oldest profile's account set and makes the other set a copy of
  // the app with an empty database, which it builds again from source.
  const { data: secondProfile } = await request(`${prefix}/apps/${app.id}/profiles`, "POST", {
    name: "Second set",
    accounts: {},
    idempotencyKey: crypto.randomUUID(),
  });
  const { data: secondConnection } = await request(`${prefix}/apps/${app.id}/connections`, "POST", {
    requirement: "service",
    profile: secondProfile.id,
  });
  const { data: secondAccount } = await request(
    `${prefix}/connections/${secondConnection.id}/submit`,
    "POST",
    { method: "key", label: "Second account set", fields: { token: "synthetic-second-token" } },
  );
  // The previous image selects accounts through a profile. The candidate has no profiles: calls
  // use the accounts the storage upgrade linked for the member.
  let selection = { profile: profile.id };
  const callApp = async (target, chosen, tool) =>
    (
      await request(`${prefix}/apps/${target}/tools/call`, "POST", {
        ...chosen,
        tool,
        input: {},
      })
    ).data;
  const call = (tool) => callApp(app.id, selection, tool);
  const linked = async (target) =>
    (await request(`${prefix}/apps/${target}/accounts/user`)).data.map((link) => [
      link.requirement,
      link.account.id,
    ]);
  const from = Date.now() - 120_000;
  const analytics = async () =>
    (
      await request(
        `${prefix}/apps/${app.id}/analytics?from=${from}&to=${Date.now()}&event=upgrade_probe&groupBy=purpose`,
      )
    ).data;
  assert.deepEqual(await call("queries.check"), { retained: true });
  assert.deepEqual(await callApp(app.id, { profile: secondProfile.id }, "queries.check"), {
    retained: false,
  });
  assert.equal(await call("mutations.remember"), true);
  assert.equal(await call("queries.kept"), "seeded-before-upgrade");
  const analyticsSeeded = (await call("queries.seed")) === true;
  if (previousApi === "legacy") assert(analyticsSeeded);
  const retainedAnalytics = async () => {
    const summary = await analytics();
    assert.equal(summary.matchedEvents, analyticsSeeded ? 1 : 0);
    if (analyticsSeeded)
      assert.deepEqual(
        summary.groups.map((group) => group.dimensions),
        [{ purpose: "retained" }],
      );
  };
  await retainedAnalytics();
  report.analyticsSeeded = analyticsSeeded;
  const withAnalytics = analyticsSeeded ? ", analytics" : "";
  const priorKeys = await keyDigests();
  report.checks.push(
    `previous image built the app against the published framework${report.previousAppsVersion === undefined ? "" : ` apps ${report.previousAppsVersion}`} and seeded two profiles with distinct encrypted accounts, app data${withAnalytics} and keys`,
  );
  if (!analyticsSeeded)
    report.checks.push(
      "analytics retention not verified: the previous framework exposes no authored analytics",
    );
  await stop();

  await copyVolumeWithImage(async (holder) => {
    const descriptor = fs.openSync(backup, "w", 0o600);
    try {
      await dockerStream(["cp", `${holder}:/app/data/.`, "-"], { stdout: descriptor });
    } finally {
      fs.closeSync(descriptor);
    }
  });

  selection = {};
  /** The copy the upgrade makes for the second account set, once its data step has run. */
  const profileCopy = async () => {
    for (let attempt = 0; attempt < 120; attempt++) {
      const { data: listed } = await request(`${prefix}/apps`);
      const copies = listed.filter((value) => value.name.startsWith(`${app.name} (`));
      if (copies.length > 0) {
        assert.equal(copies.length, 1);
        return copies[0];
      }
      await sleep(1000);
    }
    throw new Error("The upgrade made no copy for the second account set");
  };
  let copyId;
  for (const iteration of [1, 2]) {
    await start(candidate, unreachableRegistry);
    assert.equal(await keyDigests(), priorKeys);
    assert.deepEqual(await call("queries.check"), { retained: true });
    assert.equal(await call("queries.kept"), "seeded-before-upgrade");
    assert.deepEqual(await linked(app.id), [["service", account.id]]);
    const copy = await profileCopy();
    if (copyId === undefined) copyId = copy.id;
    assert.equal(copy.id, copyId);
    assert.deepEqual(await linked(copy.id), [["service", secondAccount.id]]);
    const copyDeployed = copy.activeDeployment !== null && copy.activeDeployment !== undefined;
    if (copyDeployed) {
      assert.deepEqual(await callApp(copy.id, {}, "queries.check"), { retained: false });
      assert.equal((await callApp(copy.id, {}, "queries.kept")) ?? null, null);
    }
    report.profileCopy = { name: copy.name, deployed: copyDeployed };
    report.checks.push(
      `candidate start ${iteration}: the app kept the oldest profile's account and its data; the second account set became the copy "${copy.name}" linking only its account, ${copyDeployed ? "rebuilt from source with an empty database" : "not deployed: rebuilding its source needs the unreachable registry"}`,
    );
    await retainedAnalytics();
    const { data: retainedAccount } = await request(`${prefix}/accounts/${account.id}`);
    assert.equal(retainedAccount.account.id, account.id);
    const { data: apps } = await request(`${prefix}/apps`);
    const retained = apps.find((value) => value.id === app.id);
    assert(retained);
    assert.equal(retained.activeDeployment, app.activeDeployment);
    const state = JSON.parse(await dockerAsync(["inspect", name]))[0];
    assert.equal(state.RestartCount, 0);
    assert.equal(state.State.OOMKilled, false);
    report.checks.push(
      `candidate start ${iteration}: ran the stored previous build with no reachable registry and the profile's account as a linked account; session, encrypted account${withAnalytics}, deployment and keys retained`,
    );
    if (iteration === 1) {
      const began = Date.now();
      const pending = call("mutations.hold");
      pending.catch(() => {});
      await sleep(2000);
      await dockerAsync(["kill", "--signal", "SIGTERM", name]);
      await sleep(300);
      let listenerClosed = false;
      try {
        await fetch(`${base}/`, { signal: AbortSignal.timeout(1000) });
      } catch {
        listenerClosed = true;
      }
      assert.equal(listenerClosed, true);
      assert.equal(await pending, "completed-once");
      assert.equal(await dockerAsync(["wait", name], { timeout: 60_000 }), "0");
      await dockerAsync(["start", name]);
      await waitForRoot(base);
      assert.equal(await call("queries.saved"), "persisted-before-stop");
      report.drain = { durationMs: Date.now() - began, listenerClosed, completedOnce: true };
      report.checks.push("SIGTERM closes the listener and drains the admitted 16-second write");
    }
    await stop();
  }

  await dockerAsync(["volume", "rm", volume]);
  await dockerAsync(["volume", "create", volume]);
  await copyVolumeWithImage(async (holder) => {
    const descriptor = fs.openSync(backup, "r");
    try {
      await dockerStream(["cp", "-", `${holder}:/app/data`], { stdin: descriptor });
    } finally {
      fs.closeSync(descriptor);
    }
  });
  selection = { profile: profile.id };
  await start(previous, unreachableRegistry);
  assert.equal(await keyDigests(), priorKeys);
  assert.deepEqual(await call("queries.check"), { retained: true });
  assert.equal(await call("queries.kept"), "seeded-before-upgrade");
  await retainedAnalytics();
  report.checks.push(
    `previous image serves retained state${analyticsSeeded ? " and analytics" : ""} after stopped-volume restoration`,
  );
  await stop();
  report.success = true;
} catch (error) {
  report.success = false;
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  beginCleanup();
  if (running)
    try {
      writePrivate(evidence, "server-failure.log", containerLogSync(name));
    } catch {}
  settle();
}
