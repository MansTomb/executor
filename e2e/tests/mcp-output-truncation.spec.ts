/** A result cut by the execute output limit says so before the cut value, in both MCP forms. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { McpClient } from "../support/mcp-client.ts";

const outputLimitBytes = 65_536;
// Pi and other agent harnesses keep only this many leading characters of a tool result.
const callerPrefixChars = 30_000;

const Response = Schema.Struct({
  content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
  structuredContent: Schema.Struct({
    status: Schema.Literal("completed"),
    truncation: Schema.optional(
      Schema.Struct({ outputLimitBytes: Schema.Number, notice: Schema.String }),
    ),
    execution: Schema.Struct({
      ok: Schema.Literal(true),
      value: Schema.Unknown,
      logs: Schema.optional(Schema.Array(Schema.String)),
      truncated: Schema.optional(Schema.Boolean),
    }),
  }),
});

layer(HostedLive, { excludeTestServices: true })("MCP output truncation", (it) => {
  it.effect(scenarios.mcpOutputTruncation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient,
          evidence = yield* Evidence;
        const key = yield* body(
          Schema.Struct({
            id: Schema.String,
            key: Schema.RedactedFromValue(Schema.String),
          }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Output truncation",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", {
              keyId: key.id,
            })
            .pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(key.key, "output-truncation", {
          organization: actors.organization.id,
        });
        const execute = (label: string, code: string) =>
          Effect.gen(function* () {
            const result = yield* client.use(label, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
            );
            const response = yield* Schema.decodeUnknownEffect(Response)(result);
            const text = response.content.map((block) => block.text).join("\n");
            yield* evidence.json(`${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}.json`, {
              truncation: response.structuredContent.truncation,
              truncated: response.structuredContent.execution.truncated,
              textChars: text.length,
              textStart: text.slice(0, 600),
            });
            return { ...response.structuredContent, text };
          });
        const expectIncomplete = (result: Effect.Success<ReturnType<typeof execute>>) => {
          expect(result.execution.ok).toBe(true);
          expect(result.execution.truncated).toBe(true);
          expect(result.truncation?.outputLimitBytes).toBe(outputLimitBytes);
          expect(result.truncation?.notice).toContain(
            `exceeded the ${outputLimitBytes}-byte output limit`,
          );
          expect(result.truncation?.notice).toContain("execution.ok reports that the program ran");
          const visible = result.text.slice(0, callerPrefixChars);
          expect(visible.startsWith('{"status":"completed","truncation":{')).toBe(true);
          expect(visible).toContain(`"outputLimitBytes":${outputLimitBytes}`);
          expect(visible).toContain("Output incomplete");
        };
        const expectComplete = (result: Effect.Success<ReturnType<typeof execute>>) => {
          expect(result.execution.ok).toBe(true);
          expect(result.execution.truncated).toBeUndefined();
          expect(result.truncation).toBeUndefined();
          expect(result.text).not.toContain("Output incomplete");
        };

        // A string whose JSON is exactly the limit is complete; one more byte is not.
        const atLimit = yield* execute(
          "At the limit",
          `return "x".repeat(${outputLimitBytes - 2});`,
        );
        expectComplete(atLimit);
        expect(atLimit.execution.value).toBe("x".repeat(outputLimitBytes - 2));
        const overLimit = yield* execute(
          "One byte over",
          `return "x".repeat(${outputLimitBytes - 1});`,
        );
        expectIncomplete(overLimit);

        // The limit counts UTF-8 bytes, so 40,000 two-byte characters exceed it.
        const multibyte = yield* execute("Multibyte text", `return "é".repeat(40000);`);
        expectIncomplete(multibyte);
        expect(String(multibyte.execution.value)).toContain("80002 bytes");

        // A truncated object comes back as part of its JSON in a string.
        const object = yield* execute(
          "Oversized object",
          `return Array.from({ length: 2000 }, (_, id) => ({ id, text: "y".repeat(40) }));`,
        );
        expectIncomplete(object);
        expect(typeof object.execution.value).toBe("string");

        // Logs share the budget: the value fits, the log line does not.
        const logs = yield* execute(
          "Logs over the budget",
          `console.log("z".repeat(40000));
return "v".repeat(30000);`,
        );
        expectIncomplete(logs);
        expect(logs.execution.value).toBe("v".repeat(30000));
        expect(logs.execution.logs?.some((line) => line.startsWith("[logs truncated"))).toBe(true);

        // A narrowed read inside execute returns the part the truncated result omitted.
        const narrowed = yield* execute(
          "Narrowed read",
          `const all = Array.from({ length: 70000 }, (_, i) => String(i % 10)).join("");
return all.slice(65000);`,
        );
        expectComplete(narrowed);
        expect(narrowed.execution.value).toBe(
          Array.from({ length: 70000 }, (_, i) => String(i % 10))
            .join("")
            .slice(65000),
        );
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
