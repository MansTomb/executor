import { Effect, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/ai";
import { McpRequestContext } from "effect/ai/McpSchema";

const isArray = (value: Schema.Json | undefined): value is ReadonlyArray<Schema.Json> =>
  Array.isArray(value);

export const compactResult = (value: Schema.Json): Schema.Json => {
  if (isArray(value)) return value.map(compactResult);
  if (value === null || typeof value !== "object") return value;
  const structured = value.structuredContent;
  const content = value.content;
  const duplicate =
    structured !== undefined && isArray(content)
      ? content.filter((block) => {
          if (
            block === null ||
            typeof block !== "object" ||
            isArray(block) ||
            block.type !== "text" ||
            typeof block.text !== "string" ||
            Object.keys(block).some((key) => key !== "type" && key !== "text")
          )
            return true;
          try {
            return JSON.stringify(JSON.parse(block.text)) !== JSON.stringify(structured);
          } catch {
            return true;
          }
        })
      : content;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      compactResult(key === "content" ? (duplicate ?? item) : item),
    ]),
  );
};

export const compactToolkit = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
) =>
  Layer.effectDiscard(
    McpServer.registerToolkit(toolkit).pipe(
      Effect.updateService(McpServer.McpServer, (server) => ({
        ...server,
        addTool: (options) =>
          server.addTool({
            ...options,
            handle: (payload) =>
              Effect.gen(function* () {
                const request = yield* McpRequestContext;
                const result = yield* options.handle(payload);
                if (!("structuredContent" in result) || result.structuredContent === undefined)
                  return result;
                const value = compactResult(result.structuredContent);
                if (request.protocolVersion < "2025-06-18") {
                  const { structuredContent: _structured, ...rest } = result;
                  return {
                    ...rest,
                    content: [{ type: "text" as const, text: JSON.stringify(value) }],
                  };
                }
                return { ...result, content: [], structuredContent: value };
              }),
          }),
      })),
    ),
  ).pipe(Layer.provide(McpServer.McpServer.layer));
