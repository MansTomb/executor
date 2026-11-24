import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BackupRecord, Service } from "./dokploy.ts";
import type { Analytics, AnalyticsWindow, Sweep } from "./executor.ts";
import type { Image } from "./image.ts";
import type { Decision } from "./lanes.ts";
import type { WatchResult } from "./watch.ts";

export type GateStep = {
  readonly step: string;
  readonly status: string;
  readonly seconds: number;
  readonly note?: string;
  readonly message?: string;
};

export type Gate = {
  readonly name: string;
  readonly status: string;
  readonly seconds: number;
  readonly steps: ReadonlyArray<GateStep>;
};

export type State = {
  readonly dryRun: boolean;
  readonly evidence: string;
  readonly worktree: string;
  readonly config: string;
  readonly notifyScope: string;
  readonly candidate: string;
  readonly production: { readonly source: string; readonly sourceFrom: string };
  readonly service: Service;
  readonly decision: Decision;
  readonly timings: Record<string, number>;
  readonly gates: Array<Gate>;
  image?: Image;
  fingerprint?: string;
  backup?: BackupRecord;
  switched?: { readonly job: string; readonly container: string };
  analyticsWindow?: AnalyticsWindow;
  readonly sweeps: Record<string, Sweep>;
  readonly analytics: Record<string, Analytics>;
  management?: Record<string, unknown>;
  watch?: WatchResult;
  recovery?: Record<string, unknown>;
  records?: Record<string, unknown>;
  notifications: Array<unknown>;
};

export const stateFile = (evidence: string) => path.join(evidence, "state.json");

export const saveState = (state: State) =>
  writeFileSync(stateFile(state.evidence), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

export const loadState = (evidence: string) =>
  JSON.parse(readFileSync(stateFile(evidence), "utf8")) as State;
