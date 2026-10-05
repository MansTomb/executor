import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Target } from "./platform.ts";

export const analyticsDatabase = (action: "baseline" | "inspect") =>
  Effect.gen(function* () {
    const target = yield* Target;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const script = `const {createRequire}=require("node:module");
const sdk=createRequire(process.cwd()+"/packages/sdk/package.json");
const driver=createRequire(sdk.resolve("@effect/sql-pglite"));
const {PGlite}=driver("@electric-sql/pglite");
(async()=>{const pg=new PGlite(process.argv[1]);await pg.waitReady;
if(process.argv[2]==="baseline")await pg.exec("DROP TABLE executor_analytics_events; UPDATE private_executor_settings SET value='4.0.1' WHERE key='version'");
const version=(await pg.query("SELECT value FROM private_executor_settings WHERE key='version'")).rows[0].value;
const events=process.argv[2]==="baseline"?0:Number((await pg.query("SELECT COUNT(*) AS count FROM executor_analytics_events")).rows[0].count);
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
