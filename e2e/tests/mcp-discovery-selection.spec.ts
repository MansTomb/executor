import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Clock, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";

const Result = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Boolean,
    value: Schema.optional(Schema.Json),
    error: Schema.optional(Schema.Struct({ kind: Schema.String, message: Schema.String })),
  }),
  unavailableApps: Schema.Array(Schema.Struct({ app: Schema.String, reason: Schema.String })),
});

const source = (version: number, origin?: string) => [
  {
    path: "index.ts",
    content: `import { defineApp, query, object, number } from "apps";
export default defineApp({ accounts: {} }, async () => {
  ${origin === undefined ? "" : `const response = await fetch(${JSON.stringify(origin)}); if (!response.ok) throw new Error("Fixture unavailable");`}
  return { queries: { version: query({ input: object({}), output: number() }, async () => ${version}) } };
});`,
  },
];

const evaluationFixture = Effect.gen(function* () {
  let calls = 0;
  let failing = false;
  const services = yield* Layer.build(
    HttpRouter.serve(
      HttpRouter.add(
        "GET",
        "/evaluate",
        Effect.gen(function* () {
          calls += 1;
          yield* Effect.sleep("150 millis");
          return HttpServerResponse.empty({ status: failing ? 503 : 200 });
        }),
      ),
      { disableLogger: true, disableListenLog: true },
    ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Expected TCP fixture");
  return {
    origin: `http://127.0.0.1:${server.address.port}/evaluate`,
    calls: () => calls,
    reset: () => {
      calls = 0;
    },
    fail: () => {
      failing = true;
    },
  };
});

layer(HostedLive, { excludeTestServices: true })("MCP app discovery", (it) => {
  it.effect(scenarios.mcpDiscoverySelection.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const evidence = yield* Evidence;
        const mcp = yield* McpClient;
        const fixture = yield* evaluationFixture;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deploy = (label: string, files: ReturnType<typeof source>) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
              name: `${label}${randomUUID().replaceAll("-", "").slice(0, 8)}`,
              files,
            });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const app = yield* body(App, response);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
            );
            return app;
          });
        const fast = yield* deploy("Toolsfastdiscovery", source(1));
        const slow = yield* deploy("Slowdiscovery", source(99, fixture.origin));
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Discovery fixture",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(key.key, "discovery-selection", {
          organization: actors.organization.id,
        });
        const execute = (code: string) =>
          client
            .use("Execute selected app tools", (client) =>
              client.callTool({ name: "execute", arguments: { code } }),
            )
            .pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(Result)(result.structuredContent),
              ),
            );
        const fastTool = `tools[${JSON.stringify(fast.slug)}].queries.version`;
        fixture.reset();
        const timings: Record<string, number[]> = {};
        for (const { name, code } of [
          { name: "trivial", code: "return 1" },
          { name: "direct", code: `return await ${fastTool}({})` },
        ]) {
          const samples: number[] = [];
          for (let index = 0; index < 12; index++) {
            const started = yield* Clock.currentTimeMillis;
            const result = yield* execute(code);
            samples.push((yield* Clock.currentTimeMillis) - started);
            expect(result.execution).toMatchObject({ ok: true, value: 1 });
          }
          timings[name] = samples;
        }
        yield* evidence.json("discovery-timings.json", {
          timings,
          unrelatedEvaluations: fixture.calls(),
        });
        expect(fixture.calls(), "Unused app factories must not run before a program starts").toBe(
          0,
        );
        for (const code of [
          `return await tools.${fast.slug}.queries.version({})`,
          `return await \\u0074ools[${JSON.stringify(fast.slug)}].queries.version({})`,
          `return await tools[${JSON.stringify(fast.slug).replace("fast", "\\u0066ast")}].queries.version({})`,
          `return await tools?.[${JSON.stringify(fast.slug)}].queries.version({})`,
          `return await tools[${JSON.stringify(`${fast.slug}.queries.version`)}]({})`,
          `const selected = tools[${JSON.stringify(`${fast.slug}.queries`)}]; return await selected.version({})`,
          `const found = await tools.search({ namespace: ${JSON.stringify(fast.slug)}, query: "version" }); return found.items.filter((item) => item.path.endsWith(".queries.version")).length`,
          `const found = await search({ "namespace": ${JSON.stringify(fast.slug)} }); return found.items.length`,
          `const found = await tools?.["search"]({ namespace: ${JSON.stringify(`${fast.slug}.queries`)}, limit: 1 }); return found.items.length`,
          `const [first, second] = await Promise.all([tools.search({ namespace: ${JSON.stringify(fast.slug)} }), tools.search({ namespace: ${JSON.stringify(fast.slug)}, query: "version" })]); return first.items.length * second.items.length`,
          `const found = await tools.search({ namespace: ${JSON.stringify(fast.slug)} }); return found.items.length * (await ${fastTool}({}))`,
        ]) {
          expect((yield* execute(code)).execution, code).toMatchObject({ ok: true, value: 1 });
        }
        expect(fixture.calls(), "A literal search namespace must not load other apps").toBe(0);
        for (const code of [
          `const selected = tools; return await selected[${JSON.stringify(fast.slug)}].queries.version({})`,
          `const slug = ${JSON.stringify(fast.slug)}; return await tools[slug].queries.version({})`,
          `const names = Object.keys(tools); return names.includes(${JSON.stringify(slow.slug)}) ? 1 : 0`,
          `const found = await tools.search({ namespace: ${JSON.stringify(slow.slug)} }); return found.items.length`,
          `const found = await search({ namespace: ${JSON.stringify(slow.slug)} }); return found.items.length`,
          `const found = await tools.search({ query: "version" }); return found.items.some((item) => item.path.includes(${JSON.stringify(slow.slug)})) ? 1 : 0`,
          `const namespace = ${JSON.stringify(fast.slug)}; const found = await tools.search({ namespace }); return found.items.length`,
          `const options = { namespace: ${JSON.stringify(fast.slug)} }; const found = await tools.search({ ...options }); return found.items.length`,
          `const found = await tools.search({ namespace: ${JSON.stringify(`tools.${fast.slug}`)} }); return found.items.length`,
          `await tools.search({ namespace: ${JSON.stringify(fast.slug)} }); const found = await tools.search({ query: ${JSON.stringify(slow.slug)} }); return found.items.length`,
          `const found = await tools.search({ namespace: ${JSON.stringify(fast.slug)} }); return found.items.length * (await tools[${JSON.stringify(slow.slug)}].queries.version({})) / 99`,
        ]) {
          const previous = fixture.calls();
          const result = yield* execute(code);
          expect(result.execution, `${code}: ${JSON.stringify(result)}`).toMatchObject({
            ok: true,
            value: 1,
          });
          expect(fixture.calls()).toBeGreaterThan(previous);
        }
        for (const code of [
          `const { [${JSON.stringify(fast.slug)}]: selected } = tools; return await selected.queries.version({})`,
          "return tools[",
        ]) {
          const previous = fixture.calls();
          expect((yield* execute(code)).execution.ok).toBe(false);
          expect(fixture.calls()).toBeGreaterThan(previous);
        }
        fixture.fail();
        expect((yield* execute(`return await ${fastTool}({})`)).execution).toMatchObject({
          ok: true,
          value: 1,
        });
        const failed = yield* execute(
          `return await tools[${JSON.stringify(slow.slug)}].queries.version({})`,
        );
        expect(failed.execution.ok).toBe(false);
        expect(failed.unavailableApps).toContainEqual(expect.objectContaining({ app: slow.id }));
        expect(
          (yield* api.request(actors.owner, "POST", `${prefix}/${fast.id}/deploy`, {
            files: source(2),
          })).status,
        ).toBe(200);
        expect((yield* execute(`return await ${fastTool}({})`)).execution).toMatchObject({
          ok: true,
          value: 2,
        });
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
