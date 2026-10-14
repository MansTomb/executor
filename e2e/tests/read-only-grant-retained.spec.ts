import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Redacted, Schedule, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { connectionsPath, linkedAccountIds } from "../support/app-accounts.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";

/** Longer than discovery's 10-second wait, so a completed evaluation is kept as a slow one. */
const slowCatalogMs = 12_000;

/**
 * A remote catalog of one tool, `toggle`, whose kind the scenario changes. While `slow` is set,
 * every catalog read answers after `slowCatalogMs`, with the metadata it had when it arrived.
 */
const catalogFixture = Effect.gen(function* () {
  let slow = false;
  let readOnly = true;
  const metadata = () => ({
    name: "toggle",
    description: "Report the kind this tool ran as",
    readOnly,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  });
  const catalog = (summary: boolean) =>
    Effect.gen(function* () {
      const described = metadata();
      if (slow) yield* Effect.sleep(slowCatalogMs);
      const { inputSchema: _schema, ...fields } = described;
      return HttpServerResponse.jsonUnsafe([summary ? fields : described]);
    });
  const routes = [
    HttpRouter.add("GET", "/list", catalog(false)),
    HttpRouter.add("GET", "/summaries", catalog(true)),
    HttpRouter.add(
      "GET",
      "/describe/toggle",
      Effect.sync(() => HttpServerResponse.jsonUnsafe(metadata())),
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
    slow: (value: boolean) => {
      slow = value;
    },
    becomeMutation: () => {
      readOnly = false;
    },
  };
});

const source = (origin: string) => [
  appsManifest,
  {
    path: "index.ts",
    content: `import { defineApp, defineProvider, dynamicRouter, secrets, query, mutation, object, string } from "apps";
const service = defineProvider({ name: "Retained metadata fixture", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
export default defineApp({ user: { accounts: { service: service.many() } } }, {
  tools: dynamicRouter({
    list: async () => read("list"),
    summaries: async () => read("summaries"),
    describe: async name => name === "toggle" ? read("describe/toggle") : undefined,
    resolve: async name => {
      if (name !== "toggle") return undefined;
      const tool = await read("describe/toggle");
      const declare = tool.readOnly ? query : mutation;
      return declare({ input: object({}), output: string() }, async () => tool.readOnly ? "query" : "mutation");
    },
  }),
});
async function read(path) {
  const response = await fetch(${JSON.stringify(origin)} + "/" + path);
  if (!response.ok) throw new Error("Retained metadata catalog unavailable");
  return response.json();
}`,
  },
];

const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Boolean, value: Schema.optional(Schema.Unknown) }),
  unavailableApps: Schema.Array(Schema.Struct({ app: Schema.String })),
});
const Search = Schema.Struct({ items: Schema.Array(Schema.Struct({ path: Schema.String })) });
const Described = Schema.Struct({
  items: Schema.Array(Schema.Struct({ path: Schema.String })),
  missing: Schema.Array(Schema.Struct({ path: Schema.String })),
});

layer(HostedLive, { excludeTestServices: true })("Read-only grant retained metadata", (it) => {
  it.effect(
    scenarios.readOnlyGrantRetainedMetadata.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            browser = yield* Browser,
            evidence = yield* Evidence,
            oauth = yield* McpOAuth,
            mcp = yield* McpClient;
          const fixture = yield* catalogFixture;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Retained ${randomUUID().replaceAll("-", "").slice(0, 8)}`,
            files: source(fixture.origin),
          });
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const app = yield* body(App, deployed);
          const path = `${prefix}/apps/${app.id}`;
          const accounts: string[] = [];
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              yield* api.request(actors.owner, "DELETE", path);
              for (const id of accounts)
                yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${id}`);
            }).pipe(Effect.orDie),
          );
          const connectAccount = (token: string) =>
            Effect.gen(function* () {
              const connection = yield* api.request(
                actors.owner,
                "POST",
                connectionsPath(path, "user", "service"),
                { destination: { kind: "personal" } },
              );
              expect(connection.status, JSON.stringify(connection.body)).toBe(200);
              const request = yield* body(Resource, connection);
              const submitted = yield* api.request(
                actors.owner,
                "POST",
                `${prefix}/connections/${request.id}/submit`,
                { method: "key", label: `${token} account`, fields: { token } },
              );
              expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
              const account = yield* body(Resource, submitted);
              accounts.push(account.id);
              return account.id;
            });
          const first = yield* connectAccount("first");
          const second = yield* connectAccount("second");
          expect(yield* linkedAccountIds(actors.owner, path)).toEqual([first, second]);

          const key = yield* body(
            Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
            yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
              name: "Retained metadata control",
            }),
          );
          yield* Effect.addFinalizer(() =>
            api
              .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
              .pipe(Effect.orDie),
          );
          const owner = yield* mcp.connect(key.key, "retained-owner", {
            organization: actors.organization.id,
          });
          yield* browser.login(actors.owner);
          const narrowed = (apps: ReadonlyArray<unknown>) =>
            Effect.gen(function* () {
              const grant = yield* oauth.authorize;
              const narrow = yield* api.request(
                actors.owner,
                "POST",
                "/api/auth/mcp/grants/narrow",
                { id: grant.grantId, policy: { kind: "tools", approval: "client", apps } },
              );
              expect(narrow.status, JSON.stringify(narrow.body)).toBe(200);
              return grant;
            });
          const target = (id: string) => ({ kind: "account", id });
          // One read-only entry permits both accounts; the merged grant has a read-only entry for
          // each account, so its catalog is read per entry and merged.
          const single = yield* narrowed([
            { app: app.id, tools: { kind: "readOnly" }, targets: [target(first), target(second)] },
          ]);
          const merged = yield* narrowed([
            { app: app.id, tools: { kind: "readOnly" }, targets: [target(first)] },
            { app: app.id, tools: { kind: "readOnly" }, targets: [target(second)] },
          ]);
          const singleClient = yield* mcp.connect(
            Redacted.make(Redacted.value(single.tokens).access_token),
            "retained-single",
          );
          const mergedClient = yield* mcp.connect(
            Redacted.make(Redacted.value(merged.tokens).access_token),
            "retained-merged",
          );
          const execute = (client: typeof owner, label: string, file: string, code: string) =>
            client
              .use(label, (client, signal) =>
                client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
              )
              .pipe(
                Effect.tap((result) => evidence.json(file, result.structuredContent)),
                Effect.flatMap((result) =>
                  Schema.decodeUnknownEffect(Completed)(result.structuredContent),
                ),
              );
          const toggle = `tools[${JSON.stringify(app.slug)}].toggle`;
          const search = `return await tools.search({ namespace: ${JSON.stringify(app.slug)} });`;
          const describe = `return await tools.search.describe({ paths: [${JSON.stringify(toggle)}] });`;
          const searched = (completed: typeof Completed.Type) =>
            Schema.decodeUnknownEffect(Search)(completed.execution.value).pipe(
              Effect.map(({ items }) => items.map((item) => item.path)),
            );

          // A slow evaluation for the owner's accounts finishes after discovery stops waiting, and
          // is kept as a slow one.
          fixture.slow(true);
          const warm = yield* execute(owner, "Warm the slow catalog", "warm-owner.json", search);
          expect(warm.unavailableApps.map((entry) => entry.app)).toEqual([app.id]);
          yield* Effect.gen(function* () {
            const read = yield* execute(
              owner,
              "Wait for the slow catalog",
              "loaded-owner.json",
              search,
            );
            if (read.unavailableApps.length > 0)
              return yield* Effect.fail("still loading" as const);
            expect(yield* searched(read)).toEqual([toggle]);
          }).pipe(
            Effect.retry({
              schedule: Schedule.spaced("500 millis"),
              while: (error) => error === "still loading",
              times: 20,
            }),
          );

          // The tool becomes a mutation while those slow results are still retained.
          fixture.slow(false);
          fixture.becomeMutation();
          const retained = yield* execute(
            owner,
            "Read the retained catalog",
            "retained-owner.json",
            search,
          );
          expect(yield* searched(retained)).toEqual([toggle]);

          // A read-only grant decides from the tool's kind, so it reads the catalog live.
          const singleSearch = yield* execute(
            singleClient,
            "Search under the read-only grant",
            "single-search.json",
            search,
          );
          expect(singleSearch.unavailableApps).toEqual([]);
          expect(yield* searched(singleSearch)).toEqual([]);
          const singleDescribe = yield* execute(
            singleClient,
            "Describe under the read-only grant",
            "single-describe.json",
            describe,
          );
          expect(singleDescribe.unavailableApps).toEqual([]);
          expect(
            yield* Schema.decodeUnknownEffect(Described)(singleDescribe.execution.value),
          ).toEqual({
            items: [],
            missing: [expect.objectContaining({ path: toggle })],
          });
          // No entry of the merged grant permits both linked accounts, which hosted discovery
          // refuses rather than merging, so its retained slow catalog never reaches the caller and
          // the tool, now a mutation, is not described.
          const mergedDescribe = yield* execute(
            mergedClient,
            "Describe under the merged read-only grant",
            "merged-describe.json",
            describe,
          );
          expect(
            yield* Schema.decodeUnknownEffect(Described)(mergedDescribe.execution.value),
          ).toEqual({
            items: [],
            missing: [expect.objectContaining({ path: toggle })],
          });
        }).pipe(Effect.provide(Layer.merge(McpOAuth.layer, McpClient.layer))),
      ),
    { timeout: 180_000 },
  );
});
