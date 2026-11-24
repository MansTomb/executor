import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { defaultConfig, home, readConfig, type ReleaseConfig } from "./config.ts";
import {
  composeFingerprint,
  discoverService,
  dokployClient,
  httpStatus,
  imageSource,
  inspectContainer,
  readCompose,
  restoreVolume,
  serviceContainer,
  stoppedVolumeBackup,
  switchImage,
  waitHealthy,
  type Access,
  type Service,
} from "./dokploy.ts";
import {
  analytics,
  analyticsRetained,
  analyticsWindow,
  checkManagement,
  deployManagement,
  executorClient,
  generateManagement,
  managementDiffers,
  sweep,
} from "./executor.ts";
import { buildImage } from "./image.ts";
import { decide, describeDecision } from "./lanes.ts";
import { notify } from "./notify.ts";
import { writeRecords } from "./records.ts";
import { elapsed, must, run, sleep } from "./shell.ts";
import { loadState, saveState, type Gate, type State } from "./state.ts";
import { watch } from "./watch.ts";

const worktree = path.join(homedir(), ".cache", "executor-release");
const lockFile = path.join(worktree, ".local", "selfhost-release.lock");
const node = "mise exec node@24.22.0 --";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    commit: { type: "string", default: "origin/selfhost" },
    candidate: { type: "string" },
    full: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    workers: { type: "string" },
    config: { type: "string", default: defaultConfig },
    "notify-scope": { type: "string" },
    evidence: { type: "string" },
    restore: { type: "boolean", default: false },
    image: { type: "string" },
    previous: { type: "string" },
    "schema-changed": { type: "boolean", default: false },
    "watch-seconds": { type: "string", default: "900" },
  },
});

const say = (line: string) => process.stdout.write(`${line}\n`);

const lockHolder = () => {
  if (!existsSync(lockFile)) return undefined;
  const holder = JSON.parse(readFileSync(lockFile, "utf8")) as {
    readonly pid?: number;
    readonly unit?: string;
    readonly purpose: string;
  };
  return holder;
};

const holderAlive = async (holder: { readonly pid?: number; readonly unit?: string }) => {
  if (holder.unit !== undefined)
    return (await run("systemctl", ["--user", "is-active", "--quiet", holder.unit])).code === 0;
  if (holder.pid === undefined) return false;
  try {
    process.kill(holder.pid, 0);
    return true;
  } catch {
    return false;
  }
};

const takeLock = async (
  purpose: string,
  owner: { readonly pid?: number; readonly unit?: string },
) => {
  const holder = lockHolder();
  if (holder !== undefined && holder.pid !== process.pid && (await holderAlive(holder)))
    throw new Error(`Another release holds ${lockFile}: ${holder.purpose}`);
  mkdirSync(path.dirname(lockFile), { recursive: true });
  writeFileSync(lockFile, JSON.stringify({ ...owner, purpose }), { mode: 0o600 });
};

const dropLock = () => {
  const holder = lockHolder();
  if (
    holder !== undefined &&
    (holder.pid === process.pid || holder.unit === process.env["SELFHOST_RELEASE_UNIT"])
  )
    unlinkSync(lockFile);
};

const git = (args: ReadonlyArray<string>, cwd = worktree) =>
  must("git", ["-C", cwd, ...args], { timeoutSeconds: 300 });

const syncWorktree = async (repository: string, candidate: string) => {
  if (!existsSync(worktree))
    await git(["worktree", "add", "--detach", worktree, candidate], repository);
  const status = await git(["status", "--porcelain"]);
  if (status !== "")
    throw new Error(`The release worktree ${worktree} has uncommitted changes:\n${status}`);
  await git(["checkout", "--quiet", "--detach", candidate]);
  await must("bun", ["install", "--frozen-lockfile"], { cwd: worktree, timeoutSeconds: 900 });
};

const enter = async () => {
  const repository = path.resolve(import.meta.dirname, "../..");
  await git(["fetch", "--quiet", "origin", "selfhost"], repository);
  const candidate = await git(["rev-parse", "--verify", `${values.commit}^{commit}`], repository);
  if (
    !values["dry-run"] &&
    (
      await run("git", [
        "-C",
        repository,
        "merge-base",
        "--is-ancestor",
        candidate,
        "origin/selfhost",
      ])
    ).code !== 0
  )
    throw new Error(`${candidate.slice(0, 9)} is not on origin/selfhost; push it or use --dry-run`);
  const holder = lockHolder();
  if (holder !== undefined && (await holderAlive(holder)))
    throw new Error(`Another release holds ${lockFile}: ${holder.purpose}`);
  say(`Preparing ${worktree} at ${candidate.slice(0, 9)}`);
  await syncWorktree(repository, candidate);
  const child = spawn(
    process.execPath,
    [
      path.join(worktree, "scripts/selfhost-release/release.ts"),
      ...process.argv.slice(2),
      "--candidate",
      candidate,
    ],
    { cwd: worktree, stdio: "inherit" },
  );
  process.exitCode = await new Promise<number>((resolve) =>
    child.once("close", (code) => resolve(code ?? 1)),
  );
};

const evidenceDirectory = (config: ReleaseConfig, candidate: string, dryRun: boolean) => {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const base = path.join(
    config.evidenceRoot,
    `executor-release-${date}-${candidate.slice(0, 9)}${dryRun ? "-dry-run" : ""}`,
  );
  let directory = base;
  for (let index = 2; existsSync(directory); index++) directory = `${base}-${index}`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const expires = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  writeFileSync(
    path.join(directory, ".retention.json"),
    JSON.stringify({
      reason: `Executor ${dryRun ? "release dry run" : "release evidence and pre-deploy backup"} for ${candidate.slice(0, 9)}`,
      owner: "selfhost-release",
      expires,
      created: new Date().toISOString().slice(0, 10),
    }),
  );
  return directory;
};

const gate = async (
  state: State,
  name: string,
  steps: ReadonlyArray<string>,
  extra: ReadonlyArray<string>,
): Promise<Gate> => {
  const started = Date.now();
  const evidence = path.join(state.evidence, name);
  const output = await run(
    "node",
    ["e2e/selfhost/verify.ts", "--evidence", evidence, "--steps", steps.join(","), ...extra],
    { cwd: worktree, log: `${evidence}.log` },
  );
  const summary = existsSync(path.join(evidence, "summary.json"))
    ? (JSON.parse(readFileSync(path.join(evidence, "summary.json"), "utf8")) as {
        readonly status: string;
        readonly steps: Gate["steps"];
      })
    : { status: "failed", steps: [] };
  for (const step of summary.steps)
    say(
      `  ${name} ${step.step}: ${step.status} in ${Math.round(step.seconds)} s${step.note === undefined ? "" : ` (${step.note})`}${step.message === undefined ? "" : ` - ${step.message}`}`,
    );
  const result = {
    name,
    status: output.code === 0 && summary.status === "passed" ? "passed" : "failed",
    seconds: elapsed(started),
    steps: summary.steps,
  };
  state.gates.push(result);
  return result;
};

const recover = async (
  state: State,
  config: ReleaseConfig,
  dokploy: ReturnType<typeof dokployClient>,
  reason: string,
) => {
  const candidate = state.image?.reference ?? "";
  const previous = state.service.image;
  const restore = `cd ${worktree} && ${node} node scripts/selfhost-release/release.ts rollback --evidence ${state.evidence} --restore`;
  if (state.decision.schemaChanged) {
    state.recovery = {
      decision: "alert",
      why: "the release changed the storage schema; the previous image refuses it",
      restoreCommand: restore,
    };
  } else {
    try {
      const compose = await readCompose(dokploy, state.service.composeId);
      const result = compose.composeFile.includes(previous)
        ? {
            job: "previous image already configured",
            ...(await waitHealthy(state.service, previous)),
          }
        : await switchImage(
            dokploy,
            state.service,
            candidate,
            previous,
            `Roll back Executor to ${previous.slice(-12)}`,
            state.fingerprint ?? "",
          );
      state.recovery = { decision: "image rollback", result };
    } catch (error) {
      state.recovery = {
        decision: "image rollback failed",
        error: error instanceof Error ? error.message : String(error),
        restoreCommand: restore,
      };
    }
  }
  saveState(state);
  const notification = await notify(config, state.notifyScope, {
    failed: true,
    subject: `executor-release-${state.candidate.slice(0, 9)}`,
    title: `Executor release ${state.candidate.slice(0, 9)} failed: ${reason}`,
    data: { reason, recovery: state.recovery, evidence: state.evidence },
  });
  state.notifications.push(notification);
  saveState(state);
  say(`FAILED: ${reason}`);
  say(`Recovery: ${JSON.stringify(state.recovery)}`);
};

const release = async () => {
  const candidate = values.candidate ?? "";
  const dryRun = values["dry-run"];
  const access: Access = dryRun ? "read-only" : "mutating";
  const started = Date.now();
  await takeLock(`${dryRun ? "dry run" : "release"} of ${candidate.slice(0, 9)}`, {
    pid: process.pid,
  });
  const running = (await must("docker", ["ps", "--format", "{{.Names}}"])).split("\n");
  if (running.some((name) => name.startsWith("agent-test-")))
    throw new Error("An agent-test gate is running on this host; run one gate at a time");
  const config = readConfig(values.config);
  const dokploy = dokployClient(access);
  const executor = executorClient(access);
  const service = await discoverService(dokploy, config);
  const source = await imageSource(service.image);
  const production = await git(["rev-parse", "--verify", `${source.revision}^{commit}`]);
  say(`Production: ${service.image} from ${production.slice(0, 9)} (${source.from})`);
  if (production === candidate && !values.full) {
    say(`Nothing to release: production already runs ${candidate.slice(0, 9)}`);
    return;
  }
  let managementChanged = false;
  let managementNote = "matches the active deployment";
  try {
    managementChanged = await managementDiffers(
      executor,
      config,
      await generateManagement(worktree, service.origin),
    );
    if (managementChanged) managementNote = "differs from the active deployment";
  } catch (error) {
    managementChanged = true;
    managementNote = `could not be compared: ${error instanceof Error ? error.message : String(error)}`;
  }
  const decision = await decide({
    worktree,
    production,
    candidate,
    forceFull: values.full,
    managementChanged,
  });
  say(describeDecision(decision));
  say(`Management app source ${managementNote}`);
  const evidence = evidenceDirectory(config, candidate, dryRun);
  const state: State = {
    dryRun,
    evidence,
    worktree,
    config: values.config,
    notifyScope: values["notify-scope"] ?? config.notify.scope,
    candidate,
    production: { source: production, sourceFrom: source.from },
    service,
    decision,
    timings: {},
    gates: [],
    sweeps: {},
    analytics: {},
    notifications: [],
  };
  saveState(state);
  say(`Evidence: ${evidence}`);
  const workers = values.workers ?? (decision.lane === "light" ? "4" : "2");
  const scenarios =
    decision.scenarios.length > 0 ? ["--scenarios", decision.scenarios.join(",")] : [];
  const onSelfhost =
    (
      await run("git", [
        "-C",
        worktree,
        "merge-base",
        "--is-ancestor",
        candidate,
        "origin/selfhost",
      ])
    ).code === 0;
  const phase = Date.now();
  say("Building the image and running the source gate together");
  const [built, sourceGate] = await Promise.allSettled([
    buildImage({
      worktree,
      candidate,
      repository: service.repository,
      tagPrefix: onSelfhost ? "selfhost" : "candidate",
      sourceUrl: config.sourceUrl,
      log: path.join(evidence, "image.log"),
      metadata: path.join(evidence, "image-metadata.json"),
    }),
    gate(state, "gate-source", decision.sourceSteps, [...scenarios, "--workers", workers]),
  ]);
  state.timings["imageAndSourceGate"] = elapsed(phase);
  if (built.status === "fulfilled") {
    state.image = built.value;
    say(
      `  image: ${built.value.reference} in ${built.value.seconds} s (${built.value.cachedSteps} cached, ${built.value.builtSteps} built steps)`,
    );
  }
  saveState(state);
  if (built.status === "rejected") throw new Error(`Image build failed: ${String(built.reason)}`);
  if (sourceGate.status === "rejected" || sourceGate.value.status !== "passed")
    throw new Error(`The source gate failed; see ${path.join(evidence, "gate-source")}`);
  const imagePhase = Date.now();
  const imageGate = await gate(state, "gate-image", decision.imageSteps, [
    "--image",
    built.value.reference,
    "--previous",
    service.image,
  ]);
  state.timings["imageGate"] = elapsed(imagePhase);
  state.timings["gateTotal"] = elapsed(started);
  saveState(state);
  if (imageGate.status !== "passed")
    throw new Error(`The image gate failed; see ${path.join(evidence, "gate-image")}`);
  if (dryRun) {
    say(
      `Dry run passed in ${elapsed(started)} s: ${decision.lane} lane, image ${built.value.reference} pushed. Stopped before the backup and the switch.`,
    );
    return;
  }
  await rollOut(state, config, dokploy, executor, started);
};

const rollOut = async (
  state: State,
  config: ReleaseConfig,
  dokploy: ReturnType<typeof dokployClient>,
  executor: ReturnType<typeof executorClient>,
  started: number,
) => {
  const image = state.image;
  if (image === undefined) throw new Error("No candidate image");
  const service: Service = state.service;
  const window = analyticsWindow();
  state.analyticsWindow = window;
  const [baseline, analyticsBefore] = await Promise.all([
    sweep(executor, config),
    analytics(executor, config, window),
  ]);
  state.sweeps["before"] = baseline;
  state.analytics["before"] = analyticsBefore;
  saveState(state);
  if (baseline.status !== "passed")
    throw new Error(
      `The connected-app baseline did not pass (${baseline.status}); nothing changed`,
    );
  await waitHealthy(service, service.image);
  state.fingerprint = composeFingerprint(
    await readCompose(dokploy, service.composeId),
    service,
    service.image,
  );
  const backupStarted = Date.now();
  say("Backing up the stopped volume");
  state.backup = await stoppedVolumeBackup(
    dokploy,
    service,
    config,
    service.image,
    path.join(state.evidence, "pre-server.tar"),
  );
  state.timings["backup"] = elapsed(backupStarted);
  saveState(state);
  say(
    `  backup ${state.backup.remote} (${state.backup.bytes} bytes, sha256 ${state.backup.sha256})`,
  );
  const switchStarted = Date.now();
  try {
    say(`Switching Executor to ${image.reference}`);
    const switched = await switchImage(
      dokploy,
      service,
      service.image,
      image.reference,
      `Executor ${state.candidate.slice(0, 9)} (${state.decision.lane} lane)`,
      state.fingerprint,
    );
    state.switched = { job: switched.job, container: switched.id };
    state.timings["switch"] = elapsed(switchStarted);
    saveState(state);
    const [after, analyticsAfter] = await Promise.all([
      sweep(executor, config),
      analytics(executor, config, window),
    ]);
    state.sweeps["after"] = after;
    state.analytics["after"] = analyticsAfter;
    saveState(state);
    if (after.status !== "passed") throw new Error(`the connected-app sweep ${after.status}`);
    if (
      analyticsBefore.status === "available" &&
      !analyticsRetained(analyticsBefore, analyticsAfter)
    )
      throw new Error("the analytics window changed across the switch");
    if (state.decision.managementChanged) {
      say("Backing up the volume before the management app deploy");
      const preApp = await stoppedVolumeBackup(
        dokploy,
        service,
        config,
        image.reference,
        path.join(state.evidence, "pre-app.tar"),
      );
      const generated = await generateManagement(worktree, service.origin);
      const deployed = await deployManagement(
        executor,
        config,
        generated,
        `selfhost ${state.candidate.slice(0, 9)}`,
      );
      const live = await serviceContainer(service);
      state.switched = { job: state.switched.job, container: live?.id ?? state.switched.container };
      state.management = {
        preAppBackup: preApp,
        ...deployed,
        ...(await checkManagement(executor, generated, deployed.active)),
      };
      saveState(state);
    }
  } catch (error) {
    await recover(state, config, dokploy, error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  state.timings["release"] = elapsed(started);
  saveState(state);
  const rollback = `cd ${worktree} && ${node} node scripts/selfhost-release/release.ts rollback --evidence ${state.evidence}${state.decision.schemaChanged ? " --restore" : ""}`;
  say(
    `Released ${image.reference} (Dokploy deployment ${state.switched?.job ?? "?"}) in ${elapsed(started)} s`,
  );
  say(
    `Backup: ${state.backup.remote}, sha256 ${state.backup.sha256}, local copy ${state.backup.archive}`,
  );
  say(`Rollback: ${rollback}`);
  const unit = `executor-release-watch-${state.candidate.slice(0, 9)}-${Date.now().toString(36)}`;
  await must("systemd-run", [
    "--user",
    `--unit=${unit}`,
    "--collect",
    `--working-directory=${worktree}`,
    `--setenv=PATH=${process.env["PATH"] ?? ""}`,
    `--setenv=HOME=${homedir()}`,
    `--setenv=SELFHOST_RELEASE_UNIT=${unit}.service`,
    process.execPath,
    path.join(worktree, "scripts/selfhost-release/release.ts"),
    "watch",
    "--evidence",
    state.evidence,
  ]);
  await takeLock(`15-minute watch of ${state.candidate.slice(0, 9)}`, { unit: `${unit}.service` });
  say(`Watching for 15 minutes in the background: journalctl --user -u ${unit} -f`);
  say(
    "The watcher notifies the funnel either way and writes the FORK.md and availability records on success.",
  );
};

const productionWatch = async () => {
  const evidence = values.evidence ?? "";
  const state = loadState(evidence);
  const config = readConfig(state.config);
  const dokploy = dokployClient("mutating");
  const executor = executorClient("read-only");
  const service = state.service;
  const window = state.analyticsWindow ?? analyticsWindow();
  const checks = (async () => {
    const [after, analyticsAfter] = await Promise.all([
      sweep(executor, config),
      analytics(executor, config, window),
    ]);
    state.sweeps["afterWatch"] = after;
    state.analytics["afterWatch"] = analyticsAfter;
    if (after.status !== "passed") return `the connected-app sweep ${after.status}`;
    const before = state.analytics["before"];
    if (before?.status === "available" && !analyticsRetained(before, analyticsAfter))
      return "the analytics window changed";
    return undefined;
  })();
  const result = await watch({
    target: {
      state: async () => {
        const live = await serviceContainer(service);
        return live?.image === state.image?.reference ? live : undefined;
      },
      health: () => httpStatus(`${service.origin}/`),
    },
    seconds: Number(values["watch-seconds"]),
    interval: 15,
    trace: path.join(evidence, "watch.jsonl"),
    checks,
  });
  state.watch = result;
  saveState(state);
  say(JSON.stringify(result));
  if (!result.passed) {
    await recover(state, config, dokploy, `watch: ${result.failure ?? "failed"}`);
    process.exitCode = 1;
  } else {
    state.records = await writeRecords(state, config);
    saveState(state);
    state.notifications.push(
      await notify(config, state.notifyScope, {
        failed: false,
        subject: `executor-release-${state.candidate.slice(0, 9)}`,
        title: `Executor release ${state.candidate.slice(0, 9)} passed its 15-minute watch`,
        data: { image: state.image?.reference, watch: result, records: state.records, evidence },
      }),
    );
    saveState(state);
  }
  dropLock();
};

const rollbackCommand = async () => {
  const state = loadState(values.evidence ?? "");
  const config = readConfig(state.config);
  const dokploy = dokployClient("mutating");
  const candidate = state.image?.reference ?? "";
  const previous = state.service.image;
  if (values.restore) {
    if (state.backup === undefined) throw new Error("The evidence has no pre-deploy backup");
    await restoreVolume(
      dokploy,
      state.service,
      state.backup,
      path.join(state.evidence, "candidate-volume-after-failure"),
    );
  }
  const compose = await readCompose(dokploy, state.service.composeId);
  const result = compose.composeFile.includes(previous)
    ? await (async () => {
        await must("docker", ["pull", "--quiet", previous], { timeoutSeconds: 900 });
        await dokploy.post("compose.deploy", {
          composeId: state.service.composeId,
          title: "Restore previous Executor",
          freshVolumes: false,
        });
        return waitHealthy(state.service, previous);
      })()
    : await switchImage(
        dokploy,
        state.service,
        candidate,
        previous,
        values.restore ? "Restore previous Executor and volume" : "Roll back Executor image",
        state.fingerprint ?? "",
      );
  state.recovery = { decision: values.restore ? "restore" : "image rollback", result };
  saveState(state);
  say(`Rolled back to ${previous}: ${JSON.stringify(result)}`);
  state.notifications.push(
    await notify(config, state.notifyScope, {
      failed: true,
      subject: `executor-release-${state.candidate.slice(0, 9)}`,
      title: `Executor rolled back to ${previous.slice(-12)}${values.restore ? " with the pre-deploy volume" : ""}`,
      data: state.recovery,
    }),
  );
  saveState(state);
};

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        resolve(typeof address === "object" && address !== null ? address.port : 0),
      );
    });
  });

const rehearseWatch = async () => {
  const config = readConfig(values.config);
  const candidate = values.image ?? "";
  const previous = values.previous ?? "";
  if (candidate === "" || previous === "") throw new Error("Pass --image and --previous");
  const suffix = Date.now().toString(36);
  const name = `agent-test-executor-watch-${suffix}`;
  const volume = `${name}-data`;
  const port = await freePort();
  const evidence = home(
    values.evidence ?? path.join(config.evidenceRoot, `executor-watch-rehearsal-${suffix}`),
  );
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const start = (image: string) =>
    must("docker", [
      "run",
      "-d",
      "--name",
      name,
      "--memory",
      "4g",
      "-p",
      `127.0.0.1:${port}:4400`,
      "-v",
      `${volume}:/app/data`,
      "-e",
      `BETTER_AUTH_URL=http://127.0.0.1:${port}`,
      "-e",
      "DO_NOT_TRACK=1",
      image,
    ]);
  const healthy = async (image: string) => {
    const end = Date.now() + 240_000;
    while (Date.now() < end) {
      const live = await inspectContainer(name);
      if (live?.image === image && live.health === "healthy") return live;
      await sleep(3);
    }
    throw new Error(`${name} did not become healthy on ${image}`);
  };
  try {
    await start(candidate);
    await healthy(candidate);
    say(
      `Watching ${name} on ${candidate} for ${values["watch-seconds"]} s; kill it to rehearse a failure`,
    );
    const result = await watch({
      target: {
        state: async () => {
          const live = await inspectContainer(name);
          return live?.image === candidate ? live : undefined;
        },
        health: () => httpStatus(`http://127.0.0.1:${port}/`),
      },
      seconds: Number(values["watch-seconds"]),
      interval: 5,
      trace: path.join(evidence, "watch.jsonl"),
    });
    say(JSON.stringify(result));
    const schemaChanged = values["schema-changed"];
    const recovery = result.passed
      ? undefined
      : schemaChanged
        ? { decision: "alert", why: "the release changed the storage schema; no automatic restore" }
        : await (async () => {
            await must("docker", ["rm", "--force", name]);
            await start(previous);
            const live = await healthy(previous);
            return {
              decision: "image rollback",
              container: live.id.slice(0, 12),
              image: live.image,
            };
          })();
    say(`Recovery: ${JSON.stringify(recovery ?? "none needed")}`);
    const notification = await notify(config, values["notify-scope"] ?? "background", {
      failed: !result.passed,
      subject: `executor-watch-rehearsal-${suffix}`,
      title: result.passed
        ? `Executor watch rehearsal ${suffix} passed`
        : `Executor watch rehearsal ${suffix} failed: ${result.failure ?? ""}`,
      data: { rehearsal: true, container: name, watch: result, recovery: recovery ?? null },
    });
    say(`Notification: ${JSON.stringify(notification)}`);
    writeFileSync(
      path.join(evidence, "rehearsal.json"),
      `${JSON.stringify({ name, candidate, previous, schemaChanged, result, recovery, notification }, null, 2)}\n`,
    );
  } finally {
    await run("docker", ["rm", "--force", "--volumes", name]);
    await run("docker", ["volume", "rm", volume]);
  }
};

const main = async () => {
  if (!process.versions.node.startsWith("24."))
    throw new Error(`Run with Node 24, for example: ${node} bun run selfhost:release`);
  const [command = "release"] = positionals;
  if (command === "watch") return productionWatch();
  if (command === "rollback") return rollbackCommand();
  if (command === "rehearse-watch") return rehearseWatch();
  if (command !== "release") throw new Error(`Unknown command ${command}`);
  if (values.candidate === undefined) return enter();
  try {
    await release();
  } finally {
    const holder = lockHolder();
    if (holder?.pid === process.pid) dropLock();
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
