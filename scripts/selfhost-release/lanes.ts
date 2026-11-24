import path from "node:path";
import {
  focused,
  pathRules,
  runTarget,
  scenariosInFile,
  smoke,
  type PathRule,
  type ScenarioKey,
} from "../../e2e/selfhost/release-scenarios.ts";
import { scenarios } from "../../e2e/test-plan.ts";
import { must, run } from "./shell.ts";

export type Lane = "light" | "full";

export type PathDecision = {
  readonly path: string;
  readonly kind: PathRule["kind"] | "unclassified";
  readonly reason: string;
  readonly scenarios: ReadonlyArray<ScenarioKey>;
};

export type Decision = {
  readonly production: string;
  readonly candidate: string;
  readonly lane: Lane;
  readonly reasons: ReadonlyArray<string>;
  readonly schemaChanged: boolean;
  readonly managementChanged: boolean;
  readonly paths: ReadonlyArray<PathDecision>;
  readonly scenarios: ReadonlyArray<ScenarioKey>;
  readonly sourceSteps: ReadonlyArray<string>;
  readonly imageSteps: ReadonlyArray<string>;
};

const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

export const matches = (pattern: string, file: string) => {
  if (pattern.endsWith("/")) return file.startsWith(pattern);
  const source = pattern
    .split("**/")
    .map((part) => part.split("*").map(escape).join("[^/]*"))
    .join("(?:.*/)?");
  return new RegExp(`^${source}$`).test(file);
};

const ruleFor = (file: string) =>
  pathRules.find((rule) => rule.paths.some((pattern) => matches(pattern, file)));

const git = (worktree: string, args: ReadonlyArray<string>) =>
  must("git", ["-C", worktree, ...args], { timeoutSeconds: 60 });

const show = async (worktree: string, revision: string, file: string) => {
  const output = await run("git", ["-C", worktree, "show", `${revision}:${file}`]);
  return output.code === 0 ? output.stdout : undefined;
};

const runnable = (keys: ReadonlyArray<ScenarioKey>) =>
  keys.filter((key) => runTarget(key) !== undefined);

const manifest = async (
  worktree: string,
  production: string,
  candidate: string,
  file: string,
): Promise<PathDecision> => {
  const [before, after] = await Promise.all([
    show(worktree, production, file),
    show(worktree, candidate, file),
  ]);
  if (before === undefined || after === undefined)
    return { path: file, kind: "full", reason: "package manifest added or removed", scenarios: [] };
  const parse = (text: string) => JSON.parse(text) as Record<string, unknown>;
  const left = parse(before);
  const right = parse(after);
  const fields = [...new Set([...Object.keys(left), ...Object.keys(right)])].filter(
    (field) => JSON.stringify(left[field]) !== JSON.stringify(right[field]),
  );
  return fields.every((field) => field === "scripts")
    ? { path: file, kind: "untested", reason: "package scripts only", scenarios: [] }
    : {
        path: file,
        kind: "full",
        reason: `package manifest changes ${fields.join(", ")}`,
        scenarios: [],
      };
};

const planScenarios = async (worktree: string, production: string, candidate: string) => {
  const diff = await git(worktree, [
    "diff",
    "-U0",
    production,
    candidate,
    "--",
    "e2e/test-plan.ts",
  ]);
  const lines = ((await show(worktree, candidate, "e2e/test-plan.ts")) ?? "").split("\n");
  const known = new Set(Object.keys(scenarios));
  const keys = new Set<ScenarioKey>();
  let outside = false;
  for (const hunk of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Math.max(1, Number(hunk[2]));
    for (let line = start; line < start + count; line++) {
      let key: string | undefined;
      for (let index = Math.min(line, lines.length) - 1; index >= 0; index--) {
        const text = lines[index] ?? "";
        const entry = /^ {2}([A-Za-z0-9_]+): \{/.exec(text);
        if (entry !== null) {
          key = entry[1];
          break;
        }
        if (/^\S/.test(text)) break;
      }
      if (key !== undefined && known.has(key)) keys.add(key as ScenarioKey);
      else outside = true;
    }
  }
  return { keys: runnable([...keys]), outside };
};

const storageVersion = async (worktree: string, revision: string) =>
  /orm\("([\d.]+)"\)/.exec(
    (await show(worktree, revision, "packages/sdk/src/implementation/database.ts")) ?? "",
  )?.[1];

const classify = async (
  worktree: string,
  production: string,
  candidate: string,
  file: string,
): Promise<PathDecision> => {
  const rule = ruleFor(file);
  if (rule === undefined)
    return { path: file, kind: "unclassified", reason: "no rule maps this path", scenarios: [] };
  if (rule.kind === "manifest") return manifest(worktree, production, candidate, file);
  if (rule.kind === "spec")
    return {
      path: file,
      kind: "spec",
      reason: rule.reason,
      scenarios: scenariosInFile(path.basename(file)),
    };
  if (rule.kind === "plan") {
    const plan = await planScenarios(worktree, production, candidate);
    return {
      path: file,
      kind: "plan",
      reason: plan.outside
        ? `${rule.reason}, including shared plan settings`
        : `${rule.reason}: ${plan.keys.join(", ") || "no runnable scenario"}`,
      scenarios: plan.keys,
    };
  }
  return {
    path: file,
    kind: rule.kind,
    reason: rule.reason,
    scenarios: rule.kind === "scenarios" ? runnable(rule.scenarios) : [],
  };
};

export const decide = async (options: {
  readonly worktree: string;
  readonly production: string;
  readonly candidate: string;
  readonly forceFull: boolean;
  readonly managementChanged: boolean;
}): Promise<Decision> => {
  const { worktree, production, candidate } = options;
  const files = (
    await git(worktree, ["diff", "--name-only", "--no-renames", production, candidate])
  )
    .split("\n")
    .filter((line) => line !== "");
  const paths = await Promise.all(
    files.map((file) => classify(worktree, production, candidate, file)),
  );
  const descends =
    (await run("git", ["-C", worktree, "merge-base", "--is-ancestor", production, candidate]))
      .code === 0;
  const merges = descends
    ? (await git(worktree, ["rev-list", "--merges", `${production}..${candidate}`]))
        .split("\n")
        .filter((line) => line !== "")
    : [];
  const [versionBefore, versionAfter] = await Promise.all([
    storageVersion(worktree, production),
    storageVersion(worktree, candidate),
  ]);
  const schemaPaths = paths.filter((entry) => entry.kind === "schema");
  const schemaChanged = schemaPaths.length > 0 || versionBefore !== versionAfter;
  const reasons = [
    ...(options.forceFull ? ["--full was given"] : []),
    ...(descends
      ? []
      : [`${candidate.slice(0, 9)} does not contain production ${production.slice(0, 9)}`]),
    ...(merges.length > 0
      ? [`merge commits ${merges.map((merge) => merge.slice(0, 9)).join(", ")}`]
      : []),
    ...(versionBefore !== versionAfter
      ? [`storage version ${versionBefore ?? "?"} -> ${versionAfter ?? "?"}`]
      : []),
    ...(options.managementChanged
      ? ["the default Executor management app source differs from its active deployment"]
      : []),
    ...paths
      .filter((entry) => ["schema", "full", "unclassified"].includes(entry.kind))
      .map((entry) => `${entry.path}: ${entry.reason}`),
  ];
  const lane: Lane = reasons.length > 0 ? "full" : "light";
  const own = paths.flatMap((entry) => entry.scenarios);
  const tested = paths.some((entry) => ["scenarios", "spec", "plan"].includes(entry.kind));
  const selected = [
    ...new Set(lane === "full" ? [...focused, ...own] : tested ? [...own, ...smoke] : []),
  ];
  return {
    production,
    candidate,
    lane,
    reasons,
    schemaChanged,
    managementChanged: options.managementChanged,
    paths,
    scenarios: selected,
    sourceSteps:
      lane === "full"
        ? ["prepare", "check", "focused"]
        : selected.length > 0
          ? ["prepare", "check", "focused"]
          : ["check"],
    imageSteps: lane === "full" ? ["go", "upgrade", "soak"] : ["upgrade"],
  };
};

export const describeDecision = (decision: Decision) => {
  const lines = [
    `Lane: ${decision.lane} (production ${decision.production.slice(0, 9)} -> candidate ${decision.candidate.slice(0, 9)})`,
    ...(decision.lane === "full"
      ? decision.reasons.map((reason) => `  full because ${reason}`)
      : ["  light: no schema, dependency, image, runtime, management-app or unmapped change"]),
    `Schema changed: ${decision.schemaChanged ? "yes (watch failure alerts, no automatic restore)" : "no (watch failure rolls the image back)"}`,
    "Changed paths:",
    ...decision.paths.map(
      (entry) =>
        `  ${entry.path}: ${entry.kind}, ${entry.reason}${entry.scenarios.length > 0 ? ` -> ${entry.scenarios.join(", ")}` : ""}`,
    ),
    decision.scenarios.length === 0
      ? "Scenarios: nothing to test beyond check and the image upgrade"
      : `Scenarios (${decision.scenarios.length}): ${decision.scenarios.join(", ")}`,
    `Gate: ${[...decision.sourceSteps, "image", ...decision.imageSteps].join(", ")}`,
  ];
  return lines.join("\n");
};
