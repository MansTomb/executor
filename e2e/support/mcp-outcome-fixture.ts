/** A synthetic upstream MCP endpoint, using only the public JSON-RPC wire contract. */
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Deferred, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

const Rpc = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.String,
  params: Schema.optionalKey(
    Schema.Struct({
      arguments: Schema.optionalKey(Schema.Struct({ fail: Schema.optionalKey(Schema.Boolean) })),
    }),
  ),
});

/** How long `/slow` waits before it answers. */
export const slowUpstreamMs = 400;

/** Return a real listener owned by the current test scope; no application services are replaced. */
export const mcpOutcomeFixture = Effect.gen(function* () {
  const arrived = yield* Deferred.make<void>();
  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const rpc = yield* request.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Rpc)));
    if (rpc.id === undefined) return HttpServerResponse.empty({ status: 202 });
    const failed = rpc.params?.arguments?.fail !== false;
    const result =
      rpc.method === "initialize"
        ? {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "synthetic-outcomes", version: "1" },
          }
        : rpc.method === "tools/list"
          ? {
              tools: ["failure", "approvedFailure"].map((name) => ({
                name,
                description: "Synthetic upstream tool failure",
                inputSchema: { type: "object", properties: { fail: { type: "boolean" } } },
                annotations: { readOnlyHint: name === "failure" },
              })),
            }
          : rpc.method === "tools/call"
            ? {
                isError: failed,
                content: [
                  {
                    type: "text",
                    text: failed ? "Synthetic upstream failure" : "Synthetic upstream success",
                  },
                ],
              }
            : {};
    return HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: rpc.id, result });
  }).pipe(Effect.orDie);
  const services = yield* Layer.build(
    HttpRouter.serve(
      Layer.mergeAll(
        HttpRouter.add("POST", "/mcp", handler),
        HttpRouter.add("GET", "/ping", Effect.succeed(HttpServerResponse.text("ok"))),
        // A provider that answers after a known wait, so a caller can tell that wait from its own.
        HttpRouter.add(
          "GET",
          "/slow",
          Effect.sleep(`${slowUpstreamMs} millis`).pipe(Effect.as(HttpServerResponse.text("ok"))),
        ),
        // One call announces it is running; another waits for that before it answers.
        HttpRouter.add(
          "GET",
          "/arrived",
          Deferred.succeed(arrived, undefined).pipe(Effect.as(HttpServerResponse.text("ok"))),
        ),
        HttpRouter.add(
          "GET",
          "/after-arrival",
          Deferred.await(arrived).pipe(Effect.as(HttpServerResponse.text("ok"))),
        ),
      ),
      { disableLogger: true, disableListenLog: true },
    ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address))
    return yield* Effect.die("The MCP fixture requires a TCP listener");
  return `http://127.0.0.1:${server.address.port}`;
});
