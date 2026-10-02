import { Schema } from "effect";
import { McpToolResult } from "../contracts/mcp.ts";
import { JsonObject, ValidationError } from "../contracts/schema.ts";
import { nestJsonSchema } from "./schema.ts";

const document = Schema.toJsonSchemaDocument(
  McpToolResult.mapFields((fields) => ({
    ...fields,
    structuredContent: Schema.optionalKey(JsonObject),
    isError: Schema.optionalKey(Schema.Boolean),
    _meta: Schema.optionalKey(JsonObject),
  })),
);
const result = Schema.decodeUnknownSync(JsonObject)({
  ...document.schema,
  $defs: document.definitions,
});
const properties = Schema.decodeUnknownSync(JsonObject)(result.properties);

export const mcpResultSchema = (output: JsonObject | undefined): JsonObject => {
  if (output === undefined) return result;
  let structuredContent: JsonObject;
  try {
    structuredContent = nestJsonSchema(output, "#/anyOf/0/properties/structuredContent");
  } catch (error) {
    if (!Schema.is(ValidationError)(error)) throw error;
    structuredContent = { type: "object" };
  }
  return {
    anyOf: [
      {
        ...result,
        properties: {
          ...properties,
          structuredContent,
          isError: { const: false },
        },
        required: ["content", "structuredContent"],
      },
      {
        ...result,
        properties: { ...properties, isError: { const: true } },
        required: ["content", "isError"],
      },
    ],
  };
};
