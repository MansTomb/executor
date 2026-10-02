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

const JsonObject = Schema.Record(Schema.String, Schema.Json);
const Result = Schema.Struct({
  execution: Schema.Struct({ ok: Schema.Boolean, value: Schema.optional(Schema.Json) }),
});
const Wire = Schema.Struct({
  id: Schema.optionalKey(Schema.Json),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Struct({ name: Schema.optionalKey(Schema.String) })),
});
const machines = { machines: [{ name: "fixture", reachable: true }] };
const structured = {
  content: [{ type: "text", text: "Synthetic machines" }],
  structuredContent: machines,
  isError: false,
  _meta: { receipt: "synthetic" },
};
const failure = {
  content: [{ type: "text", text: "Synthetic failure" }],
  isError: true,
  _meta: { receipt: "synthetic-error" },
};
const machineSchema = {
  type: "object",
  properties: { machines: { type: "array", items: { $ref: "#/$defs/Machine" } } },
  required: ["machines"],
  $defs: {
    Machine: {
      type: "object",
      properties: { name: { type: "string" }, reachable: { type: "boolean" } },
      required: ["name", "reachable"],
    },
  },
};
const treeSchema = {
  $id: "https://fixture.invalid/tree",
  $recursiveAnchor: true,
  type: "object",
  properties: {
    value: { type: "string" },
    child: { anyOf: [{ type: "null" }, { $recursiveRef: "#" }] },
  },
  required: ["value"],
};

const upstream = Effect.gen(function* () {
  const called: string[] = [];
  const tools = [
    { name: "machines", outputSchema: machineSchema },
    { name: "tree", outputSchema: treeSchema },
    {
      name: "static_tree",
      outputSchema: {
        type: "object",
        properties: { value: { type: "string" }, child: { $recursiveRef: "#" } },
        required: ["value"],
      },
    },
    { name: "content_only" },
    { name: "failure", outputSchema: machineSchema },
    { name: "invalid", outputSchema: machineSchema },
    { name: "unsupported", outputSchema: { type: "object", $ref: "#/$defs/Missing" } },
  ];
  const services = yield* Layer.build(
    HttpRouter.serve(
      Layer.mergeAll(
        HttpRouter.add("GET", "/mcp", HttpServerResponse.empty({ status: 405 })),
        HttpRouter.add(
          "POST",
          "/mcp",
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const variant = request.headers["x-fixture-variant"] ?? "fixture";
            const message = yield* request.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Wire)),
            );
            if (message.id === undefined) return HttpServerResponse.empty({ status: 202 });
            const reply = (result: Schema.Json) =>
              HttpServerResponse.json({ jsonrpc: "2.0", id: message.id ?? null, result });
            if (message.method === "initialize")
              return yield* reply({
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "result-contract", version: "1" },
              });
            if (message.method === "tools/list")
              return yield* reply({
                tools: tools
                  .filter((tool) => tool.name !== "unsupported" || variant === "fixture")
                  .map((tool) => ({
                    ...tool,
                    ...(tool.name === "machines"
                      ? {
                          outputSchema: {
                            ...machineSchema,
                            $defs: {
                              Machine: {
                                ...machineSchema.$defs.Machine,
                                properties: {
                                  ...machineSchema.$defs.Machine.properties,
                                  name: { const: variant },
                                },
                              },
                            },
                          },
                        }
                      : {}),
                    description: `Synthetic ${tool.name}`,
                    inputSchema: { type: "object" },
                    annotations: { readOnlyHint: true },
                  })),
              });
            if (message.method === "tools/call") called.push(message.params?.name ?? "");
            switch (message.params?.name) {
              case "machines":
                return yield* reply({
                  ...structured,
                  structuredContent: { machines: [{ name: variant, reachable: true }] },
                });
              case "tree":
              case "static_tree":
                return yield* reply({
                  content: [],
                  structuredContent: { value: "root", child: { value: "leaf" } },
                });
              case "content_only":
                return yield* reply({ content: [{ type: "text", text: "Synthetic text" }] });
              case "failure":
                return yield* reply(failure);
              case "invalid":
                return yield* reply({ content: [], structuredContent: { machines: "invalid" } });
              default:
                return yield* reply({});
            }
          }),
        ),
      ),
      { disableLogger: true, disableListenLog: true },
    ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Expected TCP fixture");
  return { url: `http://127.0.0.1:${server.address.port}/mcp`, called };
});

layer(HostedLive, { excludeTestServices: true })("MCP result contracts", (it) => {
  it.effect(scenarios.mcpResultContract.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const evidence = yield* Evidence;
        const mcp = yield* McpClient;
        const fixture = yield* upstream;
        const { url } = fixture;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Resultcontract${randomUUID().replaceAll("-", "").slice(0, 8)}`,
          files: [
            {
              path: "package.json",
              content: JSON.stringify({
                dependencies: {
                  "@modelcontextprotocol/sdk": "1.30.0",
                },
              }),
            },
            {
              path: "index.ts",
              content: `import { defineApp, query, object, json, jsonSchema } from "apps";
import { mcpOperations } from "apps/mcp";
export default defineApp({ accounts: {} }, async ({ signal, cache }) => ({
  ...await mcpOperations({ url: ${JSON.stringify(url)}, signal, cache }),
  queries: {
    validate_schema: query({ input: object({ schema: json(), values: json() }) }, async (_, { schema, values }) => {
      const decoder = jsonSchema(schema);
      return values.map(value => {
        try { decoder.parse(value); return true; } catch { return false; }
      });
    }),
  },
}));`,
            },
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );
        const listed = yield* api.request(actors.owner, "GET", `${path}/tools`);
        expect(listed.status, "Unused unsupported output must not hide other tools").toBe(200);
        const descriptions = yield* body(
          Schema.Struct({
            items: Schema.Array(
              Schema.Struct({ name: Schema.String, outputSchema: Schema.optionalKey(JsonObject) }),
            ),
          }),
          listed,
        );
        yield* evidence.json("discovered-schemas.json", descriptions);
        const schemas = new Map(descriptions.items.map((tool) => [tool.name, tool.outputSchema]));
        const schemaFor = (name: string) => {
          const schema = schemas.get(`queries.${name}`);
          if (schema === undefined) throw new Error(`Missing output schema for ${name}`);
          return schema;
        };
        const validate = (schema: typeof JsonObject.Type, values: Schema.Json[]) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
              tool: "queries.validate_schema",
              input: { schema, values },
            });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            return yield* body(Schema.Array(Schema.Boolean), response);
          });
        const machineValidation = yield* validate(schemaFor("machines"), [
          structured,
          machines,
          failure,
          { ...structured, structuredContent: { machines: "invalid" } },
          { content: [], isError: false },
        ]);
        yield* evidence.json("envelope-validation.json", machineValidation);
        expect(
          machineValidation,
          "Accept native success and error envelopes, reject payload-only and malformed successes",
        ).toEqual([true, false, true, false, false]);
        expect(
          yield* validate(schemaFor("tree"), [
            { content: [], structuredContent: { value: "root", child: { value: "leaf" } } },
            { content: [], structuredContent: { value: "root", child: null } },
            { content: [], structuredContent: { value: "root", child: { value: 42 } } },
          ]),
        ).toEqual([true, true, false]);
        expect(
          yield* validate(schemaFor("static_tree"), [
            { content: [], structuredContent: { value: "root", child: { value: "leaf" } } },
            { content: [], structuredContent: { value: "root", child: { value: 42 } } },
          ]),
        ).toEqual([true, false]);
        expect(
          yield* validate(schemaFor("content_only"), [
            { content: [{ type: "text", text: "Synthetic text" }] },
            { content: [], structuredContent: { arbitrary: [1, null] } },
          ]),
        ).toEqual([true, true]);
        expect(
          yield* validate(schemaFor("unsupported"), [
            { content: [], structuredContent: {} },
            { content: [], isError: false },
            failure,
          ]),
        ).toEqual([true, false, true]);

        const call = (name: string) =>
          api.request(actors.owner, "POST", `${path}/tools/call`, {
            tool: `queries.${name}`,
            input: {},
          });
        expect((yield* call("machines")).body).toEqual(structured);
        expect((yield* call("failure")).body).toEqual(failure);
        expect((yield* call("content_only")).body).toEqual({
          content: [{ type: "text", text: "Synthetic text" }],
        });
        expect((yield* call("tree")).body).toEqual({
          content: [],
          structuredContent: { value: "root", child: { value: "leaf" } },
        });
        const invalid = yield* call("invalid");
        expect(invalid.status).toBeGreaterThanOrEqual(400);
        yield* evidence.json("invalid-output.json", invalid);
        const unsupported = yield* call("unsupported");
        expect(unsupported.status).toBeGreaterThanOrEqual(400);
        expect(fixture.called).not.toContain("unsupported");

        const groupedResponse = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Groupedresult${randomUUID().replaceAll("-", "").slice(0, 8)}`,
          files: [
            {
              path: "package.json",
              content: JSON.stringify({ dependencies: { "@modelcontextprotocol/sdk": "1.30.0" } }),
            },
            {
              path: "index.ts",
              content: `import { defineApp, accountOperations } from "apps";
import { mcpOperations } from "apps/mcp";
export default defineApp({ accounts: {} }, async ({ signal, cache }) =>
  accountOperations([{ id: "first" }, { id: "second" }], account => mcpOperations({
    url: ${JSON.stringify(url)}, headers: { "X-Fixture-Variant": account.id }, signal, cache,
  }), { signal }),
);`,
            },
          ],
        });
        expect(groupedResponse.status, JSON.stringify(groupedResponse.body)).toBe(200);
        const groupedApp = yield* body(App, groupedResponse);
        const groupedPath = `${prefix}/${groupedApp.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", groupedPath).pipe(Effect.orDie),
        );
        const grouped = yield* body(
          Schema.Struct({
            items: Schema.Array(Schema.Struct({ name: Schema.String, outputSchema: JsonObject })),
          }),
          yield* api.request(actors.owner, "GET", `${groupedPath}/tools`),
        );
        for (const name of ["tree", "static_tree"]) {
          const schema = grouped.items.find(
            (tool) => tool.name === `queries.${name}`,
          )?.outputSchema;
          if (schema === undefined) return yield* Effect.die(`Missing grouped ${name} schema`);
          expect(
            yield* validate(schema, [
              { content: [], structuredContent: { value: "root", child: { value: "leaf" } } },
              ...(name === "tree"
                ? [{ content: [], structuredContent: { value: "root", child: null } }]
                : []),
              { content: [], structuredContent: { value: "root", child: { value: 42 } } },
            ]),
          ).toEqual(name === "tree" ? [true, true, false] : [true, false]);
        }
        const groupedMachines = grouped.items.find(
          (tool) => tool.name === "queries.machines",
        )?.outputSchema;
        if (groupedMachines === undefined)
          return yield* Effect.die("Missing grouped machines schema");
        expect(
          yield* validate(groupedMachines, [
            { content: [], structuredContent: { machines: [{ name: "first", reachable: true }] } },
            { content: [], structuredContent: { machines: [{ name: "second", reachable: true }] } },
            structured,
          ]),
        ).toEqual([true, true, false]);
        yield* evidence.json("grouped-schemas.json", grouped);

        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Result contract",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(key.key, "result-contract", {
          organization: actors.organization.id,
        });
        const execute = (code: string) =>
          client
            .use("Read MCP result contract", (client) =>
              client.callTool({ name: "execute", arguments: { code } }),
            )
            .pipe(
              Effect.flatMap((reply) =>
                Schema.decodeUnknownEffect(Result)(reply.structuredContent),
              ),
            );
        const found = yield* execute(
          `return await tools.search({ namespace: ${JSON.stringify(app.slug)}, query: "machines", limit: 1 });`,
        );
        expect(found.execution.ok).toBe(true);
        const search = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            items: Schema.Array(Schema.Struct({ path: Schema.String, signature: Schema.String })),
          }),
        )(found.execution.value);
        expect(search.items).toHaveLength(1);
        const selected = search.items[0];
        if (selected === undefined) return yield* Effect.die("Missing discovered tool");
        expect(selected.signature).toContain("structuredContent");
        expect(selected.signature).toContain("machines");
        expect(selected.signature).toContain("isError");
        expect(selected.signature).toContain("_meta");
        const invoked = yield* execute(
          `const result = await ${selected.path}({}); return result.structuredContent.machines;`,
        );
        expect(invoked.execution).toMatchObject({
          ok: true,
          value: [{ name: "fixture", reachable: true }],
        });
        yield* evidence.json("search-and-call.json", { search, invoked });
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
