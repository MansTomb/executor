import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { createProfile, selectProfileAccounts } from "../support/profiles.ts";
import { clickupUpstream } from "../support/clickup-upstream.ts";
import { scenarios } from "../test-plan.ts";
import { managementApp } from "../support/management-app.ts";

layer(HostedLive, { excludeTestServices: true })("ClickUp integration", (it) => {
  it.effect(scenarios.clickupFresh.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem,
          api = yield* Api,
          actors = yield* Actors,
          http = yield* HttpClient.HttpClient;
        const issuer = yield* oauthSetupIssuer;
        const upstream = yield* clickupUpstream(issuer.origin);
        const files = yield* Effect.forEach(
          yield* fs.readDirectory("e2e/fixtures/clickup"),
          (name) =>
            Effect.gen(function* () {
              const content = yield* fs.readFileString(`e2e/fixtures/clickup/${name}`);
              return {
                path: name.replace(/\.txt$/, ""),
                content: content
                  .replaceAll("https://mcp.clickup.com", upstream.origin)
                  .replaceAll("https://api.clickup.com", upstream.origin),
              };
            }),
        );
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `ClickUp fresh ${randomUUID().slice(0, 8)}`,
          files,
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/apps/${app.id}`,
          ids: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", path);
            for (const id of ids)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${id}`);
          }).pipe(Effect.orDie),
        );
        const profile = yield* createProfile(actors.owner, path);
        const connection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${path}/connections`, {
            requirement: "service",
            profile: profile.id,
          }),
        );
        const started = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/oauth/start`,
          { method: "oauth", label: "Synthetic ClickUp MCP" },
        );
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const signIn = yield* body(Schema.Struct({ authorizationUrl: Schema.String }), started);
        const callbackUrl = yield* Effect.scoped(
          Effect.gen(function* () {
            const consent = yield* HttpClient.withScope(http).get(signIn.authorizationUrl);
            expect(consent.status).toBe(302);
            if (consent.headers.location === undefined)
              return yield* Effect.die("Missing OAuth callback");
            return consent.headers.location;
          }),
        ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
        const completed = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/oauth/complete`,
          { callbackUrl },
        );
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);
        const mcp = yield* body(Resource, completed);
        ids.push(mcp.id);
        const restConnection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${path}/connections`, {
            requirement: "rest",
            profile: profile.id,
          }),
        );
        const rest = yield* body(
          Resource,
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${restConnection.id}/submit`,
            {
              method: "apiKey",
              label: "Explicit synthetic REST",
              fields: { token: "synthetic-rest", mcpAccountId: mcp.id, workspaceId: "5678" },
            },
          ),
        );
        ids.push(rest.id);
        yield* selectProfileAccounts(actors.owner, path, profile.id, {
          service: [mcp.id],
          rest: [rest.id],
        });
        const from = Date.now();
        const call = (include: readonly string[] = ["attachments"]) =>
          api.request(actors.owner, "POST", `${path}/tools/call`, {
            profile: profile.id,
            tool: "queries.clickup_get_task",
            input: {
              accountId: mcp.id,
              input: { task_id: "abc123", workspace_id: "5678", include },
            },
          });
        const cold = yield* call();
        expect(cold.status, JSON.stringify(cold.body)).toBe(200);
        expect(cold.body).toMatchObject({
          structuredContent: {
            name: "Initial task",
            attachments: [{ title: "Original attachment" }],
          },
        });
        expect(upstream.calls).toEqual([
          { transport: "rest", operation: "identity" },
          { transport: "mcp", operation: "identity" },
          { transport: "rest", operation: "task", task: "abc123" },
        ]);
        upstream.edit();
        const warm = yield* call();
        expect(warm.status, JSON.stringify(warm.body)).toBe(200);
        expect(warm.body).toMatchObject({
          structuredContent: {
            name: "Remote edit",
            attachments: [{ title: "Changed attachment" }],
          },
        });
        expect(upstream.calls).toHaveLength(4);
        const comments = yield* call(["comments"]);
        expect(comments.status, JSON.stringify(comments.body)).toBe(200);
        expect(comments.body).toMatchObject({
          structuredContent: { source: "mcp", comments: ["Current comment"] },
        });
        upstream.fail(429);
        expect((yield* call()).status).toBe(502);
        const response = yield* api.request(
          actors.owner,
          "GET",
          `${path}/analytics?from=${from}&to=${Date.now()}&event=upstream_request&groupBy=transport&groupBy=purpose&groupBy=outcome`,
        );
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const summary = yield* body(
          Schema.Struct({
            matchedEvents: Schema.Number,
            groups: Schema.Array(
              Schema.Struct({
                dimensions: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
                count: Schema.Number,
                durationMs: Schema.Number,
              }),
            ),
          }),
          response,
        );
        expect(summary.matchedEvents).toBe(12);
        expect(
          summary.groups
            .map((group) => ({ dimensions: group.dimensions, count: group.count }))
            .sort((a, b) =>
              JSON.stringify(a.dimensions).localeCompare(JSON.stringify(b.dimensions)),
            ),
        ).toEqual(
          [
            { dimensions: { transport: "rest", purpose: "identity", outcome: null }, count: 1 },
            {
              dimensions: { transport: "rest", purpose: "identity", outcome: "success" },
              count: 1,
            },
            { dimensions: { transport: "mcp", purpose: "identity", outcome: null }, count: 1 },
            { dimensions: { transport: "mcp", purpose: "identity", outcome: "success" }, count: 1 },
            { dimensions: { transport: "rest", purpose: "task", outcome: null }, count: 3 },
            { dimensions: { transport: "rest", purpose: "task", outcome: "success" }, count: 2 },
            { dimensions: { transport: "rest", purpose: "task", outcome: "error" }, count: 1 },
            { dimensions: { transport: "mcp", purpose: "tool", outcome: null }, count: 1 },
            { dimensions: { transport: "mcp", purpose: "tool", outcome: "success" }, count: 1 },
          ].sort((a, b) =>
            JSON.stringify(a.dimensions).localeCompare(JSON.stringify(b.dimensions)),
          ),
        );
        expect(upstream.calls).toHaveLength(6);
        expect(
          (yield* api.request(
            actors.member,
            "GET",
            `${path}/analytics?from=${from}&to=${Date.now()}`,
          )).status,
        ).toBe(403);
        expect(
          (yield* api.request(
            actors.owner,
            "GET",
            `/api/organizations/not-this-organization/apps/${app.id}/analytics?from=${from}&to=${Date.now()}`,
          )).status,
        ).toBe(403);
        const management = yield* managementApp(actors.owner);
        const described = yield* api.request(
          actors.owner,
          "GET",
          `${prefix}/apps/${management.app.id}/tools/queries.analytics_summary?profile=${management.profile.id}`,
        );
        expect(described.status, JSON.stringify(described.body)).toBe(200);
        expect(described.body).toMatchObject({ name: "queries.analytics_summary" });
        const throughTool = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${management.app.id}/tools/call`,
          {
            profile: management.profile.id,
            tool: "queries.analytics_summary",
            input: {
              path: { app: app.id },
              query: { from: String(from), to: String(Date.now()), event: "upstream_request" },
            },
          },
        );
        expect(throughTool.status, JSON.stringify(throughTool.body)).toBe(200);
        expect(throughTool.body).toMatchObject({
          matchedEvents: 12,
          bestEffort: true,
          completeness: "not-guaranteed",
        });
        upstream.fail(302);
        expect((yield* call()).status).toBe(502);
        expect(upstream.calls).toHaveLength(7);
      }),
    ),
  );
});
