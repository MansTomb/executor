import { DurableObject, RpcTarget } from "cloudflare:workers";
import type { WorkerLoader, WorkerLoaderWorkerCode, WorkerStub } from "@cloudflare/workers-types";
import { Schema } from "effect";
import { AppRpcEntrypoint, AppRpcInvocation } from "./worker-elicitation.ts";

declare module "@cloudflare/workers-types" {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: Pick<typeof import("./workerd-entry.ts"), "AppWorkerSlot" | "AppOutbound">;
    }
  }
}

type StartArguments = Parameters<(typeof AppRpcEntrypoint.Type)["start"]>;
type LoadWorker = () => Promise<Omit<WorkerLoaderWorkerCode, "globalOutbound">>;
type Invocation = typeof AppRpcInvocation.Type;

const idleTimeoutMs = 5 * 60_000;
const capacity = 16;

export class AppWorkerSlot extends DurableObject<{ LOADER: WorkerLoader }> {
  #worker: Promise<WorkerStub> | undefined;

  async start(load: LoadWorker, ...args: StartArguments): Promise<Invocation> {
    this.#worker ??= load()
      .then((code) =>
        this.env.LOADER.load({ ...code, globalOutbound: this.ctx.exports.AppOutbound }),
      )
      .catch((error) => {
        this.#worker = undefined;
        throw error;
      });
    const worker = await this.#worker;
    const entry = Schema.decodeUnknownSync(AppRpcEntrypoint)(worker.getEntrypoint());
    return Schema.decodeUnknownSync(AppRpcInvocation)(await entry.start(...args));
  }
}

class WorkerLease extends RpcTarget {
  constructor(
    private readonly call: Invocation,
    private readonly release: () => void,
  ) {
    super();
  }

  async result() {
    const result = await this.call.result();
    if (typeof result === "object" && result !== null && Symbol.dispose in result) {
      const dispose = result[Symbol.dispose];
      if (typeof dispose === "function") {
        try {
          dispose.call(result);
        } finally {
          Reflect.deleteProperty(result, Symbol.dispose);
        }
      }
    }
    return result;
  }

  async drain() {
    await this.call.drain?.();
  }

  cancel() {
    return this.call.cancel();
  }

  [Symbol.dispose]() {
    try {
      this.call[Symbol.dispose]();
    } finally {
      this.release();
    }
  }
}

type Entry = {
  readonly slot: Pick<AppWorkerSlot, "start">;
  active: number;
  expiresAt: number;
};

export class AppWorkerPool extends DurableObject<unknown> {
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #entries = new Map<string, Entry>();

  #evict(key: string) {
    this.ctx.facets.abort(key, "App worker expired");
    this.#entries.delete(key);
  }

  #schedule() {
    clearTimeout(this.#timer);
    const idle = [...this.#entries.values()].filter((entry) => entry.active === 0);
    this.#timer =
      idle.length === 0
        ? undefined
        : setTimeout(
            () => this.expire(),
            Math.max(0, Math.min(...idle.map((entry) => entry.expiresAt)) - Date.now()),
          );
  }

  async start(key: string, load: LoadWorker, ...args: StartArguments): Promise<Invocation> {
    let entry = this.#entries.get(key);
    if (entry === undefined) {
      if (this.#entries.size >= capacity) {
        const oldest = [...this.#entries.entries()]
          .filter(([, item]) => item.active === 0)
          .sort(([, a], [, b]) => a.expiresAt - b.expiresAt)[0];
        if (oldest !== undefined) this.#evict(oldest[0]);
      }
      entry = {
        slot: this.ctx.facets.get<AppWorkerSlot>(key, () => ({
          class: this.ctx.exports.AppWorkerSlot,
        })),
        active: 0,
        expiresAt: Date.now() + idleTimeoutMs,
      };
      this.#entries.set(key, entry);
    }
    const acquired = entry;
    acquired.active++;
    const release = () => {
      acquired.active--;
      acquired.expiresAt = Date.now() + idleTimeoutMs;
      if (acquired.active === 0 && this.#entries.size > capacity) this.#evict(key);
      this.#schedule();
    };
    try {
      const call = await acquired.slot.start(load, ...args);
      return new WorkerLease(call, release);
    } catch (error) {
      release();
      throw error;
    }
  }

  expire() {
    const now = Date.now();
    for (const [key, entry] of this.#entries) {
      if (entry.active === 0 && entry.expiresAt <= now) this.#evict(key);
    }
    this.#schedule();
  }
}
