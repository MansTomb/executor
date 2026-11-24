import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ReleaseConfig } from "./config.ts";
import { must, run } from "./shell.ts";
import type { State } from "./state.ts";

const digestOf = (reference: string) => reference.slice(reference.indexOf("@") + 1);

const retainedUntil = (state: State) => {
  try {
    return (
      JSON.parse(readFileSync(path.join(state.evidence, ".retention.json"), "utf8")) as {
        readonly expires: string;
      }
    ).expires;
  } catch {
    return "its retention date";
  }
};

const gateSentence = (state: State) => {
  const steps = state.gates.flatMap((gate) => gate.steps);
  const listed = steps
    .map(
      (step) =>
        `${step.step} (${Math.round(step.seconds)} s${step.note === undefined ? "" : `, ${step.note}`})`,
    )
    .join(", ");
  return `The ${state.decision.lane} lane gate passed ${listed}.`;
};

const watchSentence = (state: State) => {
  const result = state.watch;
  if (result === undefined) return "";
  const memory = result.memoryMiB;
  return `The ${Math.round(result.seconds / 60)}-minute watch passed ${result.samples} samples over ${result.seconds} seconds with no restarts, replacements or OOM events${memory === undefined ? "" : `; cgroup memory ranged from ${memory.min} to ${memory.peak} MiB and ended at ${memory.final} MiB`}.`;
};

const rollbackSentence = (state: State) =>
  state.decision.schemaChanged
    ? `The storage schema changed, so rollback requires the verified pre-deploy backup and the previous image \`${digestOf(state.service.image)}\` together.`
    : `Storage is unchanged, so image-only rollback to \`${digestOf(state.service.image)}\` is valid.`;

const appsSentence = (state: State, config: ReleaseConfig) => {
  const statuses = Object.entries(state.sweeps).map(([stage, sweep]) => `${stage} ${sweep.status}`);
  const all = Object.values(state.sweeps).every((sweep) => sweep.status === "passed");
  const apps = config.reads.length + config.catalogOnly.length;
  const analytics = Object.values(state.analytics);
  const retained =
    analytics.length > 1 && analytics.every((entry) => entry.status === "available")
      ? ` The ${config.analyticsApp} analytics window matched before and after.`
      : " Analytics comparison was unavailable.";
  return `${all ? `All ${apps} connected apps passed a read or catalog check before and after the deploy and after the watch.` : `Connected-app sweeps: ${statuses.join(", ")}.`}${retained}`;
};

const managementSentence = (state: State) => {
  const management = state.management;
  if (management === undefined || management["active"] === undefined)
    return "The management app was not redeployed because its source did not change.";
  return `The management app advanced from \`${String(management["previous"])}\` to \`${String(management["active"])}\`; a fresh MCP session found ${String(management["catalog"])} management operations and loaded both skills.`;
};

export const forkSection = (state: State, config: ReleaseConfig, heading: string) =>
  [
    `## ${heading}`,
    "",
    `Dokploy deployment \`${state.switched?.job ?? "?"}\` runs source \`${state.candidate.slice(0, 9)}\` at immutable image \`${state.image?.digest ?? "?"}\`, released with \`bun run selfhost:release\` in the ${state.decision.lane} lane${state.decision.lane === "full" ? ` (${state.decision.reasons.slice(0, 3).join("; ")})` : ""}. ${rollbackSentence(state)}`,
    "",
    gateSentence(state),
    "",
    `The pre-deploy stopped-volume backup \`${state.backup?.remote ?? "?"}\` read back ${state.backup?.bytes.toLocaleString("en-US") ?? "?"} bytes with SHA-256 \`${state.backup?.sha256 ?? "?"}\`. ${appsSentence(state, config)} ${managementSentence(state)}`,
    "",
    `${watchSentence(state)} Evidence is in \`${state.evidence.replace(/^\/home\/[^/]+/, "~")}\`, retained through ${retainedUntil(state)}.`,
    "",
  ].join("\n");

const today = () => {
  const now = new Date();
  return {
    iso: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
    words: now.toLocaleDateString("en-US", { month: "long", day: "numeric" }),
  };
};

const commitFork = async (state: State, config: ReleaseConfig) => {
  const git = (args: ReadonlyArray<string>) =>
    must("git", ["-C", state.worktree, ...args], { timeoutSeconds: 120 });
  const date = today();
  for (let attempt = 0; attempt < 2; attempt++) {
    await git(["fetch", "--quiet", "origin", "selfhost"]);
    const merged = await run("git", [
      "-C",
      state.worktree,
      "merge-base",
      "--is-ancestor",
      state.candidate,
      "origin/selfhost",
    ]);
    if (merged.code !== 0)
      return { pushed: false, reason: "origin/selfhost no longer contains the released commit" };
    await git(["checkout", "--quiet", "--detach", "origin/selfhost"]);
    const file = path.join(state.worktree, "FORK.md");
    const headings = readFileSync(file, "utf8");
    const base = `Production rollout on ${date.iso}`;
    const heading = headings.includes(`## ${base}\n`)
      ? `${base} (${state.candidate.slice(0, 9)})`
      : base;
    appendFileSync(file, `\n${forkSection(state, config, heading)}`.replace(/\n+$/, "\n"));
    await git([
      "commit",
      "--quiet",
      "-m",
      `Record ${date.iso} Executor production rollout`,
      "--",
      "FORK.md",
    ]);
    const push = await run(
      "git",
      ["-C", state.worktree, "push", "--quiet", "origin", "HEAD:selfhost"],
      {
        timeoutSeconds: 120,
      },
    );
    if (push.code === 0) return { pushed: true, commit: await git(["rev-parse", "HEAD"]) };
    await git(["checkout", "--quiet", "--detach", "origin/selfhost"]);
  }
  return { pushed: false, reason: "origin/selfhost moved twice during the push" };
};

const availabilitySection = (state: State, heading: string) =>
  [
    `## ${heading}`,
    "",
    `Dokploy deployment \`${state.switched?.job ?? "?"}\` runs \`selfhost\` source \`${state.candidate.slice(0, 9)}\` at image \`${state.image?.digest ?? "?"}\` (${state.decision.lane} lane). ${rollbackSentence(state)} Pre-deploy backup \`${state.backup?.remote ?? "?"}\`, SHA-256 \`${state.backup?.sha256 ?? "?"}\`. ${watchSentence(state)} ${managementSentence(state)} The release record is in the fork's \`FORK.md\`.`,
    "",
  ].join("\n");

const commitAvailability = async (state: State, config: ReleaseConfig) => {
  const directory = path.dirname(config.availability);
  const top = await must("git", ["-C", directory, "rev-parse", "--show-toplevel"]);
  const relative = path.relative(top, config.availability);
  const git = (args: ReadonlyArray<string>) =>
    must("git", ["-C", top, ...args], { timeoutSeconds: 120 });
  if ((await git(["status", "--porcelain", "--", relative])) !== "")
    return { pushed: false, reason: `${relative} has uncommitted changes; record not written` };
  const date = today();
  appendFileSync(
    config.availability,
    `\n${availabilitySection(state, `${date.words} production rollout (${state.candidate.slice(0, 9)})`)}`.replace(
      /\n+$/,
      "\n",
    ),
  );
  await git([
    "commit",
    "--quiet",
    "--only",
    "-m",
    `executor: record ${date.iso} rollout of ${state.candidate.slice(0, 9)}`,
    "--",
    relative,
  ]);
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  await git(["fetch", "--quiet", "origin", branch]);
  const ahead = await run("git", [
    "-C",
    top,
    "merge-base",
    "--is-ancestor",
    `origin/${branch}`,
    "HEAD",
  ]);
  if (ahead.code !== 0)
    return {
      pushed: false,
      reason: `origin/${branch} advanced; the record is committed locally only`,
    };
  const push = await run("git", ["-C", top, "push", "--quiet", "origin", `HEAD:${branch}`], {
    timeoutSeconds: 120,
  });
  return push.code === 0
    ? { pushed: true, commit: await git(["rev-parse", "HEAD"]) }
    : { pushed: false, reason: push.stderr.trim() };
};

export const writeRecords = async (state: State, config: ReleaseConfig) => {
  const settle = async (task: () => Promise<Record<string, unknown>>) => {
    try {
      return await task();
    } catch (error) {
      return { pushed: false, reason: error instanceof Error ? error.message : String(error) };
    }
  };
  return {
    fork: await settle(() => commitFork(state, config)),
    availability: await settle(() => commitAvailability(state, config)),
  };
};
