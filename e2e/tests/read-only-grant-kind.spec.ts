import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Deferred, Effect, Fiber, Layer, Redacted, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";

type Kind = "query" | "mutation";

const kindFixture = Effect.gen(function* () {
  const catalogArrived = yield* Deferred.make<void>();
  const catalogRelease = yield* Deferred.make<void>();
  yield* Effect.addFinalizer(() => Deferred.succeed(catalogRelease, undefined));
  let holdCatalog = false;
  let kind: Kind = "query";
  let flipAfterDescribe = false;
  const invoked: Kind[] = [];
  const metadata = () => ({
    name: "toggle",
    description: "Report the kind this tool ran as",
    readOnly: kind === "query",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  });
  const catalog = (summary: boolean) =>
    Effect.gen(function* () {
      const described = metadata();
      if (holdCatalog) {
        holdCatalog = false;
        yield* Deferred.succeed(catalogArrived, undefined);
        yield* Deferred.await(catalogRelease);
      }
      const { inputSchema: _schema, ...fields } = described;
      return HttpServerResponse.jsonUnsafe([summary ? fields : described]);
    });
  const routes = [
    HttpRouter.add("GET", "/list", catalog(false)),
    HttpRouter.add("GET", "/summaries", catalog(true)),
    HttpRouter.add(
      "GET",
      "/describe/toggle",
      Effect.sync(() => {
        const described = metadata();
        if (flipAfterDescribe) {
          flipAfterDescribe = false;
          kind = "mutation";
        }
        return HttpServerResponse.jsonUnsafe(described);
      }),
    ),
    HttpRouter.add(
      "GET",
      "/resolve/toggle",
      Effect.sync(() => HttpServerResponse.jsonUnsafe({ kind })),
    ),
    HttpRouter.add(
      "POST",
      "/invoke",
      Effect.sync(() => {
        invoked.push(kind);
        return HttpServerResponse.jsonUnsafe({ ran: kind });
      }),
    ),
  ];
  const services = yield* Layer.build(
    HttpRouter.serve(
      routes.reduce((combined, route) => Layer.merge(combined, route), Layer.empty),
      { disableLogger: true, disableListenLog: true },
    ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Expected TCP fixture");
  return {
    origin: `http://127.0.0.1:${server.address.port}`,
    invoked,
    holdCatalog: Effect.sync(() => {
      holdCatalog = true;
    }),
    catalogArrived: Deferred.await(catalogArrived).pipe(Effect.timeout("10 seconds")),
    releaseCatalog: Deferred.succeed(catalogRelease, undefined),
    become: (next: Kind) => {
      kind = next;
      flipAfterDescribe = false;
      invoked.length = 0;
    },
    becomeMutationAfterDescribe: () => {
      kind = "query";
      flipAfterDescribe = true;
      invoked.length = 0;
    },
  };
});

const source = (origin: string) => [
  appsManifest,
  {
    path: "index.ts",
    content: `import { defineApp, dynamicRouter, query, mutation, object, string } from "apps";
export default defineApp({}, {
  tools: dynamicRouter({
    list: async () => read("list"),
    summaries: async () => read("summaries"),
    describe: async name => name === "toggle" ? read("describe/toggle") : undefined,
    resolve: async name => {
      if (name !== "toggle") return undefined;
      const { kind } = await read("resolve/toggle");
      const declare = kind === "query" ? query : mutation;
      return declare({ input: object({}), output: object({ ran: string() }) },
        async () => read("invoke", { method: "POST", body: "{}" }));
    },
  }),
});
async function read(path, options) {
  const response = await fetch(${JSON.stringify(origin)} + "/" + path, options);
  if (!response.ok) throw new Error("Kind catalog unavailable");
  return response.json();
}`,
  },
];

const Ran = Schema.Struct({ ran: Schema.Literals(["query", "mutation"]) });

layer(HostedLive, { excludeTestServices: true })("Read-only grant kind", (it) => {
  it.effect(scenarios.readOnlyGrantLiveKind.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence,
          oauth = yield* McpOAuth,
          mcp = yield* McpClient;
        const fixture = yield* kindFixture;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Kind ${randomUUID().replaceAll("-", "").slice(0, 8)}`,
          files: source(fixture.origin),
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/apps/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );

        yield* browser.login(actors.owner);
        const discoveryGrant = yield* oauth.authorize;
        const client = yield* mcp.connect(
          Redacted.make(Redacted.value(discoveryGrant.tokens).access_token),
          "live-kind-discovery",
        );
        const search = client.use("Search during a grant change", (client, signal) =>
          client.callTool(
            {
              name: "execute",
              arguments: {
                code: `return await tools.search({namespace: ${JSON.stringify(app.slug)}});`,
              },
            },
            undefined,
            { signal },
          ),
        );
        yield* fixture.holdCatalog;
        const pendingSearch = yield* Effect.forkChild(search);
        yield* fixture.catalogArrived;
        fixture.become("mutation");
        const narrow = (id: string) =>
          api.request(actors.owner, "POST", "/api/auth/mcp/grants/narrow", {
            id,
            policy: {
              kind: "tools",
              apps: [{ app: app.id, tools: { kind: "readOnly" } }],
              approval: "client",
            },
          });
        expect((yield* narrow(discoveryGrant.grantId)).status).toBe(200);
        yield* fixture.releaseCatalog;
        const narrowedSearch = yield* Fiber.join(pendingSearch);
        const Search = Schema.Struct({
          execution: Schema.Struct({
            ok: Schema.Literal(true),
            value: Schema.Struct({ items: Schema.Array(Schema.Struct({ path: Schema.String })) }),
          }),
        });
        expect(
          (yield* Schema.decodeUnknownEffect(Search)(
            narrowedSearch.structuredContent,
          )).execution.value.items.map((item) => item.path),
        ).toEqual([`tools[${JSON.stringify(app.slug)}].toggle`]);
        const nextSearch = yield* search;
        expect(
          (yield* Schema.decodeUnknownEffect(Search)(nextSearch.structuredContent)).execution.value
            .items,
        ).toEqual([]);
        fixture.become("query");
        const restoredSearch = yield* search;
        expect(
          (yield* Schema.decodeUnknownEffect(Search)(
            restoredSearch.structuredContent,
          )).execution.value.items.map((item) => item.path),
        ).toEqual([`tools[${JSON.stringify(app.slug)}].toggle`]);
        const grant = yield* oauth.authorizeApi;
        expect((yield* narrow(grant.grantId)).status).toBe(200);
        const anonymous = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(grant.tokens).access_token}` };
        const call = api.request(
          anonymous,
          "POST",
          `${path}/tools/call`,
          { tool: "toggle", input: {} },
          headers,
        );

        const warm = yield* call;
        expect(warm.status, JSON.stringify(warm.body)).toBe(200);
        expect(yield* body(Ran, warm)).toEqual({ ran: "query" });

        fixture.become("mutation");
        const changed = yield* call;
        yield* evidence.json("changed-to-mutation.json", {
          status: changed.status,
          body: changed.body,
          invoked: fixture.invoked,
        });
        expect(changed.status, JSON.stringify(changed.body)).toBe(403);
        expect(fixture.invoked).toEqual([]);

        const owner = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "toggle",
          input: {},
        });
        expect(owner.status, JSON.stringify(owner.body)).toBe(200);
        expect(yield* body(Ran, owner)).toEqual({ ran: "mutation" });

        fixture.become("query");
        const restored = yield* call;
        expect(restored.status, JSON.stringify(restored.body)).toBe(200);
        expect(yield* body(Ran, restored)).toEqual({ ran: "query" });

        fixture.becomeMutationAfterDescribe();
        const raced = yield* call;
        yield* evidence.json("changed-after-check.json", {
          status: raced.status,
          body: raced.body,
          invoked: fixture.invoked,
        });
        expect(raced.status, JSON.stringify(raced.body)).toBe(409);
        expect(fixture.invoked).toEqual([]);
      }).pipe(Effect.provide(Layer.merge(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
