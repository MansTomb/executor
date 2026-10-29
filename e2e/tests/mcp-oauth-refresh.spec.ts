/** MCP clients often run several instances that share one stored OAuth grant. */
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Redacted, Schedule } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";
import { serverControl } from "../support/server-control.ts";
import { Target } from "../support/platform.ts";

layer(HostedLive, { excludeTestServices: true })("MCP OAuth refresh", (it) => {
  it.effect(scenarios.mcpRefreshRejectionLog.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient;
        const fs = yield* FileSystem.FileSystem;
        const target = yield* Target;
        for (const clientId of ["refresh-log-form-client", "refresh-log-basic-client"]) {
          const token = `not-a-refresh-token-${clientId}`;
          const basic = clientId === "refresh-log-basic-client";
          const response = yield* http.execute(
            HttpClientRequest.post(`${target.metadata.origin}/api/auth/oauth2/token`, {
              headers: basic ? { authorization: `Basic ${btoa(`${clientId}:unused-secret`)}` } : {},
            }).pipe(
              HttpClientRequest.bodyUrlParams({
                grant_type: "refresh_token",
                refresh_token: token,
                ...(basic ? {} : { client_id: clientId }),
              }),
            ),
          );
          expect(response.status).toBe(400);
          expect(yield* response.json).toMatchObject({ error: "invalid_grant" });
          const log = yield* fs.readFileString(`${target.directory}/server.log`).pipe(
            Effect.map((text) =>
              text
                .split("\n")
                .find(
                  (line) => line.includes("auth.oauth.refresh.rejected") && line.includes(clientId),
                ),
            ),
            Effect.filterOrFail(
              (line) => line !== undefined,
              () => new Error("Missing refresh rejection log"),
            ),
            Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 20 }),
          );
          expect(log).toContain("unknown_token");
          expect(log).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
          expect(log.includes(token)).toBe(false);
          expect(log.includes("unused-secret")).toBe(false);
        }
      }),
    ),
  );
  it.effect(scenarios.mcpStaleRefresh.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence,
          oauth = yield* McpOAuth,
          mcp = yield* McpClient;
        yield* browser.login(actors.owner);
        // Two instances of one client load the same stored grant. Each keeps its own copy.
        const stored = yield* evidence.step("Authorize one MCP grant", oauth.authorize);
        const first = yield* evidence.step(
          "The first instance refreshes the stored grant",
          oauth.refresh(stored),
        );
        const active = yield* mcp.connect(
          Redacted.make(Redacted.value(first.tokens).access_token),
          "active-instance",
        );
        const listed = yield* active.use("The first instance lists tools", (client) =>
          client.listTools(),
        );
        expect(listed.tools.length).toBeGreaterThan(0);
        // The second instance still holds the refresh token the first instance rotated.
        const sibling = yield* evidence.step(
          "A sibling instance refreshes with the token it loaded earlier",
          oauth.refresh(stored),
        );
        // It joins the first instance's rotation instead of forking or ending the grant.
        const same =
          Redacted.value(sibling.tokens).access_token ===
            Redacted.value(first.tokens).access_token &&
          Redacted.value(sibling.tokens).refresh_token ===
            Redacted.value(first.tokens).refresh_token;
        expect(same).toBe(true);
        const stillListed = yield* active.use(
          "The first instance stays signed in after its sibling's refresh",
          (client) => client.listTools(),
        );
        expect(stillListed.tools.length).toBe(listed.tools.length);
        const next = yield* evidence.step(
          "The shared grant keeps refreshing",
          oauth.refresh(first),
        );
        const renewed = yield* mcp.connect(
          Redacted.make(Redacted.value(next.tokens).access_token),
          "renewed-instance",
        );
        yield* renewed.use("The renewed token lists tools", (client) => client.listTools());
        yield* evidence.step(
          "Revoking the grant still ends every copy",
          Effect.gen(function* () {
            yield* oauth.revoke(next);
            expect(yield* oauth.refreshStatus(next)).toBe(400);
            expect(yield* oauth.refreshStatus(stored)).toBe(400);
            const denied = yield* api.request(yield* api.session(), "GET", "/mcp", undefined, {
              authorization: `Bearer ${Redacted.value(next.tokens).access_token}`,
            });
            expect(denied.status).toBe(401);
          }),
        );
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
  it.effect(scenarios.mcpLateRefreshReuse.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence,
          oauth = yield* McpOAuth;
        yield* browser.login(actors.owner);
        const stored = yield* evidence.step("Authorize one MCP grant", oauth.authorize);
        const first = yield* evidence.step(
          "The first instance refreshes the stored grant",
          oauth.refresh(stored),
        );
        // Just inside the hour the rotation's access token lives, a sibling still joins it.
        yield* serverControl("stop");
        yield* serverControl("clock/advance", 200, { milliseconds: 59 * 60_000 });
        yield* serverControl("start");
        const sibling = yield* evidence.step(
          "A sibling refreshes with the rotated token 59 minutes later",
          oauth.refresh(stored),
        );
        // Compare inside the test so neither token reaches assertion diagnostics.
        const joined =
          Redacted.value(sibling.tokens).refresh_token ===
          Redacted.value(first.tokens).refresh_token;
        expect(joined).toBe(true);
        // After that hour a stale copy, such as one an idle sibling kept, is refused alone for a
        // day after its rotation, and the grant's current token keeps working.
        yield* serverControl("stop");
        yield* serverControl("clock/advance", 200, { milliseconds: 2 * 60_000 });
        yield* serverControl("start");
        const current = yield* evidence.step(
          "Replaying the rotated token 61 minutes later is refused, and the current token still refreshes",
          Effect.gen(function* () {
            expect(yield* oauth.refreshStatus(stored)).toBe(400);
            return yield* oauth.refresh(first);
          }),
        );
        // More than a day after its rotation the server cannot tell the copy from a stolen one,
        // so presenting it ends the grant for every holder.
        yield* serverControl("stop");
        yield* serverControl("clock/advance", 200, { milliseconds: 24 * 3600_000 });
        yield* serverControl("start");
        yield* evidence.step(
          "Replaying the rotated token more than a day later ends every copy",
          Effect.gen(function* () {
            expect(yield* oauth.refreshStatus(stored)).toBe(400);
            expect(yield* oauth.refreshStatus(current)).toBe(400);
          }),
        );
      }).pipe(Effect.provide(McpOAuth.layer)),
    ),
  );
});
