import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Deferred, Effect, Layer, Schema } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { createServer } from "node:http";

export const clickupUpstream = (issuer: string) =>
  Effect.gen(function* () {
    const address = yield* Deferred.make<string>();
    const calls: { transport: "rest" | "mcp"; operation: "identity" | "task"; task?: string }[] =
      [];
    let name = "Initial task",
      attachment = "Original attachment";
    let failure: number | undefined;
    const task = (id: string) => ({
      id,
      team_id: "5678",
      custom_id: null,
      custom_item_id: 0,
      name,
      markdown_description: "Current description",
      text_content: "Current description",
      url: `https://tasks.test/${id}`,
      status: { status: "open", color: "blue" },
      date_created: "1",
      date_updated: "1",
      date_closed: null,
      creator: { id: 1234, username: "Synthetic user" },
      assignees: [],
      tags: [],
      parent: null,
      priority: null,
      due_date: null,
      start_date: null,
      time_estimate: null,
      list: { id: "list" },
      folder: { id: "folder" },
      space: { id: "space" },
      custom_fields: [],
      checklists: [],
      dependencies: [],
      linked_tasks: [],
      watchers: [],
      attachments: [{ id: "attachment", title: attachment }],
    });
    const Wire = Schema.Struct({
      id: Schema.optionalKey(Schema.Json),
      method: Schema.String,
      params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
    });
    const challenge = Effect.gen(function* () {
      const origin = yield* Deferred.await(address);
      return HttpServerResponse.empty({
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        },
      });
    });
    const routes = Layer.mergeAll(
      HttpRouter.add(
        "GET",
        "/.well-known/oauth-protected-resource/mcp",
        Effect.gen(function* () {
          const origin = yield* Deferred.await(address);
          return yield* HttpServerResponse.json({
            resource: `${origin}/mcp`,
            authorization_servers: [issuer],
            scopes_supported: ["read"],
          });
        }),
      ),
      HttpRouter.add(
        "GET",
        "/mcp",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          return request.headers.authorization
            ? HttpServerResponse.empty({ status: 405 })
            : yield* challenge;
        }),
      ),
      HttpRouter.add(
        "POST",
        "/mcp",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (!request.headers.authorization) return yield* challenge;
          const wire = yield* request.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Wire)));
          if (wire.id === undefined) return HttpServerResponse.empty({ status: 202 });
          const respond = (result: Schema.Json) =>
            HttpServerResponse.json({ jsonrpc: "2.0", id: wire.id ?? null, result });
          if (wire.method === "initialize")
            return yield* respond({
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "ClickUp fixture", version: "1" },
            });
          if (wire.method === "tools/list")
            return yield* respond({
              tools: [
                {
                  name: "clickup_get_task",
                  description: "Read synthetic task",
                  inputSchema: {
                    type: "object",
                    properties: {
                      task_id: { type: "string" },
                      workspace_id: { type: "string" },
                      include: { type: "array", items: { type: "string" } },
                    },
                    required: ["task_id"],
                    additionalProperties: false,
                  },
                  annotations: { readOnlyHint: true },
                },
              ],
            });
          if (wire.method === "tools/call") {
            const operation = String(wire.params?.name);
            if (operation === "clickup_resolve_assignees") {
              expectIdentity(wire.params?.arguments);
              calls.push({ transport: "mcp", operation: "identity" });
              return yield* respond({ content: [], structuredContent: { userIds: ["1234"] } });
            }
            const input = Schema.decodeUnknownSync(Schema.Struct({ task_id: Schema.String }))(
              wire.params?.arguments,
            );
            calls.push({ transport: "mcp", operation: "task", task: input.task_id });
            return yield* respond({
              content: [{ type: "text", text: "Live MCP comments" }],
              structuredContent: {
                id: input.task_id,
                source: "mcp",
                comments: ["Current comment"],
              },
            });
          }
          return yield* respond({});
        }),
      ),
      HttpRouter.add(
        "GET",
        "/api/v2/user",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.headers.authorization !== "synthetic-rest")
            return HttpServerResponse.empty({ status: 401 });
          calls.push({ transport: "rest", operation: "identity" });
          return yield* HttpServerResponse.json({ user: { id: 1234 } });
        }),
      ),
      HttpRouter.add(
        "GET",
        "/api/v2/task/:id",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const input = yield* HttpRouter.params;
          const id = String(input.id);
          if (request.headers.authorization !== "synthetic-rest")
            return HttpServerResponse.empty({ status: 401 });
          calls.push({ transport: "rest", operation: "task", task: id });
          return failure === undefined
            ? yield* HttpServerResponse.json(task(id))
            : HttpServerResponse.empty({
                status: failure,
                ...(failure === 302 ? { headers: { location: "/api/v2/user" } } : {}),
              });
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
    const origin = `http://127.0.0.1:${server.address.port}`;
    yield* Deferred.succeed(address, origin);
    return {
      origin,
      calls,
      edit: () => {
        name = "Remote edit";
        attachment = "Changed attachment";
      },
      fail: (status: number) => {
        failure = status;
      },
    };
  });

const expectIdentity = (input: unknown) => {
  const value = Schema.decodeUnknownSync(
    Schema.Struct({ assignees: Schema.Array(Schema.String), workspace_id: Schema.String }),
  )(input);
  if (value.workspace_id !== "5678" || value.assignees.length !== 1 || value.assignees[0] !== "me")
    throw new Error("Unexpected identity request");
};
