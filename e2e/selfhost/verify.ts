import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Cause,
  Clock,
  Console,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Schema,
  Stream,
} from "effect";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { localNpmRegistry } from "../support/npm-registry.ts";
import { scenarios } from "../test-plan.ts";

const stepNames = ["prepare", "check", "focused", "image", "go", "upgrade", "soak"] as const;
type StepName = (typeof stepNames)[number];

const deadlines = {
  prepare: Duration.minutes(15),
  check: Duration.minutes(15),
  focused: Duration.minutes(45),
  image: Duration.minutes(30),
  go: Duration.minutes(10),
  upgrade: Duration.minutes(10),
  soak: Duration.minutes(25),
} as const satisfies Record<StepName, Duration.Duration>;

const childKillGrace = Duration.seconds(90);
const cleanupBudget = Duration.seconds(60);

const focused = [
  {
    target: "self-host",
    scenarios: [
      scenarios.appWorkerLifetime,
      scenarios.mcpDiscoverySelection,
      scenarios.mcpDiscoverySchemas,
      scenarios.mcpExecuteReach,
      scenarios.mcpResultContract,
      scenarios.thrownAppError,
      scenarios.mutationTimeoutBoundary,
      scenarios.expiredAccountBoundary,
      scenarios.observabilityOutcomes,
      scenarios.appFetchUnsupportedOption,
      scenarios.mcpInterceptor,
      scenarios.clickupFresh,
      scenarios.openapiPaths,
      scenarios.sharedAuthorization,
      scenarios.apiGrantRestrictions,
      scenarios.liveGrantRestrictions,
      scenarios.readOnlyGrantLiveKind,
      scenarios.toolCallHeldCheck,
      scenarios.toolCallHeldAccess,
      scenarios.patMcpApprovals,
      scenarios.scopedConnectionAccess,
      scenarios.scopedConnectionProfiles,
      scenarios.activeDeploymentTools,
      scenarios.activeDeploymentResume,
    ],
  },
  { target: "local", scenarios: [scenarios.analytics] },
] as const;

const nativeDirectory = "apps/hosted/self-host/native";
const helpers = "scripts/selfhost-verify";

class VerificationFailed extends Schema.TaggedError<VerificationFailed>()("VerificationFailed", {
  step: Schema.String,
  message: Schema.String,
}) {}

interface StepResult {
  readonly step: string;
  readonly status: "passed" | "failed";
  readonly seconds: number;
  readonly log: string;
  readonly message?: string;
  readonly note?: string;
}

type Validation =
  | { readonly kind: "valid"; readonly note?: string }
  | { readonly kind: "invalid"; readonly message: string };

const UpgradeReport = Schema.Struct({
  success: Schema.Boolean,
  analyticsSeeded: Schema.Boolean,
  previousAppsVersion: Schema.optional(Schema.String),
});

const SoakReport = Schema.Struct({
  passed: Schema.Boolean,
  workload: Schema.Struct({
    deployments: Schema.Number,
    sessions: Schema.Number,
    searches: Schema.Number,
  }),
  sessionDelete: Schema.Record(Schema.String, Schema.Number),
});

const validateUpgrade = (output: string): Validation => {
  const line = output.trim().split("\n").at(-1) ?? "";
  const report = Schema.decodeUnknownOption(Schema.fromJsonString(UpgradeReport))(line);
  if (Option.isNone(report))
    return { kind: "invalid", message: "The upgrade helper printed no readable report" };
  if (!report.value.success)
    return { kind: "invalid", message: "The upgrade helper reported failure" };
  return {
    kind: "valid",
    note: report.value.analyticsSeeded
      ? "analytics retention verified"
      : "analytics retention not verified: the previous framework exposes no authored analytics",
  };
};

const validateSoak = (output: string): Validation => {
  const report = Schema.decodeUnknownOption(Schema.fromJsonString(SoakReport))(output);
  if (Option.isNone(report))
    return { kind: "invalid", message: "The soak helper printed no readable report" };
  if (!report.value.passed) return { kind: "invalid", message: "The soak helper reported failure" };
  const { workload, sessionDelete } = report.value;
  return {
    kind: "valid",
    note: `${workload.deployments} deployments, ${workload.sessions} sessions, ${workload.searches} searches; session DELETE answered ${JSON.stringify(sessionDelete)}`,
  };
};

const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const withoutColor = (text: string) =>
  text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");

const verify = Effect.fn("selfhostVerify.verify")(function* (options: {
  readonly evidence: string;
  readonly previous: string;
  readonly previousApi: string;
  readonly image: string;
  readonly steps: string;
  readonly workers: number;
  readonly deadlineSeconds: Option.Option<number>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const selected = new Set<StepName>();
  for (const name of options.steps.split(",").map((value) => value.trim())) {
    const step = stepNames.find((candidate) => candidate === name);
    if (step === undefined)
      return yield* new VerificationFailed({
        step: "options",
        message: `Unknown step ${name}; choose from ${stepNames.join(", ")}`,
      });
    selected.add(step);
  }
  if (selected.has("upgrade") && !/@sha256:[0-9a-f]{64}$/.test(options.previous))
    return yield* new VerificationFailed({
      step: "options",
      message: "--previous must be an immutable image reference ending in @sha256:<digest>",
    });
  if (
    (selected.has("upgrade") || selected.has("soak")) &&
    options.image === "" &&
    !selected.has("image")
  )
    return yield* new VerificationFailed({
      step: "options",
      message: "Pass --image, or include the image step to build one from this checkout",
    });
  if (yield* fs.exists(options.evidence))
    return yield* new VerificationFailed({
      step: "options",
      message: "--evidence must name a directory that does not exist yet",
    });
  const evidence = path.resolve(options.evidence);
  yield* fs.makeDirectory(evidence, { recursive: true, mode: 0o700 });

  const suffix = (yield* Clock.currentTimeMillis).toString(36);
  const results: StepResult[] = [];
  const writeSummary = (status: "incomplete" | "passed" | "failed", failure?: string) =>
    fs
      .writeFileString(
        path.join(evidence, "summary.json"),
        `${JSON.stringify({ status, ...(failure === undefined ? {} : { failure }), steps: results }, null, 2)}\n`,
        { mode: 0o600 },
      )
      .pipe(Effect.orDie);
  const record = (result: StepResult) =>
    Effect.suspend(() => {
      results.push(result);
      return writeSummary("incomplete");
    });
  const cleanupFailures: string[] = [];
  const cleanupFailed = (message: string) =>
    Effect.suspend(() => {
      cleanupFailures.push(message);
      return fs
        .writeFileString(path.join(evidence, "cleanup.log"), `${message}\n`, {
          flag: "a",
          mode: 0o600,
        })
        .pipe(Effect.ignore);
    });
  const cleanupDocker = (what: string, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const child = yield* processes.spawn(
        ChildProcess.make("docker", args, {
          extendEnv: true,
          stdout: "pipe",
          stderr: "pipe",
          killSignal: "SIGKILL",
        }),
      );
      const [output, code] = yield* Effect.all(
        [
          Stream.merge(child.stdout, child.stderr).pipe(Stream.decodeText(), Stream.mkString),
          child.exitCode,
        ],
        { concurrency: 2 },
      );
      return { output, code: Number(code) };
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption(cleanupBudget),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            cleanupFailed(`${what}: no answer within ${Duration.toSeconds(cleanupBudget)} seconds`),
          onSome: ({ output, code }) =>
            code === 0 || /No such (container|image)/i.test(output)
              ? Effect.void
              : cleanupFailed(`${what}: exited ${code}: ${output.trim().slice(0, 300)}`),
        }),
      ),
      Effect.catchCause((cause) =>
        cleanupFailed(`${what}: ${Cause.pretty(cause).split("\n")[0] ?? ""}`),
      ),
    );
  const deadlineFor = (step: StepName) =>
    Option.match(options.deadlineSeconds, {
      onNone: () => deadlines[step],
      onSome: Duration.seconds,
    });

  const execute = (spec: {
    readonly step: string;
    readonly deadline: StepName;
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env?: Record<string, string>;
    readonly validate?: (output: string) => Validation;
  }) =>
    Effect.gen(function* () {
      const { step } = spec;
      const log = `${step}.log`;
      const deadline = deadlineFor(spec.deadline);
      const started = yield* Clock.currentTimeMillis;
      yield* Console.log(`${step}: started`);
      yield* fs.writeFileString(path.join(evidence, log), "", { mode: 0o600 });
      const exit = yield* Effect.gen(function* () {
        const child = yield* processes.spawn(
          ChildProcess.make(spec.command, spec.args, {
            extendEnv: true,
            env: { NO_COLOR: "1", ...spec.env },
            stdout: "pipe",
            stderr: "pipe",
            killSignal: "SIGTERM",
            forceKillAfter: childKillGrace,
          }),
        );
        yield* Stream.merge(child.stdout, child.stderr).pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) =>
            fs.writeFileString(path.join(evidence, log), chunk, { flag: "a" }),
          ),
        );
        return Number(yield* child.exitCode);
      }).pipe(Effect.scoped, Effect.timeoutOption(deadline));
      const seconds = ((yield* Clock.currentTimeMillis) - started) / 1000;
      const { failure, note } = yield* Option.match(exit, {
        onNone: () =>
          Effect.succeed({
            failure: `Exceeded the ${Duration.toSeconds(deadline)}-second deadline; see ${log}`,
            note: undefined,
          }),
        onSome: (code) =>
          code !== 0
            ? Effect.succeed({ failure: `Exited ${code}; see ${log}`, note: undefined })
            : Effect.gen(function* () {
                const validation = spec.validate?.(
                  yield* fs.readFileString(path.join(evidence, log)),
                );
                return validation?.kind === "invalid"
                  ? { failure: validation.message, note: undefined }
                  : { failure: undefined, note: validation?.note };
              }),
      });
      yield* record({
        step,
        status: failure === undefined ? "passed" : "failed",
        seconds,
        log,
        ...(failure === undefined ? {} : { message: failure }),
        ...(note === undefined ? {} : { note }),
      });
      yield* Console.log(`${step}: ${failure === undefined ? "passed" : "failed"} in ${seconds}s`);
      if (failure !== undefined) return yield* new VerificationFailed({ step, message: failure });
    });

  const steps = Effect.gen(function* () {
    if (selected.has("prepare"))
      yield* execute({
        step: "prepare",
        deadline: "prepare",
        command: "bun",
        args: ["run", "e2e:prepare"],
      });
    if (selected.has("check"))
      yield* execute({
        step: "check",
        deadline: "check",
        command: "bun",
        args: ["run", "check"],
      });
    if (selected.has("focused"))
      for (const group of focused) {
        const pattern = `^(${group.scenarios.map((scenario) => escapePattern(scenario.title)).join("|")})$`;
        yield* execute({
          step: `focused-${group.target}`,
          deadline: "focused",
          command: "node",
          args: [
            "e2e/run.ts",
            "--target",
            group.target,
            "--test-name",
            pattern,
            "--workers",
            String(options.workers),
          ],
          validate: (output) => {
            const counts = /Tests\s+(\d+) passed(?: \| \d+ skipped)? \((\d+)\)/.exec(
              withoutColor(output),
            );
            return counts !== null && counts[1] === String(group.scenarios.length)
              ? { kind: "valid", note: `${counts[1]} scenarios passed` }
              : {
                  kind: "invalid",
                  message: `Expected ${group.scenarios.length} passing scenarios; ${counts?.[0] ?? "no summary"} reported`,
                };
          },
        });
      }

    let candidate = options.image;
    if (selected.has("image") && candidate === "") {
      const tag = `executor-selfhost:verify-${suffix}`;
      const version = (yield* processes.string(
        ChildProcess.make("git", ["rev-parse", "HEAD"]),
      )).trim();
      yield* Effect.addFinalizer(() => cleanupDocker(`remove image ${tag}`, ["image", "rm", tag]));
      yield* execute({
        step: "image",
        deadline: "image",
        command: "docker",
        args: [
          "build",
          "--file",
          "apps/hosted/self-host/Dockerfile",
          "--build-arg",
          `EXECUTOR_BUILD_VERSION=${version}`,
          "--tag",
          tag,
          ".",
        ],
      });
      candidate = tag;
    }

    if (selected.has("go")) {
      const dockerfile = yield* fs.readFileString("apps/hosted/self-host/Dockerfile");
      const golang = /^FROM (golang:\S+) AS native$/m.exec(dockerfile)?.[1];
      if (golang === undefined)
        return yield* new VerificationFailed({
          step: "go",
          message: "The Dockerfile names no golang native stage",
        });
      const container = `agent-test-executor-go-${suffix}`;
      yield* Effect.addFinalizer(() =>
        cleanupDocker(`remove container ${container}`, ["rm", "--force", "--volumes", container]),
      );
      yield* execute({
        step: "go",
        deadline: "go",
        command: "docker",
        args: [
          "run",
          "--rm",
          "--name",
          container,
          "--user",
          `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
          "--env",
          "HOME=/tmp",
          "--env",
          "GOCACHE=/tmp/go-build",
          "--volume",
          `${path.resolve(nativeDirectory)}:/src:ro`,
          "--workdir",
          "/src",
          golang,
          "go",
          "test",
          "-count=1",
          "./...",
        ],
      });
    }

    if (selected.has("upgrade"))
      yield* execute({
        step: "upgrade",
        deadline: "upgrade",
        command: "node",
        args: [
          `${helpers}/upgrade-drain.mjs`,
          "--previous",
          options.previous,
          "--previous-api",
          options.previousApi,
          "--candidate",
          candidate,
          "--evidence",
          path.join(evidence, "upgrade"),
        ],
        validate: validateUpgrade,
      });

    if (selected.has("soak"))
      yield* Effect.gen(function* () {
        const registry = yield* localNpmRegistry;
        yield* execute({
          step: "soak",
          deadline: "soak",
          command: "node",
          args: [
            `${helpers}/soak.mjs`,
            "--image",
            candidate,
            "--evidence",
            path.join(evidence, "soak"),
          ],
          env: { SOAK_REGISTRY_URL: registry.url, SOAK_APPS_VERSION: registry.version },
          validate: validateSoak,
        });
      }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer));
  });

  yield* writeSummary("incomplete");
  yield* steps.pipe(
    Effect.scoped,
    Effect.onExit((exit) => {
      const failures = [
        ...(Exit.isSuccess(exit)
          ? []
          : [
              Cause.hasInterrupts(exit.cause)
                ? "Interrupted"
                : (Cause.pretty(exit.cause).split("\n")[0] ?? "").slice(0, 600),
            ]),
        ...(cleanupFailures.length === 0 ? [] : [`Cleanup failed: ${cleanupFailures.join("; ")}`]),
      ];
      return failures.length === 0
        ? writeSummary("passed")
        : writeSummary("failed", failures.join("; ").slice(0, 1200));
    }),
  );
  if (cleanupFailures.length > 0)
    return yield* new VerificationFailed({ step: "cleanup", message: cleanupFailures.join("; ") });
  yield* Console.log(`Verified ${results.map((result) => result.step).join(", ")}`);
  yield* Console.log(`Evidence: ${evidence}`);
});

const command = Command.make(
  "selfhost-verify",
  {
    evidence: Flag.String("evidence"),
    previous: Flag.String("previous").pipe(Flag.withDefault("")),
    previousApi: Flag.Literals("previous-api", ["router", "legacy"]).pipe(
      Flag.withDefault("router"),
    ),
    image: Flag.String("image").pipe(Flag.withDefault("")),
    steps: Flag.String("steps").pipe(Flag.withDefault(stepNames.join(","))),
    workers: Flag.Int("workers").pipe(Flag.withDefault(2)),
    deadlineSeconds: Flag.Int("deadline-seconds").pipe(Flag.optional),
  },
  verify,
);

NodeRuntime.runMain(
  Command.run(command, { version: "1" }).pipe(Effect.provide(NodeServices.layer)),
);
