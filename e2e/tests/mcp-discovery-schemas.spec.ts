import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Schema } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
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
});

const SearchPage = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ path: Schema.String, description: Schema.String, signature: Schema.String }),
  ),
  remaining: Schema.Number,
  next: Schema.NullOr(Schema.Struct({ offset: Schema.Number })),
});

const catalogFixture = Effect.gen(function* () {
  let revision = 1;
  let rejectLists = false;
  let extraTools = 0;
  const requests: string[] = [];
  const names = () => [
    "queries.alpha",
    "queries.beta",
    revision === 1 ? "queries.gamma" : "queries.delta",
    ...Array.from({ length: extraTools }, (_, index) => `queries.extra${index}`),
  ];
  const summary = (name: string) => ({
    name,
    description: `Selected ${name} revision ${revision}`,
    readOnly: true,
  });
  const describe = (name: string) => ({
    ...summary(name),
    inputSchema: {
      type: "object",
      properties: { message: { type: revision === 1 ? "string" : "number" } },
      required: ["message"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        message: { type: revision === 1 ? "string" : "number" },
        revision: { type: "number" },
      },
      required: ["message", "revision"],
      additionalProperties: false,
    },
  });
  const routes = ["selected", "unrelated"].flatMap((catalog) => [
    HttpRouter.add(
      "GET",
      `/${catalog}/summaries`,
      Effect.sync(() => {
        requests.push(`${catalog}/summaries`);
        return HttpServerResponse.jsonUnsafe(
          catalog === "selected"
            ? names().map(summary)
            : [
                {
                  name: "queries.inaccessible",
                  description: "Unrelated schema catalog",
                  readOnly: true,
                },
              ],
        );
      }),
    ),
    HttpRouter.add(
      "GET",
      `/${catalog}/list`,
      Effect.sync(() => {
        requests.push(`${catalog}/list`);
        return rejectLists
          ? HttpServerResponse.empty({ status: 503 })
          : HttpServerResponse.jsonUnsafe(
              catalog === "selected" ? names().map(describe) : [describe("queries.inaccessible")],
            );
      }),
    ),
    HttpRouter.add(
      "GET",
      `/${catalog}/describe/:name`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const name = decodeURIComponent(request.url.split("/").at(-1) ?? "");
        requests.push(`${catalog}/describe/${name}`);
        return catalog === "selected" && names().includes(name)
          ? HttpServerResponse.jsonUnsafe(describe(name))
          : HttpServerResponse.empty({ status: 404 });
      }),
    ),
    HttpRouter.add(
      "POST",
      `/${catalog}/invoke`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const input = yield* request.json.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Struct({ message: Schema.Union([Schema.String, Schema.Number]) }),
            ),
          ),
        );
        requests.push(`${catalog}/invoke`);
        return HttpServerResponse.jsonUnsafe({ message: input.message, revision });
      }),
    ),
  ]);
  const services = yield* Layer.build(
    HttpRouter.serve(
      routes.reduce((combined, route) => Layer.merge(combined, route), Layer.empty),
      {
        disableLogger: true,
        disableListenLog: true,
      },
    ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Expected TCP fixture");
  return {
    origin: `http://127.0.0.1:${server.address.port}`,
    requests,
    isolate: () => {
      rejectLists = true;
      requests.length = 0;
    },
    reset: () => {
      requests.length = 0;
    },
    advance: () => {
      revision = 2;
      requests.length = 0;
    },
    expand: () => {
      extraTools = 67;
      requests.length = 0;
    },
  };
});

const source = (origin: string) => [
  {
    path: "index.ts",
    content: `import { defineApp, dynamicTools, query, object, string, number } from "apps";
export default defineApp({ accounts: {} }, {
  dynamicTools: dynamicTools({
      list: async () => read("list"),
      resolve: async name => {
        const tool = await read("describe/" + encodeURIComponent(name));
        if (!tool) return undefined;
        const message = tool.inputSchema.properties.message.type === "string" ? string() : number();
        return query({ input: object({ message }), output: object({ message, revision: number() }) },
          async (_, input) => read("invoke", { method: "POST", body: JSON.stringify(input) }));
      },
    summaries: async () => read("summaries"),
    describe: async name => read("describe/" + encodeURIComponent(name)),
  }),
});
async function read(path, options) {
  const response = await fetch(${JSON.stringify(origin)} + "/" + path, options);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error("Schema catalog unavailable");
  return response.json();
}`,
  },
];

layer(HostedLive, { excludeTestServices: true })("MCP discovery schemas", (it) => {
  it.effect(scenarios.mcpDiscoverySchemas.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const evidence = yield* Evidence;
        const mcp = yield* McpClient;
        const fixture = yield* catalogFixture;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deploy = (label: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
              name: `${label}${randomUUID().replaceAll("-", "").slice(0, 8)}`,
              files: source(`${fixture.origin}/${label}`),
            });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const app = yield* body(App, response);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
            );
            return app;
          });
        const selected = yield* deploy("selected");
        const unrelated = yield* deploy("unrelated");
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Discovery schema fixture",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(key.key, "discovery-schemas", {
          organization: actors.organization.id,
        });
        const execute = (code: string) =>
          client
            .use("Discover selected schemas", (client) =>
              client.callTool({ name: "execute", arguments: { code } }),
            )
            .pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(Result)(result.structuredContent),
              ),
            );
        const search = (options: Schema.Json) =>
          Effect.gen(function* () {
            const result = yield* execute(`return await tools.search(${JSON.stringify(options)})`);
            expect(result.execution, JSON.stringify(result)).toMatchObject({ ok: true });
            return yield* Schema.decodeUnknownEffect(SearchPage)(result.execution.value);
          });
        fixture.isolate();
        const trivial = yield* execute("return 7");
        expect(trivial.execution).toMatchObject({ ok: true, value: 7 });
        expect(
          fixture.requests.filter((path) => path.endsWith("/list") || path.includes("/describe/")),
        ).toEqual([]);
        const first = yield* search({ namespace: selected.slug, limit: 1 });
        yield* evidence.json("selected-first-page.json", {
          page: first,
          requests: fixture.requests,
        });
        expect(first.items.map((item) => item.path)).toEqual([
          `tools.${selected.slug}.queries.alpha`,
        ]);
        expect(first.remaining).toBe(2);
        expect(first.next).toEqual({ offset: 1 });
        expect(first.items[0]?.signature).toBe(
          `tools.${selected.slug}.queries.alpha(input: {\n  message: string,\n}): Promise<{\n  message: string,\n  revision: number,\n}>`,
        );
        expect(fixture.requests.filter((path) => path.includes("/describe/"))).toEqual([
          "selected/describe/queries.alpha",
        ]);
        expect(fixture.requests.filter((path) => path.endsWith("/list"))).toEqual([]);
        expect(fixture.requests).toContain("selected/summaries");
        expect(fixture.requests).not.toContain("unrelated/summaries");
        fixture.reset();
        const second = yield* search({ namespace: selected.slug, limit: 2, offset: 1 });
        expect(second.items.map((item) => item.path)).toEqual([
          `tools.${selected.slug}.queries.beta`,
          `tools.${selected.slug}.queries.gamma`,
        ]);
        expect(second.remaining).toBe(0);
        expect(second.next).toBeNull();
        expect(fixture.requests.filter((path) => path.includes("/describe/")).sort()).toEqual([
          "selected/describe/queries.beta",
          "selected/describe/queries.gamma",
        ]);
        const root = `tools[${JSON.stringify(selected.slug)}]`;
        fixture.reset();
        const called = yield* execute(
          `const alias = ${root}; const name = "alpha"; return await alias.queries[name]({ message: "hello" })`,
        );
        expect(called.execution).toMatchObject({
          ok: true,
          value: { message: "hello", revision: 1 },
        });
        expect(fixture.requests).toContain("selected/invoke");
        expect(
          fixture.requests.some(
            (path) => path.startsWith("unrelated/describe/") || path.endsWith("/list"),
          ),
        ).toBe(false);
        fixture.reset();
        const invalid = yield* execute(`return await ${root}.queries.alpha({ message: 42 })`);
        expect(invalid.execution).toMatchObject({ ok: false, error: { kind: "ToolFailure" } });
        expect(fixture.requests.filter((path) => path.endsWith("/invoke"))).toEqual([]);
        fixture.advance();
        const changed = yield* search({ namespace: selected.slug, query: "alpha" });
        expect(changed.items.map((item) => item.path)).toEqual([
          `tools.${selected.slug}.queries.alpha`,
        ]);
        expect(changed.items[0]?.signature).toBe(
          `tools.${selected.slug}.queries.alpha(input: {\n  message: number,\n}): Promise<{\n  message: number,\n  revision: number,\n}>`,
        );
        expect(changed.items[0]?.description).toBe(
          `${selected.name}: Selected queries.alpha revision 2`,
        );
        const fresh = yield* search({ namespace: selected.slug, limit: 3 });
        expect(fresh.items.map((item) => item.path)).toEqual([
          `tools.${selected.slug}.queries.alpha`,
          `tools.${selected.slug}.queries.beta`,
          `tools.${selected.slug}.queries.delta`,
        ]);
        expect(
          (yield* execute(`return await ${root}.queries.alpha({ message: 42 })`)).execution,
        ).toMatchObject({ ok: true, value: { message: 42, revision: 2 } });
        expect(
          (yield* execute(`return await ${root}.queries.alpha({ message: "obsolete" })`)).execution
            .ok,
        ).toBe(false);
        expect((yield* search({ namespace: unrelated.slug, query: "missing" })).items).toEqual([]);
        yield* evidence.json("fresh-catalog-requests.json", fixture.requests);
        expect(
          fixture.requests.some(
            (path) => path.endsWith("/list") || path.startsWith("unrelated/describe/"),
          ),
        ).toBe(false);
        fixture.expand();
        const expanded = yield* search({ namespace: selected.slug, limit: 70 });
        expect(expanded.items.map((item) => item.path)).toEqual(
          ["alpha", "beta", "delta", ...Array.from({ length: 67 }, (_, index) => `extra${index}`)]
            .sort()
            .map((name) => `tools.${selected.slug}.queries.${name}`),
        );
        expect(expanded.remaining).toBe(0);
        expect(expanded.next).toBeNull();
        expect(fixture.requests.filter((path) => path.endsWith("/list"))).toEqual([
          "selected/list",
        ]);
        expect(fixture.requests.filter((path) => path.includes("/describe/")).length).toBe(70);
        yield* evidence.json("bulk-schema-fallback.json", {
          page: expanded,
          requests: fixture.requests,
        });
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
