import type { OperationContext } from "../contracts/operations.ts";
import {
  type McpOperationInterceptor,
  type McpToolContext,
  McpToolResult,
} from "../contracts/mcp.ts";
import type { ProviderError } from "../contracts/provider-error.ts";
import type { NetworkRefused } from "../contracts/network.ts";
import { ToolResultObservation } from "../contracts/host.ts";
/** Adapt any MCP transport into ordinary tools with shared validation behavior. */
import { Effect, JsonPointer, Schema } from "effect";
import { McpError, type McpTools, type McpToolMetadata } from "../contracts/mcp.ts";
import { JsonObject, type JsonValue, jsonSchemaDecoder } from "../effect.ts";
import type { McpClient } from "./mcp-client.ts";
import { nestJsonSchema, preparedJsonSchemaDecoder } from "./schema.ts";

/** The fields of every `McpToolResult`. */
const resultFields = {
  content: { type: "array", items: { type: "object" } },
  structuredContent: { type: "object" },
  isError: { type: "boolean" },
  _meta: { type: "object" },
} satisfies JsonObject;

/** References that resolve the same from any document root that holds the same definitions. */
const definitionReference = /^#\/(?:\$defs|definitions)\/[^/]+$/;
/** Keywords that resolve relative to the schema resource that contains them. */
const locating = new Set(["$id", "$anchor", "$dynamicAnchor", "$recursiveAnchor"]);
const onlyDefinitionReferences = (value: JsonValue): boolean =>
  Array.isArray(value)
    ? value.every(onlyDefinitionReferences)
    : value === null || typeof value !== "object"
      ? true
      : Object.entries(value).every(([key, item]) =>
          locating.has(key) || key === "$dynamicRef" || key === "$recursiveRef"
            ? false
            : key === "$ref"
              ? typeof item === "string" && definitionReference.test(item)
              : onlyDefinitionReferences(item),
        );

/** Whether every definition reference in the schema names a definition the schema holds. */
const definitionsResolve = (schema: JsonObject): boolean => {
  const defined = (group: JsonValue | undefined) =>
    group !== null && typeof group === "object" && !Array.isArray(group) ? group : {};
  const groups = { $defs: defined(schema.$defs), definitions: defined(schema.definitions) };
  const resolves = (value: JsonValue): boolean =>
    Array.isArray(value)
      ? value.every(resolves)
      : value === null || typeof value !== "object"
        ? true
        : Object.entries(value).every(([key, item]) => {
            if (key !== "$ref" || typeof item !== "string") return resolves(item);
            const [, group, name] = item.split("/");
            return (
              (group === "$defs" || group === "definitions") &&
              name !== undefined &&
              Object.hasOwn(groups[group], JsonPointer.unescapeToken(name))
            );
          });
  return resolves(schema);
};

/**
 * Place a server's output schema at `pointer` in a result schema. Its definitions move to the
 * result's root when every reference names one, so its references, and the named types an agent
 * reads, stay as the server wrote them. Otherwise references are rewritten to the new location.
 * One whose references cannot be resolved or relocated is `undefined`.
 */
const placed = (
  structuredContent: JsonObject,
  pointer: string,
): { readonly schema: JsonObject; readonly root: JsonObject } | undefined => {
  if (onlyDefinitionReferences(structuredContent)) {
    if (!definitionsResolve(structuredContent)) return undefined;
    const { $defs, definitions, $schema: _draft, ...schema } = structuredContent;
    return {
      schema,
      root: {
        ...($defs === undefined ? {} : { $defs }),
        ...(definitions === undefined ? {} : { definitions }),
      },
    };
  }
  try {
    return { schema: nestJsonSchema(structuredContent, pointer), root: {} };
  } catch {
    return undefined;
  }
};

/** A result whose successful `structuredContent` matches `schema`, with `root` beside its envelope. */
const envelope = (schema: JsonObject, root: JsonObject = {}, draft?: JsonValue): JsonObject => ({
  // The envelope's keywords mean the same in every draft, so the server's draft applies.
  ...(draft === undefined ? {} : { $schema: draft }),
  ...root,
  anyOf: [
    {
      type: "object",
      properties: { ...resultFields, structuredContent: schema, isError: { const: false } },
      required: ["content", "structuredContent"],
    },
    {
      type: "object",
      properties: { ...resultFields, isError: { const: true } },
      required: ["content", "isError"],
    },
  ],
});

/**
 * The output schema of a call, which returns the whole `McpToolResult`. A server's own output
 * schema describes only `structuredContent`: a successful result must match it, and a remote
 * tool failure (`isError: true`) is not required to. Without one, any result object is described.
 * A server schema that cannot be placed is `undefined`.
 */
const resultSchema = (structuredContent: JsonObject | undefined): JsonObject | undefined => {
  if (structuredContent === undefined)
    return { type: "object", properties: resultFields, required: ["content"] };
  const location = placed(structuredContent, "#/anyOf/0/properties/structuredContent");
  return location === undefined
    ? undefined
    : envelope(location.schema, location.root, structuredContent.$schema);
};

/** Compile only the selected tool and bind its executable to the current invocation. */
const adaptTool = <Context extends McpToolContext, E>(
  tool: McpToolMetadata,
  call: (context: Context, input: JsonObject) => Effect.Effect<McpToolResult, E>,
) =>
  Effect.gen(function* () {
    const decoder = yield* jsonSchemaDecoder(tool.inputSchema).pipe(
      Effect.mapError(() => new McpError({ phase: "schema", reason: "invalid_response" })),
    );
    // One schema both describes and checks the result: the host decodes every call's
    // returned value with `output`, and catalogs render the same decoder's document. A server
    // schema that cannot be placed is described as generic structured content, and the call
    // compiles the server's own schema first, so it fails before anything is sent.
    const result = resultSchema(tool.outputSchema);
    const output = preparedJsonSchemaDecoder(result ?? envelope({ type: "object" }));
    const compile =
      result === undefined
        ? preparedJsonSchemaDecoder(envelope(tool.outputSchema ?? {})).compile
        : output.compile;
    const { outputSchema: _upstream, ...metadata } = tool;
    const adapted = {
      ...metadata,
      description: tool.description ?? tool.title ?? tool.name,
      input: decoder,
      output: output.decoder,
      ...(tool.annotations?.readOnlyHint === undefined
        ? {}
        : { readOnly: tool.annotations.readOnlyHint }),
      run: (context: Context, input: JsonValue) =>
        Effect.gen(function* () {
          const arguments_ = yield* Schema.decodeUnknownEffect(decoder)(input).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(JsonObject)),
            Effect.mapError(() => new McpError({ phase: "call", reason: "invalid_input" })),
          );
          // Compile the output schema before sending a potentially mutating
          // call, so an unsupported schema cannot fail after its effects.
          yield* compile.pipe(
            Effect.mapError(() => new McpError({ phase: "schema", reason: "invalid_response" })),
          );
          const result = yield* call(context, arguments_);
          if (result.isError === true) {
            (yield* ToolResultObservation).failed();
            yield* Effect.annotateCurrentSpan({
              "executor.outcome": "failed",
              "error.type": "McpToolError",
            });
          }
          // A result that breaks the tool's declared contract, from its server or an interceptor,
          // is the server's invalid response, not the app's own error.
          return yield* Schema.decodeUnknownEffect(output.decoder)(result).pipe(
            Effect.as(result),
            Effect.mapError(() => new McpError({ phase: "call", reason: "invalid_response" })),
          );
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
  adaptTool(tool, (context: OperationContext, input) =>
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
): Effect.Effect<McpTools, McpError | ProviderError | NetworkRefused> =>
  Effect.gen(function* () {
    const { tools: metadata } = yield* client.list;
    const entries = yield* Effect.forEach(metadata, (tool) =>
      adaptMcpTool(client, tool).pipe(Effect.map((adapted) => [tool.name, adapted] as const)),
    );
    return Object.fromEntries(entries);
  });
