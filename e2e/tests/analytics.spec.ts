import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";
import { analyticsDatabase, analyticsVolume } from "../support/analytics-database.ts";

const Summary = Schema.Struct({
  matchedEvents: Schema.Number,
  retainedFrom: Schema.Number,
  retentionDays: Schema.Number,
  bestEffort: Schema.Boolean,
  completeness: Schema.String,
  truncated: Schema.Boolean,
  groups: Schema.Array(
    Schema.Struct({
      dimensions: Schema.Record(
        Schema.String,
        Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
      ),
      count: Schema.Number,
      durationMs: Schema.Number,
    }),
  ),
});
layer(TestLive, { excludeTestServices: true })("Analytics", (it) => {
  it.effect(scenarios.analytics.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const send = (method: "GET" | "POST" | "DELETE", path: string, data?: unknown) =>
          session.send(method, path, data, headers);
        const started = Date.now();
        const deployed = yield* send("POST", "/v1/apps/deploy", {
          owner: "analytics-owner",
          name: `Analytics ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, query, object, number } from "apps";
export default defineApp({ accounts: {} }, { queries: { emit: query({ input: object({}) }, async context => {
  for (let i = 0; i < 250; i++) await context.analytics.emit({ event: "webhook_received", purpose: "slack" });
  return "sent";
}), groups: query({ input: object({ offset: number() }) }, async (context, input) => {
  for (let i = 0; i < 600; i++) await context.analytics.emit({ event: "group_limit", purpose: "group_" + (input.offset + i) });
  return "sent";
}) } });`,
            },
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = (yield* body(
          Schema.Struct({ app: Schema.Struct({ id: Schema.String }) }),
          deployed,
        )).app;
        const path = `/v1/apps/${app.id}`;
        yield* Effect.addFinalizer(() => send("DELETE", path).pipe(Effect.orDie));
        yield* serverControl("stop");
        expect(yield* analyticsDatabase("baseline")).toEqual({ version: "4.0.1", events: 0 });
        yield* analyticsVolume("backup");
        yield* serverControl("start");
        expect((yield* send("GET", path)).status).toBe(200);
        const call = () =>
          send("POST", "/v1/tools/call", { app: app.id, tool: "queries.emit", input: {} });
        const results = yield* Effect.all(Array.from({ length: 24 }, call), { concurrency: 4 });
        for (const result of results)
          expect(result.body).toEqual({ status: "completed", value: "sent" });
        const read = (from: number, to: number) =>
          Effect.gen(function* () {
            const response = yield* send(
              "GET",
              `${path}/analytics?from=${from}&to=${to}&event=webhook_received&groupBy=purpose`,
            );
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            return yield* body(Summary, response);
          });
        const first = yield* read(started, Date.now());
        expect(first).toMatchObject({
          matchedEvents: 6000,
          retentionDays: 30,
          bestEffort: true,
          completeness: "not-guaranteed",
          truncated: false,
          groups: [{ dimensions: { purpose: "slack" }, count: 6000, durationMs: 0 }],
        });
        for (const offset of [0, 600]) {
          expect(
            (yield* send("POST", "/v1/tools/call", {
              app: app.id,
              tool: "queries.groups",
              input: { offset },
            })).body,
          ).toEqual({ status: "completed", value: "sent" });
        }
        const limited = yield* body(
          Summary,
          yield* send(
            "GET",
            `${path}/analytics?from=${started}&to=${Date.now()}&event=group_limit&groupBy=purpose`,
          ),
        );
        expect(limited).toMatchObject({ matchedEvents: 1200, truncated: true });
        expect(limited.groups).toHaveLength(1000);
        expect(limited.groups.reduce((total, group) => total + group.count, 0)).toBe(1000);
        expect(
          (yield* send(
            "GET",
            `${path}/analytics?owner=another-owner&from=${started}&to=${Date.now()}`,
          )).status,
        ).toBe(404);
        expect(
          (yield* session.send("GET", `${path}/analytics?from=${started}&to=${Date.now()}`)).status,
        ).toBe(401);
        yield* serverControl("restart");
        expect((yield* read(started, Date.now())).matchedEvents).toBe(6000);
        yield* serverControl("stop");
        yield* serverControl("clock/advance", 200, { milliseconds: 31 * 86_400_000 });
        yield* serverControl("start");
        const advanced = Date.now() + 31 * 86_400_000;
        const expired = yield* read(advanced - 30 * 86_400_000, advanced);
        expect(expired).toMatchObject({
          matchedEvents: 0,
          groups: [],
          bestEffort: true,
          completeness: "not-guaranteed",
        });
        expect(expired.retainedFrom).toBeGreaterThan(started);
        yield* serverControl("stop");
        const stored = yield* analyticsDatabase("inspect");
        expect(stored.version).toBe("4.0.2");
        expect(stored.events).toBe(6252);
        expect(yield* analyticsDatabase("rollback")).toEqual({ version: "4.0.1", events: 6252 });
        yield* serverControl("start");
        expect((yield* send("GET", path)).status).toBe(200);
        yield* serverControl("stop");
        expect(yield* analyticsDatabase("inspect")).toEqual({ version: "4.0.2", events: 6252 });
        yield* analyticsVolume("restore");
        expect(yield* analyticsDatabase("inspect")).toEqual({ version: "4.0.1", events: 0 });
        yield* serverControl("start");
        expect((yield* send("GET", path)).status).toBe(200);
        yield* serverControl("stop");
        expect(yield* analyticsDatabase("inspect")).toEqual({ version: "4.0.2", events: 0 });
        yield* serverControl("start");
      }),
    ),
  );
});
