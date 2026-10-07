import { randomUUID } from "node:crypto";
import { expect } from "@effect/vitest";
import { Config, Effect, Fiber, Schema, Schedule } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { driver } from "./platform.ts";

export const dockerShutdown = Effect.scoped(
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const image = yield* Config.String("EXECUTOR_E2E_DOCKER_IMAGE");
    const id = `executor-shutdown-${randomUUID()}`;
    const fixture = `${id}-dependency`;
    const run = (args: readonly string[]) =>
      processes.string(ChildProcess.make("docker", args, { extendEnv: true, stderr: "inherit" }));
    yield* Effect.acquireRelease(
      run([
        "run",
        "--detach",
        "--name",
        id,
        "--publish",
        "127.0.0.1::8080",
        "--env",
        "PORT=8080",
        "--env",
        "BETTER_AUTH_URL=http://localhost:8080",
        "--env",
        "EXECUTOR_APPS_ALLOW_PRIVATE_FETCH=true",
        image,
      ]),
      () => run(["rm", "--force", "--volumes", id]).pipe(Effect.orDie),
    );
    const binding = (yield* run(["port", id, "8080/tcp"])).trim();
    const port = yield* Schema.decodeUnknownEffect(Schema.NumberFromString)(
      binding.split(":").at(-1),
    );
    const origin = "http://localhost:8080";
    let address = `http://127.0.0.1:${port}`;
    yield* Effect.acquireRelease(
      run([
        "run",
        "--detach",
        "--name",
        fixture,
        "--network",
        `container:${id}`,
        "oven/bun:1",
        "bun",
        "-e",
        `let entered = 0; let release; let started = 0;
Bun.serve({ hostname: "0.0.0.0", port: 8093, idleTimeout: 60, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/wait") { entered++; started = Date.now(); await new Promise(resolve => release = resolve); return Response.json({ ready: true }); }
  if (path === "/release") { await new Promise(resolve => setTimeout(resolve, Math.max(0, 16_000 - (Date.now() - started)))); release?.(); }
  if (path === "/abort") release?.();
  return Response.json({ entered });
}});`,
      ]),
      () => run(["rm", "--force", fixture]).pipe(Effect.orDie),
    );
    const dependency = (path: string) =>
      run([
        "exec",
        fixture,
        "bun",
        "-e",
        `console.log(await (await fetch("http://127.0.0.1:8093${path}")).text())`,
      ]);
    yield* Effect.addFinalizer(() => dependency("/abort").pipe(Effect.ignore));
    const request = (path: string, data?: unknown, cookie?: string) =>
      driver("shutdown HTTP request", (signal) =>
        fetch(`${address}${path}`, {
          signal,
          method: data === undefined ? "GET" : "POST",
          headers: {
            origin,
            "content-type": "application/json",
            ...(cookie === undefined ? {} : { cookie }),
          },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        }),
      );
    yield* request("/health").pipe(
      Effect.flatMap((response) =>
        response.status === 200 ? Effect.void : Effect.fail("not ready"),
      ),
      Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 200 }),
    );
    const setup = yield* request("/api/auth/self-host/setup", {
      name: "Shutdown owner",
      email: "shutdown@example.test",
      password: "Synthetic-shutdown-password-123!",
      organizationName: "Shutdown lab",
    });
    expect(setup.status).toBe(200);
    const cookie = setup.headers
      .getSetCookie()
      .map((part) => part.split(";")[0])
      .join("; ");
    const organizations = yield* request("/api/auth/organization/list", undefined, cookie);
    const [organization] = yield* Schema.decodeUnknownEffect(
      Schema.NonEmptyArray(Schema.Struct({ id: Schema.String })),
    )(yield* driver("shutdown organizations", () => organizations.json()));
    const prefix = `/api/organizations/${organization.id}`;
    const deployed = yield* request(
      `${prefix}/apps/deploy`,
      {
        name: "Shutdown dependency",
        files: [
          {
            path: "index.ts",
            content: `import { defineApp, mutation, query, object, string } from "apps";
export default defineApp({ accounts: {} }, async (ctx) => ({ queries: { saved: query({ input: object({}) }, async () => ctx.cache.read("saved", string())) }, mutations: {
  hold: mutation({ input: object({}) }, async () => {
    await fetch("http://127.0.0.1:8093/wait");
    await ctx.cache.write([{ key: "saved", value: "persisted-before-stop" }], "1 hour");
    return "completed-once";
  })
} }));`,
          },
        ],
      },
      cookie,
    );
    expect(deployed.status).toBe(200);
    const app = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
      yield* driver("shutdown app", () => deployed.json()),
    );
    const created = yield* request(
      `${prefix}/apps/${app.id}/profiles`,
      {
        accounts: {},
        idempotencyKey: randomUUID(),
      },
      cookie,
    );
    expect(created.status).toBe(200);
    const profile = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
      yield* driver("shutdown profile", () => created.json()),
    );
    const call = yield* request(
      `${prefix}/apps/${app.id}/tools/call`,
      {
        profile: profile.id,
        tool: "mutations.hold",
        input: {},
      },
      cookie,
    ).pipe(
      Effect.flatMap((response) =>
        driver("shutdown mutation result", () => response.json()).pipe(
          Effect.map((value) => ({ status: response.status, value })),
        ),
      ),
      Effect.forkScoped,
    );
    const entered = dependency("/entered").pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Struct({ entered: Schema.Number })),
        ),
      ),
    );
    yield* entered.pipe(
      Effect.flatMap((value) =>
        value.entered === 1 ? Effect.void : Effect.fail("mutation pending"),
      ),
      Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 100 }),
    );
    yield* run(["kill", "--signal", "SIGTERM", id]);
    yield* driver("public shutdown listener", () =>
      fetch(`${address}/health`, { signal: AbortSignal.timeout(1000) }).then(
        () => false,
        (error) => error instanceof TypeError,
      ),
    ).pipe(
      Effect.flatMap((closed) =>
        closed ? Effect.void : Effect.fail("shutdown still accepts requests"),
      ),
      Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 5 }),
    );
    yield* dependency("/release");
    expect(yield* Fiber.join(call)).toEqual({ status: 200, value: "completed-once" });
    expect(yield* entered).toEqual({ entered: 1 });
    expect((yield* run(["wait", id])).trim()).toBe("0");
    yield* run(["start", id]);
    const restartedBinding = (yield* run(["port", id, "8080/tcp"])).trim();
    const restartedPort = yield* Schema.decodeUnknownEffect(Schema.NumberFromString)(
      restartedBinding.split(":").at(-1),
    );
    address = `http://127.0.0.1:${restartedPort}`;
    yield* request("/health").pipe(
      Effect.flatMap((response) =>
        response.status === 200 ? Effect.void : Effect.fail("not ready"),
      ),
      Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 200 }),
    );
    const retained = yield* request(
      `${prefix}/apps/${app.id}/tools/call`,
      {
        profile: profile.id,
        tool: "queries.saved",
        input: {},
      },
      cookie,
    );
    expect(retained.status).toBe(200);
    expect(yield* driver("retained shutdown mutation", () => retained.json())).toBe(
      "persisted-before-stop",
    );
  }),
);
