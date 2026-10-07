import { appsManifest } from "../support/apps-release.ts";
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { App, Resource } from "../support/contracts.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { requestGate } from "../support/request-gate.ts";
import { clientCredentialsIssuer, machineClient } from "../support/client-credentials-issuer.ts";
import { createProfile } from "../support/profiles.ts";

const Failure = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({ kind: Schema.String, message: Schema.String }),
  }),
});

const setup = (source: string, timeout = 55_000) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      mcp = yield* McpClient;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const key = yield* body(
      Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
      yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
        name: "Error boundary",
      }),
    );
    const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name: "Error boundary",
      files: [appsManifest, { path: "index.ts", content: source }],
    });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const app = yield* body(App, deployed);
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`);
        yield* api.request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id });
      }).pipe(Effect.orDie),
    );
    const client = yield* mcp.connect(key.key, "error-boundary", {
      organization: actors.organization.id,
    });
    const execute = (code: string) =>
      client.use("Exercise the error boundary", (client, signal) =>
        client.callTool({ name: "execute", arguments: { code } }, undefined, {
          signal,
          timeout,
        }),
      );
    return { app, prefix, execute };
  });

layer(HostedLive, { excludeTestServices: true })("Error boundary", (it) => {
  it.effect(scenarios.thrownAppError.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const evidence = yield* Evidence,
          api = yield* Api,
          actors = yield* Actors;
        const { app, prefix, execute } =
          yield* setup(`import {defineApp,defineProvider,secrets,query,object,string,router} from "apps";
const service=defineProvider({name:"Reports",auth:{key:secrets({label:"Password",fields:object({password:string()})})}});
export default defineApp({accounts:{service}},async()=>({tools: router({ queries: router({read:query({input:object({privateValue:string()})},async({accounts},input)=>{
throw new Error("Could not read the report",{cause:new Error("Report was deleted; token=synthetic-secret; private="+input.privateValue+"; "+JSON.stringify({password:accounts.service.fields.password,detail:accounts.service.fields.password,secret:"unselected secret"}))});
})}) })}));`);
        const path = `${prefix}/apps/${app.id}`;
        const profile = yield* createProfile(actors.owner, path);
        const connection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${path}/connections`, {
            requirement: "service",
            profile: profile.id,
          }),
        );
        const account = yield* body(
          Resource,
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/submit`,
            { method: "key", label: "Reports", fields: { password: 'synthetic"secret\\value' } },
          ),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/accounts/${account.id}`)
            .pipe(Effect.orDie),
        );
        const operation = `${app.slug}.profiles.${profile.id}.queries.read`;
        const result = yield* execute(
          `return await tools[${JSON.stringify(app.slug)}].profiles[${JSON.stringify(profile.id)}].queries.read({privateValue:"synthetic-private-input"});`,
        );
        const failure = yield* body(Failure, { status: 200, body: result.structuredContent });
        expect(failure.execution.error.message).toBe(
          `${operation}: ToolCallFailed (HTTP 502): The app threw Error: Could not read the report (caused by Error: Report was deleted; token=[redacted]; private=[redacted]; {"password":"[redacted]","detail":"[redacted]","secret":"[redacted]"}) Recovery: Fix the input or the app code that threw this error, then retry.`,
        );
        yield* evidence.json("thrown-app-error.json", result.structuredContent);
        const caught = yield* execute(
          `try { await tools[${JSON.stringify(app.slug)}].profiles[${JSON.stringify(profile.id)}].queries.read({privateValue:"synthetic-private-input"}); } catch (error) { return JSON.parse(error.message); }`,
        );
        expect(caught.structuredContent).toMatchObject({
          execution: {
            ok: true,
            value: {
              operation,
              message:
                'The app threw Error: Could not read the report (caused by Error: Report was deleted; token=[redacted]; private=[redacted]; {"password":"[redacted]","detail":"[redacted]","secret":"[redacted]"})',
              recovery: {
                action: "Fix the input or the app code that threw this error, then retry.",
              },
            },
          },
        });
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(
    scenarios.mutationTimeoutBoundary.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const evidence = yield* Evidence;
          const gate = yield* requestGate;
          const { app, execute } = yield* setup(
            `import {defineApp,mutation,object,router} from "apps";
export default defineApp({accounts:{}},async()=>({tools: router({ mutations: router({write:mutation({input:object({})},async({fetch})=>{
await fetch(${JSON.stringify(gate.origin + "/done")});
await fetch(${JSON.stringify(gate.origin + "/wait")});
return {written:true};
})}) })}));`,
            315_000,
          );
          const result = yield* execute(
            `return await tools[${JSON.stringify(app.slug)}].mutations.write({});`,
          );
          yield* gate.arrived;
          expect(yield* gate.completed).toBe(1);
          const failure = yield* body(Failure, { status: 200, body: result.structuredContent });
          expect(failure.execution.error.kind).toBe("TimeoutExceeded");
          expect(failure.execution.error.message).toBe(
            `Execution timed out after 300000ms. ${app.slug}.mutations.write: outcome unknown. Recovery: Check current state with a safe read before repeating any mutation. A timeout does not establish that a mutation failed or that retrying is safe.`,
          );
          yield* evidence.json("mutation-timeout.json", result.structuredContent);
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 350_000 },
  );

  it.effect(scenarios.expiredAccountBoundary.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        const issuer = yield* clientCredentialsIssuer;
        yield* issuer.configure({ expiresIn: 1 });
        const { app, prefix, execute } =
          yield* setup(`import {defineApp,defineProvider,oauth2,query,object,router} from "apps";
const service=defineProvider({name:"Reports",auth:{machine:oauth2({grant:"client_credentials",tokenUrl:${JSON.stringify(issuer.origin + "/token")},scopes:[],tokenEndpointAuthMethod:"client_secret_basic"})}});
export default defineApp({accounts:{service}},async()=>({tools: router({ queries: router({read:query({input:object({})},async()=>({ok:true}))}) })}));`);
        const path = `${prefix}/apps/${app.id}`;
        const profile = yield* createProfile(actors.owner, path);
        const connection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${path}/connections`, {
            requirement: "service",
            profile: profile.id,
          }),
        );
        const connected = yield* body(
          Schema.Struct({ account: Schema.Struct({ id: Schema.String }) }),
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/oauth/start`,
            { method: "machine", label: "Expired Reports", client: machineClient },
          ),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/accounts/${connected.account.id}`)
            .pipe(Effect.orDie),
        );
        yield* issuer.configure({ rejected: true });
        yield* issuer.awaitExpiry;
        const operation = `${app.slug}.profiles.${profile.id}.queries.read`;
        const result = yield* execute(
          `return await tools[${JSON.stringify(app.slug)}].profiles[${JSON.stringify(profile.id)}].queries.read({});`,
        );
        const failure = yield* body(Failure, { status: 200, body: result.structuredContent });
        expect(failure.execution.error.message).toContain(operation);
        expect(failure.execution.error.message).toContain("Expired Reports");
        expect(failure.execution.error.message).toContain(connected.account.id);
        expect(failure.execution.error.message).toContain("accounts.reconnect");
        expect(failure.execution.error.message).toContain("browser link");
        yield* evidence.json("expired-account.json", result.structuredContent);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
