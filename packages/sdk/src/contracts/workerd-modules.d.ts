/** Narrow constructors provided by workerd; app modules never load these in Node. */
declare module "cloudflare:workers" {
  import { Rpc } from "@cloudflare/workers-types";
  export const RpcTarget: typeof import("@cloudflare/workers-types").CloudflareWorkersModule.RpcTarget;
  export abstract class WorkerEntrypoint<Env> {
    [Rpc.__WORKER_ENTRYPOINT_BRAND]: never;
    protected readonly ctx: import("@cloudflare/workers-types").ExecutionContext;
    protected readonly env: Env;
    constructor(ctx: import("@cloudflare/workers-types").ExecutionContext, env: Env);
  }
  export abstract class DurableObject<Env> {
    [Rpc.__DURABLE_OBJECT_BRAND]: never;
    protected readonly ctx: import("@cloudflare/workers-types").DurableObjectState;
    protected readonly env: Env;
    constructor(ctx: import("@cloudflare/workers-types").DurableObjectState, env: Env);
  }
  export abstract class WorkflowEntrypoint<Env, Payload> {
    protected readonly ctx: import("@cloudflare/workers-types").ExecutionContext;
    protected readonly env: Env;
    constructor(ctx: import("@cloudflare/workers-types").ExecutionContext, env: Env);
    abstract run(event: Readonly<{ payload: Payload }>, step: unknown): Promise<unknown>;
  }
  /** Keep the current Worker or Durable Object invocation alive until the promise settles. */
  export function waitUntil(promise: Promise<unknown>): void;
}
