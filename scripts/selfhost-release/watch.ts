import { appendFileSync, readFileSync } from "node:fs";
import type { ContainerState } from "./dokploy.ts";
import { elapsed, sleep } from "./shell.ts";

export type WatchTarget = {
  readonly state: () => Promise<ContainerState | undefined>;
  readonly health: () => Promise<number>;
};

type Memory = { readonly min: number; readonly peak: number; readonly final: number };

export type WatchResult = {
  readonly passed: boolean;
  readonly failure?: string;
  readonly samples: number;
  readonly seconds: number;
  readonly memoryMiB?: Memory;
  readonly workingMiB?: Memory;
};

const cgroup = (id: string) => {
  try {
    const root = `/sys/fs/cgroup/system.slice/docker-${id}.scope`;
    const pairs = (file: string) =>
      new Map(
        readFileSync(`${root}/${file}`, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const [key = "", value = "0"] = line.split(" ");
            return [key, Number(value)] as const;
          }),
      );
    const current = Number(readFileSync(`${root}/memory.current`, "utf8"));
    return {
      memoryMiB: current / 2 ** 20,
      workingMiB: (current - (pairs("memory.stat").get("inactive_file") ?? 0)) / 2 ** 20,
      oomKills: pairs("memory.events").get("oom_kill") ?? 0,
    };
  } catch {
    return undefined;
  }
};

const range = (values: ReadonlyArray<number>): Memory | undefined => {
  const final = values.at(-1);
  if (final === undefined) return undefined;
  const round = (value: number) => Math.round(value * 10) / 10;
  return { min: round(Math.min(...values)), peak: round(Math.max(...values)), final: round(final) };
};

export const watch = async (options: {
  readonly target: WatchTarget;
  readonly seconds: number;
  readonly interval: number;
  readonly trace: string;
  readonly checks?: Promise<string | undefined>;
}): Promise<WatchResult> => {
  const started = Date.now();
  const memory: number[] = [];
  const working: number[] = [];
  let samples = 0;
  let checksFailure: string | undefined;
  let checksDone = options.checks === undefined;
  void options.checks?.then(
    (failure) => {
      checksFailure = failure;
      checksDone = true;
    },
    (error: unknown) => {
      checksFailure = error instanceof Error ? error.message : String(error);
      checksDone = true;
    },
  );
  const result = (failure?: string): WatchResult => {
    const memoryMiB = range(memory);
    const workingMiB = range(working);
    return {
      passed: failure === undefined,
      ...(failure === undefined ? {} : { failure }),
      samples,
      seconds: elapsed(started),
      ...(memoryMiB === undefined ? {} : { memoryMiB }),
      ...(workingMiB === undefined ? {} : { workingMiB }),
    };
  };
  const initial = await options.target.state();
  if (initial === undefined) return result("The watched container is not running");
  for (;;) {
    const seconds = elapsed(started);
    const [state, status] = await Promise.all([options.target.state(), options.target.health()]);
    const usage = state === undefined ? undefined : cgroup(state.id);
    samples++;
    appendFileSync(
      options.trace,
      `${JSON.stringify({ seconds, status, container: state?.id.slice(0, 12) ?? null, health: state?.health ?? "stopped", restarts: state?.restarts ?? null, oom: state?.oom ?? null, ...usage })}\n`,
      { mode: 0o600 },
    );
    if (usage !== undefined) {
      memory.push(usage.memoryMiB);
      working.push(usage.workingMiB);
    }
    const failure =
      state === undefined
        ? "The container stopped"
        : state.id !== initial.id
          ? "The container was replaced"
          : state.restarts !== initial.restarts
            ? `The container restarted ${state.restarts - initial.restarts} times`
            : state.oom || (usage?.oomKills ?? 0) > 0
              ? "The container saw an OOM kill"
              : state.health !== "healthy"
                ? `Docker reports the container ${state.health}`
                : status !== 200
                  ? `The root page answered ${status === 0 ? "nothing" : status}`
                  : checksFailure;
    if (failure !== undefined) return result(failure);
    if (seconds >= options.seconds) {
      while (!checksDone) await sleep(1);
      return result(checksFailure);
    }
    await sleep(Math.min(options.interval, options.seconds - seconds));
  }
};
