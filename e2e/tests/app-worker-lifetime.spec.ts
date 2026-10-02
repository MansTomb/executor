import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { requestGate } from "../support/request-gate.ts";

const Probe = Schema.Struct({
  instance: Schema.String,
  ordinal: Schema.Int,
  nonce: Schema.String,
});

layer(HostedLive, { excludeTestServices: true })("App worker lifetime", (it) => {
  it.effect(scenarios.appWorkerLifetime.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        const gate = yield* requestGate;
        const root = `/api/organizations/${actors.organization.id}/apps`;
        const remember = (app: typeof App.Type) =>
          Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${root}/${app.id}`).pipe(Effect.orDie),
          );
        const deployed = yield* api.request(actors.owner, "POST", `${root}/deploy`, {
          name: `Worker lifetime ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, query, object, string, boolean } from "apps";
let instance;
let ordinal = 0;
const probe = query({ input: object({ nonce: string(), wait: boolean() }) }, async (ctx, input) => {
  instance ??= crypto.randomUUID();
  const result = { instance, ordinal: ++ordinal, nonce: input.nonce };
  if (input.wait) {
    const response = await ctx.fetch(${JSON.stringify(`${gate.origin}/wait`)});
    if (!response.ok) throw new Error("Held request failed");
  }
  return result;
});
export default defineApp({ accounts: {} }, { queries: { probe } });`,
            },
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const original = yield* body(App, deployed);
        yield* remember(original);
        const probe = (app: typeof App.Type, nonce: string, wait = false) =>
          Effect.gen(function* () {
            const response = yield* api.request(
              actors.owner,
              "POST",
              `${root}/${app.id}/tools/call`,
              { tool: "queries.probe", input: { nonce, wait } },
            );
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            return yield* body(Probe, response);
          });
        const first = yield* probe(original, "first");
        expect(first).toEqual({ instance: first.instance, ordinal: 1, nonce: "first" });
        expect(yield* probe(original, "second")).toEqual({
          instance: first.instance,
          ordinal: 2,
          nonce: "second",
        });
        yield* evidence.step(
          "Reuse the worker beyond native ten-second eviction",
          Effect.gen(function* () {
            yield* Effect.sleep("12 seconds");
            expect(yield* probe(original, "after-native-expiry")).toEqual({
              instance: first.instance,
              ordinal: 3,
              nonce: "after-native-expiry",
            });
          }),
        );
        const copies = yield* Effect.forEach(
          Array.from({ length: 16 }, (_, index) => index),
          (index) =>
            Effect.gen(function* () {
              const response = yield* api.request(actors.owner, "POST", `${root}/copies`, {
                from: { app: original.id },
                name: `Worker copy ${index} ${randomUUID().slice(0, 8)}`,
              });
              expect(response.status, JSON.stringify(response.body)).toBe(200);
              const copy = yield* body(App, response);
              yield* remember(copy);
              return copy;
            }),
          { concurrency: 4 },
        );
        yield* evidence.step(
          "A held invocation survives idle capacity churn",
          Effect.scoped(
            Effect.gen(function* () {
              const held = yield* probe(original, "held", true).pipe(Effect.forkScoped);
              yield* Effect.addFinalizer(() => gate.release);
              yield* gate.arrived;
              for (const [index, copy] of copies.entries()) {
                const result = yield* probe(copy, `churn-${index}`);
                expect(result).toEqual({
                  instance: result.instance,
                  ordinal: 1,
                  nonce: `churn-${index}`,
                });
              }
              yield* gate.release;
              expect(yield* Fiber.join(held)).toEqual({
                instance: first.instance,
                ordinal: 4,
                nonce: "held",
              });
            }),
          ),
        );
        expect(yield* probe(original, "after-held")).toEqual({
          instance: first.instance,
          ordinal: 5,
          nonce: "after-held",
        });
        yield* evidence.step(
          "An idle worker reloads after the retained capacity is exceeded",
          Effect.gen(function* () {
            for (const [index, copy] of copies.entries()) {
              const result = yield* probe(copy, `refresh-${index}`);
              expect(result.nonce).toBe(`refresh-${index}`);
            }
            const reloaded = yield* probe(original, "reloaded");
            expect(reloaded).toEqual({
              instance: reloaded.instance,
              ordinal: 1,
              nonce: "reloaded",
            });
            expect(reloaded.instance).not.toBe(first.instance);
            yield* evidence.json("app-worker-reload.json", { first, reloaded });
          }),
        );
      }),
    ),
  );
});
