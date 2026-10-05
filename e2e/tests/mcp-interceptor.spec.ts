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
import { App, Resource } from "../support/contracts.ts";
import { createProfile, selectProfileAccounts } from "../support/profiles.ts";

const Wire = Schema.Struct({
  id: Schema.optionalKey(Schema.Json),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});

const fixture = () =>
  Effect.gen(function* () {
    let handshakeFailure = false;
    const calls: { account: string; path: string; message: Schema.Json }[] = [];
    const resultSchema = {
      type: "object",
      required: ["account", "message", "path"],
      properties: {
        account: { type: "string" },
        message: { type: "string" },
        path: { type: "string" },
      },
    };
    const routes = Layer.mergeAll(
      HttpRouter.add(
        "GET",
        "/rest",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const message = new URL(request.url, "http://fixture").searchParams.get("message") ?? "";
          const account = request.headers["x-account"] ?? "missing";
          calls.push({ account, path: "rest", message });
          return yield* HttpServerResponse.json({ account, message, path: "rest" });
        }),
      ),
      HttpRouter.add("GET", "/mcp", HttpServerResponse.empty({ status: 405 })),
      HttpRouter.add(
        "POST",
        "/mcp",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const message = yield* request.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Wire)),
          );
          if (message.id === undefined) return HttpServerResponse.empty({ status: 202 });
          const respond = (result: Schema.Json) =>
            HttpServerResponse.json({ jsonrpc: "2.0", id: message.id ?? null, result });
          if (message.method === "initialize" && handshakeFailure)
            return HttpServerResponse.empty({ status: 503 });
          if (message.method === "initialize")
            return yield* respond({
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "Interceptor fixture", version: "1" },
            });
          if (message.method === "tools/list")
            return yield* respond({
              tools: ["read", "write"].map((name) => ({
                name,
                title: `Fixture ${name}`,
                description: `Authenticated ${name}`,
                inputSchema: {
                  type: "object",
                  required: ["message"],
                  properties: { message: { type: "string" } },
                  additionalProperties: false,
                },
                outputSchema: resultSchema,
                annotations: { readOnlyHint: name === "read" },
                _meta: { fixture: "native" },
              })),
            });
          if (message.method === "tools/call") {
            const arguments_ = Schema.decodeUnknownSync(Schema.Struct({ message: Schema.String }))(
              message.params?.arguments,
            );
            const account = request.headers["x-account"] ?? "missing";
            calls.push({
              account,
              path: String(message.params?.name),
              message: arguments_.message,
            });
            if (arguments_.message === "upstream-failure")
              return HttpServerResponse.empty({ status: 503 });
            if (arguments_.message === "native-toolerror")
              return yield* respond({
                content: [{ type: "text", text: "Native tool failure" }],
                isError: true,
              });
            const value = { account, message: arguments_.message, path: "mcp" };
            return yield* respond({
              content: [{ type: "text", text: JSON.stringify(value) }],
              structuredContent: value,
            });
          }
          return yield* respond({});
        }),
      ),
    );
    const services = yield* Layer.build(
      HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
      ),
    );
    const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
    if (!("port" in server.address)) return yield* Effect.die("Expected TCP fixture");
    return {
      origin: `http://127.0.0.1:${server.address.port}`,
      calls,
      failHandshake: () => {
        handshakeFailure = true;
      },
    };
  });

const source = (origin: string) => [
  {
    path: "package.json",
    content: JSON.stringify({ dependencies: { "@modelcontextprotocol/sdk": "1.30.0" } }),
  },
  {
    path: "index.ts",
    content: `
import { defineApp, defineProvider, accountOperations, secrets, object, string } from "apps";
import { mcpOperations, McpError } from "apps/mcp";
const provider = defineProvider({ name: "Interceptor account", auth: { key: secrets({ label: "Account", fields: object({ token: string() }) }) } });
export default defineApp({ accounts: { service: provider.many() } }, async ctx =>
  accountOperations(ctx.accounts.service, account => mcpOperations({
    url: ${JSON.stringify(`${origin}/mcp`)}, headers: { "X-Account": account.fields.token }, accountId: account.id,
    signal: ctx.signal, cache: ctx.cache.forAccount(account),
    intercept: async ({ tool, context, input, next }) => {
      await context.analytics.emit({ event: "webhook_received", purpose: "slack" });
      if (tool.name !== "read" || input.message === "next" || input.message === "upstream-failure" || String(input.message).startsWith("native-")) return next();
      if (input.message === "throw") throw new McpError({ phase: "call", reason: "timeout" });
      if (input.message === "badoutput") return { content: [], structuredContent: { account: 42 } };
      if (input.message === "bad-envelope") return { content: "invalid" };
      if (input.message === "toolerror") return { content: [{ type: "text", text: "Explicit tool failure" }], isError: true };
      if (context.signal.aborted || !context.accounts.service.some(selected => selected.id === account.id)) throw new Error("Wrong invocation context");
      await context.analytics.emit({ event: "upstream_request", operation: "read", transport: "rest", purpose: "task", phase: "started" });
      const response = await context.fetch(${JSON.stringify(`${origin}/rest`)} + "?message=" + encodeURIComponent(String(input.message)), {
        headers: { "X-Account": account.fields.token }, signal: context.signal,
      });
      const value = await response.json();
      await context.analytics.emit({ event: "upstream_request", operation: "read", transport: "rest", purpose: "task", phase: "completed", outcome: "success", statusCode: response.status });
      await context.analytics.emit(JSON.parse('{"event":"invalid","contents":"must be rejected"}'));
      return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, _meta: { intercepted: true } };
    },
  }), { signal: ctx.signal }));`,
  },
];

layer(HostedLive, { excludeTestServices: true })("MCP interceptor", (it) => {
  it.effect(scenarios.mcpInterceptor.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const started = Date.now();
        const upstream = yield* fixture();
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `MCP interceptor ${randomUUID().slice(0, 8)}`,
          files: source(upstream.origin),
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const path = `${prefix}/apps/${(yield* body(App, deployed)).id}`;
        const ids: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", path);
            for (const id of ids)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${id}`);
          }).pipe(Effect.orDie),
        );
        const profile = yield* createProfile(actors.owner, path);
        const connect = (token: string) =>
          Effect.gen(function* () {
            const connection = yield* body(
              Resource,
              yield* api.request(actors.owner, "POST", `${path}/connections`, {
                requirement: "service",
                profile: profile.id,
              }),
            );
            const account = yield* body(
              Resource,
              yield* api.request(
                actors.owner,
                "POST",
                `${prefix}/connections/${connection.id}/submit`,
                {
                  method: "key",
                  label: token,
                  fields: { token },
                },
              ),
            );
            ids.push(account.id);
            return account.id;
          });
        const alpha = yield* connect("alpha"),
          bravo = yield* connect("bravo");
        yield* selectProfileAccounts(actors.owner, path, profile.id, { service: [alpha, bravo] });
        const call = (
          accountId: string,
          message: Schema.Json,
          tool = "queries.read",
          profileId = profile.id,
        ) =>
          api.request(actors.owner, "POST", `${path}/tools/call`, {
            profile: profileId,
            tool,
            input: { accountId, input: { message } },
          });
        const assertValue = (
          response: { status: number; body: unknown },
          account: string,
          message: string,
          route: string,
        ) => {
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          expect(response.body).toEqual({
            content: [{ type: "text", text: JSON.stringify({ account, message, path: route }) }],
            structuredContent: { account, message, path: route },
            ...(route === "rest" ? { _meta: { intercepted: true } } : {}),
          });
        };
        const described = yield* api.request(
          actors.owner,
          "GET",
          `${path}/tools/queries.read?profile=${profile.id}`,
        );
        expect(described.status).toBe(200);
        expect(described.body).toMatchObject({
          name: "queries.read",
          title: "Fixture read",
          description: "Authenticated read",
          annotations: { readOnlyHint: true },
          _meta: { fixture: "native" },
        });
        expect(
          (yield* api.request(
            actors.owner,
            "GET",
            `${path}/tools/mutations.write?profile=${profile.id}`,
          )).body,
        ).toMatchObject({ name: "mutations.write", annotations: { readOnlyHint: false } });
        assertValue(yield* call(alpha, "fresh"), "alpha", "fresh", "rest");
        assertValue(yield* call(bravo, "next"), "bravo", "next", "mcp");
        assertValue(yield* call(alpha, "write", "mutations.write"), "alpha", "write", "mcp");
        const concurrent = yield* Effect.all(
          [call(alpha, "parallel-alpha"), call(bravo, "parallel-bravo")],
          { concurrency: 2 },
        );
        assertValue(concurrent[0], "alpha", "parallel-alpha", "rest");
        assertValue(concurrent[1], "bravo", "parallel-bravo", "rest");
        const nativeConcurrent = yield* Effect.all(
          [call(alpha, "native-alpha"), call(bravo, "native-bravo")],
          { concurrency: 2 },
        );
        assertValue(nativeConcurrent[0], "alpha", "native-alpha", "mcp");
        assertValue(nativeConcurrent[1], "bravo", "native-bravo", "mcp");
        const before = upstream.calls.length;
        expect((yield* call(alpha, 42)).status).toBe(422);
        for (const { message, reason } of [
          {
            message: "throw",
            reason: "The connected service request timed out; the action's outcome is unknown",
          },
          {
            message: "badoutput",
            reason: "The connected service request failed: invalid response",
          },
          {
            message: "bad-envelope",
            reason: "The connected service request failed: invalid response",
          },
        ]) {
          const response = yield* call(alpha, message);
          expect(response.status, JSON.stringify(response.body)).toBe(502);
          expect(response.body).toMatchObject({
            _tag: "ToolCallFailed",
            reason,
          });
        }
        expect(upstream.calls.length).toBe(before);
        const error = yield* call(alpha, "toolerror");
        expect(error.status).toBe(200);
        expect(error.body).toEqual({
          content: [{ type: "text", text: "Explicit tool failure" }],
          isError: true,
        });
        const upstreamFailure = yield* call(alpha, "upstream-failure");
        expect(upstreamFailure.status).toBe(502);
        expect(upstreamFailure.body).toMatchObject({
          reason: "unavailable",
          status: 503,
          account: { id: alpha, label: "alpha" },
        });
        expect(
          [...upstream.calls].sort((a, b) => String(a.message).localeCompare(String(b.message))),
        ).toEqual(
          [
            { account: "alpha", path: "rest", message: "fresh" },
            { account: "bravo", path: "read", message: "next" },
            { account: "alpha", path: "read", message: "native-alpha" },
            { account: "bravo", path: "read", message: "native-bravo" },
            { account: "alpha", path: "write", message: "write" },
            { account: "alpha", path: "rest", message: "parallel-alpha" },
            { account: "bravo", path: "rest", message: "parallel-bravo" },
            { account: "alpha", path: "read", message: "upstream-failure" },
          ].sort((a, b) => a.message.localeCompare(b.message)),
        );
        yield* selectProfileAccounts(actors.owner, path, profile.id, { service: [bravo] });
        const deselected = yield* call(alpha, "forbidden");
        expect(deselected.status).toBe(422);
        assertValue(yield* call(bravo, "selected"), "bravo", "selected", "rest");
        expect(upstream.calls.at(-1)).toEqual({
          account: "bravo",
          path: "rest",
          message: "selected",
        });
        const nativeError = yield* call(bravo, "native-toolerror");
        expect(nativeError.status).toBe(200);
        expect(nativeError.body).toEqual({
          content: [{ type: "text", text: "Native tool failure" }],
          isError: true,
        });
        upstream.failHandshake();
        expect((yield* call(bravo, "native-handshake-failure")).status).toBe(502);
        const Summary = Schema.Struct({
          matchedEvents: Schema.Number,
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
        const readSummary = (event: string, groups: readonly string[]) =>
          Effect.gen(function* () {
            const response = yield* api.request(
              actors.owner,
              "GET",
              `${path}/analytics?from=${started}&to=${Date.now()}&event=${event}&${groups.map((group) => `groupBy=${group}`).join("&")}`,
            );
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            return yield* body(Summary, response);
          });
        const upstreamSummary = yield* readSummary("upstream_request", ["transport", "outcome"]);
        expect(upstreamSummary).toMatchObject({
          matchedEvents: 20,
          retentionDays: 30,
          bestEffort: true,
          completeness: "not-guaranteed",
          truncated: false,
        });
        expect(
          upstreamSummary.groups
            .map((group) => ({ ...group, durationMs: 0 }))
            .sort((a, b) =>
              JSON.stringify(a.dimensions).localeCompare(JSON.stringify(b.dimensions)),
            ),
        ).toEqual(
          [
            { dimensions: { transport: "mcp", outcome: null }, count: 6, durationMs: 0 },
            { dimensions: { transport: "mcp", outcome: "error" }, count: 2, durationMs: 0 },
            { dimensions: { transport: "mcp", outcome: "success" }, count: 4, durationMs: 0 },
            { dimensions: { transport: "rest", outcome: null }, count: 4, durationMs: 0 },
            { dimensions: { transport: "rest", outcome: "success" }, count: 4, durationMs: 0 },
          ].sort((a, b) =>
            JSON.stringify(a.dimensions).localeCompare(JSON.stringify(b.dimensions)),
          ),
        );
        const invocations = yield* readSummary("tool_invocation", ["outcome"]);
        expect(invocations.matchedEvents).toBe(30);
        expect(
          invocations.groups
            .map((group) => ({ dimensions: group.dimensions, count: group.count }))
            .sort((a, b) => a.count - b.count),
        ).toEqual([
          { dimensions: { outcome: "error" }, count: 7 },
          { dimensions: { outcome: "success" }, count: 8 },
          { dimensions: { outcome: null }, count: 15 },
        ]);
        const generic = yield* readSummary("webhook_received", ["purpose"]);
        expect(generic.matchedEvents).toBe(15);
        expect(generic.groups).toEqual([
          { dimensions: { purpose: "slack" }, count: 15, durationMs: 0 },
        ]);
        expect((yield* readSummary("invalid", ["event"])).matchedEvents).toBe(0);
        expect(
          (yield* api.request(actors.owner, "GET", `${path}/analytics?from=2&to=1`)).status,
        ).toBe(400);
        expect(
          (yield* api.request(actors.owner, "GET", `${path}/analytics?from=0&to=${Date.now()}`))
            .status,
        ).toBe(400);
        expect(
          (yield* api.request(
            actors.owner,
            "GET",
            `${path}/analytics?from=${started}&to=${Date.now()}&groupBy=accountId`,
          )).status,
        ).toBe(400);
      }),
    ),
  );
});
