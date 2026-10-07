import { Effect, FileSystem, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Target } from "./platform.ts";

export const analyticsDatabase = (action: "inspect") =>
  Effect.gen(function* () {
    const target = yield* Target;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const script = `const {createRequire}=require("node:module");
const sdk=createRequire(process.cwd()+"/packages/sdk/package.json");
const driver=createRequire(sdk.resolve("@effect/sql-pglite"));
const {PGlite}=driver("@electric-sql/pglite");
(async()=>{const pg=new PGlite(process.argv[1]);await pg.waitReady;
const version=(await pg.query("SELECT value FROM private_executor_settings WHERE key='version'")).rows[0].value;
const events=Number((await pg.query("SELECT COUNT(*) AS count FROM executor_analytics_events")).rows[0].count);
await pg.close();process.stdout.write(JSON.stringify({version,events}));})().catch(error=>{console.error(error);process.exit(1);});`;
    const child = yield* processes.spawn(
      ChildProcess.make(
        "node",
        ["-e", script, `${target.directory}/data/executor.pglite`, action],
        { stdout: "pipe", stderr: "inherit" },
      ),
    );
    const [code, output] = yield* Effect.all([
      child.exitCode,
      child.stdout.pipe(Stream.decodeText, Stream.mkString),
    ]);
    if (Number(code) !== 0) return yield* Effect.die("Native analytics database fixture failed");
    return yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Struct({ version: Schema.String, events: Schema.Int })),
    )(output);
  });

export const analyticsVolume = (action: "backup" | "restore") =>
  Effect.gen(function* () {
    const target = yield* Target;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const data = `${target.directory}/data`;
    const archive = `${target.directory}/pre-upgrade-volume.tar`;
    if (action === "restore") {
      yield* fs.remove(data, { recursive: true });
      yield* fs.makeDirectory(data);
    }
    const child = yield* processes.spawn(
      ChildProcess.make("tar", [
        action === "backup" ? "-cf" : "-xf",
        archive,
        "-C",
        data,
        ...(action === "backup" ? ["."] : []),
      ]),
    );
    if (Number(yield* child.exitCode) !== 0)
      return yield* Effect.die(`Disposable analytics volume ${action} failed`);
  });
