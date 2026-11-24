import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

export type Output = { readonly code: number; readonly stdout: string; readonly stderr: string };

export type RunOptions = {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly input?: string;
  readonly timeoutSeconds?: number;
  readonly log?: string;
};

export class CommandFailed extends Error {
  readonly output: Output;
  constructor(command: string, output: Output) {
    const tail = (output.stderr.trim() || output.stdout.trim()).split("\n").slice(-8).join("\n");
    super(`${command} exited ${output.code}${tail === "" ? "" : `:\n${tail}`}`);
    this.output = output;
  }
}

export const run = (command: string, args: ReadonlyArray<string>, options: RunOptions = {}) =>
  new Promise<Output>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const record = (chunk: string) => {
      if (options.log !== undefined) appendFileSync(options.log, chunk, { mode: 0o600 });
    };
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      record(chunk);
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      record(chunk);
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
    const deadline =
      options.timeoutSeconds === undefined
        ? undefined
        : setTimeout(() => {
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 30_000).unref();
          }, options.timeoutSeconds * 1000);
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      resolve({ code: code ?? (signal === null ? 1 : 128), stdout, stderr });
    });
  });

export const must = async (
  command: string,
  args: ReadonlyArray<string>,
  options: RunOptions = {},
) => {
  const output = await run(command, args, options);
  if (output.code !== 0)
    throw new CommandFailed(`${command} ${args.slice(0, 2).join(" ")}`, output);
  return output.stdout.trim();
};

export const sleep = (seconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));

export const elapsed = (started: number) => Math.round((Date.now() - started) / 100) / 10;
