import type { ProviderError } from "../contracts/provider-error.ts";
import { ToolResultObservation } from "../contracts/host.ts";
/** Adapt any MCP transport into ordinary tools with shared validation behavior. */
import { Effect, Schema } from "effect";
import {
  McpError,
  McpToolResult,
  type McpTools,
  type McpToolMetadata,
  type McpOperationInterceptor,
  type McpToolContext,
} from "../contracts/mcp.ts";
import { JsonObject, compileJsonSchemaDecoder, jsonSchemaDecoder } from "../effect.ts";
import type { AppContext } from "../contracts/context.ts";
import type { JsonValue } from "../contracts/schema.ts";
import type { McpClient } from "./mcp-client.ts";
import { mcpResultSchema } from "./mcp-result-schema.ts";
import { once } from "./schema.ts";

/** Compile only the selected tool and bind its executable to the current invocation. */
const adaptTool = <Context extends McpToolContext, E>(
  tool: McpToolMetadata,
  call: (context: Context, input: JsonObject) => Effect.Effect<McpToolResult, E>,
) =>
  Effect.gen(function* () {
    const decoder = yield* jsonSchemaDecoder(tool.inputSchema).pipe(
      Effect.mapError(() => new McpError({ phase: "schema", reason: "invalid_response" })),
    );
    const output =
      tool.outputSchema === undefined
        ? undefined
        : yield* Effect.cached(
            compileJsonSchemaDecoder(tool.outputSchema).pipe(
              Effect.mapError(() => new McpError({ phase: "schema", reason: "invalid_response" })),
            ),
          );
    const resultSchema = once(() => mcpResultSchema(tool.outputSchema));
    const adapted = {
      ...tool,
      get outputSchema() {
        return resultSchema();
      },
      description: tool.description ?? tool.title ?? tool.name,
      input: decoder,
      ...(tool.annotations?.readOnlyHint === undefined
        ? {}
        : { readOnly: tool.annotations.readOnlyHint }),
      run: (context: Context, input: JsonValue) =>
        Effect.gen(function* () {
          const arguments_ = yield* Schema.decodeUnknownEffect(decoder)(input).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(JsonObject)),
            Effect.mapError(() => new McpError({ phase: "call", reason: "invalid_input" })),
          );
          // Compile the selected output schema before sending a potentially
          // mutating call, so an unsupported schema cannot fail after its effects.
          const outputDecoder = output === undefined ? undefined : yield* output;
          const result = yield* call(context, arguments_);
          if (result.isError === true) {
            (yield* ToolResultObservation).failed();
            yield* Effect.annotateCurrentSpan({
              "executor.outcome": "failed",
              "error.type": "McpToolError",
            });
          }
          if (outputDecoder !== undefined && !result.isError)
            yield* Schema.decodeUnknownEffect(outputDecoder)(result.structuredContent).pipe(
              Effect.mapError(() => new McpError({ phase: "call", reason: "invalid_response" })),
            );
          return result;
        }),
    };
    return adapted;
  });

export const adaptMcpTool = (client: McpClient, tool: McpToolMetadata) =>
  adaptTool(tool, (context: McpToolContext, input) => client.call(tool.name, input, context));

export const adaptMcpOperation = (
  client: McpClient,
  tool: McpToolMetadata,
  intercept?: McpOperationInterceptor,
) =>
  adaptTool(tool, (context: AppContext, input) =>
    intercept === undefined
      ? client.call(tool.name, input, context)
      : Effect.gen(function* () {
          const runtime = yield* Effect.context<never>();
          const result = yield* Effect.tryPromise({
            try: () =>
              intercept({
                tool,
                context,
                input,
                next: () =>
                  Effect.runPromiseWith(runtime)(client.call(tool.name, input, context), {
                    signal: context.signal,
                  }),
              }),
            catch: (error) => error,
          });
          return yield* Schema.decodeUnknownEffect(McpToolResult)(result).pipe(
            Effect.mapError(() => new McpError({ phase: "call", reason: "invalid_response" })),
          );
        }),
  );

/** Discover a complete catalog for probes and uncached low-level callers. */
export const adaptMcpTools = (
  client: McpClient,
): Effect.Effect<McpTools, McpError | ProviderError> =>
  Effect.gen(function* () {
    const metadata = yield* client.list;
    const entries = yield* Effect.forEach(metadata, (tool) =>
      adaptMcpTool(client, tool).pipe(Effect.map((adapted) => [tool.name, adapted] as const)),
    );
    return Object.fromEntries(entries);
  });
