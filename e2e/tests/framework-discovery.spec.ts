/** Discover live framework contracts and follow the pinned authoring topics through MCP. */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { frameworkSession } from "../support/framework.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";

const Reference = Schema.Struct({ version: Schema.String, digest: Schema.String });
const Description = Schema.Struct({
  reference: Reference,
  entry: Schema.Struct({
    symbol: Schema.String,
    signatures: Schema.Array(Schema.String),
    docs: Schema.String,
  }),
  examples: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
    }),
  ),
});
const Lookup = Schema.Struct({
  entry: Schema.optional(Schema.Struct({ symbol: Schema.String })),
  matches: Schema.Array(Schema.Struct({ symbol: Schema.String })),
});
const Document = Schema.Struct({ content: Schema.String, deployment: Schema.String });
const Rejected = Schema.Struct({
  execution: Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      response: Schema.Struct({
        code: Schema.String,
        message: Schema.String,
        recovery: Schema.Struct({ action: Schema.String }),
      }),
    }),
  }),
});

layer(HostedLive, { excludeTestServices: true })("Framework discovery", (it) => {
  it.effect(scenarios.frameworkDiscovery.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          evidence = yield* Evidence;
        const { client, execute, queries, profile } = yield* frameworkSession;
        // These public reads share no results. Start them together while keeping
        // each real MCP request and its live catalog evaluation.
        const [discovered, imported, current, found, entry, guide] = yield* Effect.all(
          [
            execute('return await tools.search({query: "framework", limit: 20});'),
            execute('return await tools.search({query: "context.get", limit: 1});').pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.Struct({
                    items: Schema.Array(Schema.Struct({ signature: Schema.String })),
                  }),
                ),
              ),
            ),
            execute(`return await ${queries}.context.get({});`).pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(Schema.Struct({ organization: Schema.String })),
              ),
            ),
            execute(
              `return await ${queries}.framework.search({query: {text: "withOptimisticUpdate"}});`,
            ).pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.Struct({
                    reference: Reference,
                    items: Schema.Array(Schema.Struct({ symbol: Schema.String })),
                  }),
                ),
              ),
            ),
            client.use("Read the short entry skill", (client, signal) =>
              client.callTool(
                { name: "skills", arguments: { app: "executor", name: "executor" } },
                undefined,
                { signal },
              ),
            ),
            client.use("Read the small authoring router", (client, signal) =>
              client.callTool(
                { name: "skills", arguments: { app: "executor", name: "app-authoring" } },
                undefined,
                { signal },
              ),
            ),
          ],
          { concurrency: 6 },
        );
        yield* evidence.json("framework-tool-discovery.json", discovered);
        const tools = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            items: Schema.Array(Schema.Struct({ path: Schema.String, signature: Schema.String })),
          }),
        )(discovered);
        const search = tools.items.find(
          (item) => item.path.endsWith(".framework.search") && item.path.includes(profile.id),
        );
        expect(search?.signature).toContain("remaining: number");
        expect(search?.signature).toContain("digest: string");
        expect(
          tools.items.some(
            (item) => item.path.endsWith(".framework.describe") && item.path.includes(profile.id),
          ),
        ).toBe(true);
        expect(imported.items[0]?.signature).toContain("organization: string");
        expect(imported.items[0]?.signature).toContain("slug: string");
        expect(current.organization).toBe(actors.organization.id);
        expect(found.items.map((item) => item.symbol)).toContain(
          "AppMutation.withOptimisticUpdate",
        );
        // Misshaped input names the failing path, the unexpected key and the keys it accepts there,
        // the way agents misread these signatures. A tool without inputs still accepts {}.
        const rejected = (label: string, code: string) =>
          client
            .use(label, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
            )
            .pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(Rejected)(result.structuredContent),
              ),
              Effect.map((rejected) => rejected.execution.error.response),
            );
        const misshaped = yield* Effect.all(
          [
            rejected(
              "Search with the query text in place of the query object",
              `return await ${queries}.framework.search({query: "apps/client.createAppClient"});`,
            ),
            rejected(
              "Search with the query text under an undeclared key",
              `return await ${queries}.framework.search({query: {query: "createAppClient"}});`,
            ),
            rejected(
              "Read the context with an organization it does not take",
              `return await ${queries}.context.get({path: {organization: ${JSON.stringify(actors.organization.id)}}});`,
            ),
          ],
          { concurrency: 3 },
        );
        yield* evidence.json("framework-input-problems.json", misshaped);
        expect(misshaped.map(({ code, message }) => ({ code, message }))).toEqual([
          {
            code: "InputInvalid",
            message:
              "Input failed validation: input.query: Expected object {text?, offset?, version?, digest?}",
          },
          {
            code: "InputInvalid",
            message:
              'Input failed validation: input.query: Unexpected key "query". Expected object {text?, offset?, version?, digest?}',
          },
          {
            code: "InputInvalid",
            message:
              'Input failed validation: input: Unexpected key "path". Expected object {} with no keys',
          },
        ]);
        expect(misshaped[0]?.recovery.action).toBe(
          "Change the input to the shape each problem expects, then call the tool again.",
        );
        const describe = (symbol: string) =>
          execute(
            `return await ${queries}.framework.describe(${JSON.stringify({ query: { symbol, ...found.reference } })});`,
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Description)));
        const [hook, update] = yield* Effect.all(
          [describe("apps/react.useAppQuery"), describe("AppMutation.withOptimisticUpdate")],
          { concurrency: 2 },
        );
        // Agents often pass an unqualified name; a unique suffix resolves, otherwise the
        // result names the closest symbols instead of failing without guidance.
        const lookup = (symbol: string) =>
          execute(
            `return await ${queries}.framework.describe(${JSON.stringify({ query: { symbol, ...found.reference } })});`,
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Lookup)));
        const [unqualified, unknown, partial] = yield* Effect.all(
          [lookup("defineApp"), lookup("defineApplication"), lookup("withOptimistic")],
          { concurrency: 3 },
        );
        yield* evidence.json("framework-describe-lookups.json", {
          unqualified,
          unknown,
          partial,
        });
        expect(unqualified.entry?.symbol).toBe("apps.defineApp");
        expect(unqualified.matches).toEqual([]);
        expect(unknown.entry).toBeUndefined();
        expect(unknown.matches.map((match) => match.symbol)).toContain("apps.defineApp");
        expect(partial.entry).toBeUndefined();
        expect(partial.matches[0]?.symbol).toBe("AppMutation.withOptimisticUpdate");
        expect(hook.entry.signatures.join(" ")).toContain("data: A | undefined");
        expect(hook.entry.signatures.join(" ")).toContain("pending: boolean");
        expect(update.entry.signatures.join(" ")).toContain("OptimisticUpdate<Input>");
        // Agents start at the short entry skill, which names the deeper skills to read.
        const intro = yield* Schema.decodeUnknownEffect(Document)(entry.structuredContent);
        expect(intro.content).toContain("`code-mode`");
        expect(intro.content).toContain("`app-authoring`");
        expect(intro.content.split("\n").length).toBeLessThan(50);
        const router = yield* Schema.decodeUnknownEffect(Document)(guide.structuredContent);
        expect(router.content).toContain("[ui.md](ui.md)");
        expect(router.content.split("\n").length).toBeLessThan(90);
        const topic = yield* client.use("Follow the pinned UI topic", (client, signal) =>
          client.callTool(
            {
              name: "skills",
              arguments: {
                app: "executor",
                name: "app-authoring",
                file: hook.entry.docs,
                deployment: router.deployment,
              },
            },
            undefined,
            { signal },
          ),
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Document)(topic.structuredContent)).content,
        ).toContain("withOptimisticUpdate");
        yield* evidence.json("framework-reference.json", {
          reference: found.reference,
          hook: hook.entry,
          update: update.entry,
          tools,
        });
        expect(update.examples.some((example) => example.id === "live-inbox")).toBe(true);
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
