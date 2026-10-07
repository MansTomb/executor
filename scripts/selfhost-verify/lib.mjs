import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const maxBuffer = 64 * 1024 * 1024;
const cleanupBudgetMilliseconds = 60_000;

const inflight = new Set();

let cleanupUntil;

export const beginCleanup = () => {
  cleanupUntil ??= Date.now() + cleanupBudgetMilliseconds;
};

const synchronousTimeout = (timeout, what) => {
  if (cleanupUntil === undefined)
    throw new Error(`${what} blocks the event loop and its deadline timer; only cleanup may`);
  const left = cleanupUntil - Date.now();
  if (left <= 0)
    throw new Error(
      `Cleanup budget of ${cleanupBudgetMilliseconds / 1000}s exhausted before ${what}`,
    );
  return Math.min(timeout, left);
};

export const dockerSync = (args, { timeout = 60_000 } = {}) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    maxBuffer,
    timeout: synchronousTimeout(timeout, `docker ${args[0]}`),
    killSignal: "SIGKILL",
  }).trim();

export const dockerAsync = async (args, { timeout = 120_000 } = {}) => {
  const running = execFileAsync("docker", args, {
    encoding: "utf8",
    maxBuffer,
    timeout,
    killSignal: "SIGKILL",
  });
  inflight.add(running.child);
  try {
    return (await running).stdout.trim();
  } finally {
    inflight.delete(running.child);
  }
};

export const dockerStream = (args, { stdin = "ignore", stdout = "ignore", timeout = 300_000 }) =>
  new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: [stdin, stdout, "inherit"] });
    inflight.add(child);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      inflight.delete(child);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      inflight.delete(child);
      if (code === 0) resolve();
      else reject(new Error(`docker ${args[0]} ${signal ?? `exited ${code}`}`));
    });
  });

export const containerLogAsync = async (name) => {
  const running = execFileAsync("docker", ["logs", name], {
    encoding: "utf8",
    maxBuffer,
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  inflight.add(running.child);
  try {
    const { stdout, stderr } = await running;
    return `${stdout}${stderr}`;
  } finally {
    inflight.delete(running.child);
  }
};

export const containerLogSync = (name, ...options) => {
  const logs = spawnSync("docker", ["logs", ...options, name], {
    encoding: "utf8",
    maxBuffer,
    timeout: synchronousTimeout(60_000, "docker logs"),
    killSignal: "SIGKILL",
  });
  return `${logs.stdout}${logs.stderr}`;
};

export const uniqueName = (purpose) =>
  `agent-test-executor-${purpose}-${randomBytes(4).toString("hex")}`;

const ownedPattern = /^agent-test-executor-[a-z]+-[0-9a-f]{8}(-data)?$/;
const owned = { containers: new Set(), volumes: new Set() };

const claim = (set, name) => {
  if (!ownedPattern.test(name))
    throw new Error(`Refusing to own ${name}: only agent-test-executor-* resources are owned`);
  set.add(name);
  return name;
};

export const claimContainer = (name) => claim(owned.containers, name);

export const claimVolume = (name) => claim(owned.volumes, name);

const absent = (error) =>
  /No such (container|volume)/i.test(`${error.stderr ?? ""}${error.message}`);

const tolerateAbsent = (error) => {
  if (!absent(error)) throw error;
};

const removeContainer = (name) => {
  try {
    dockerSync(["rm", "--force", "--volumes", name]);
  } catch (error) {
    tolerateAbsent(error);
  }
  owned.containers.delete(name);
};

const removeVolume = (name) => {
  try {
    dockerSync(["volume", "rm", "--force", name]);
  } catch (error) {
    tolerateAbsent(error);
  }
  owned.volumes.delete(name);
};

export const releaseContainer = async (name) => {
  try {
    await dockerAsync(["rm", "--force", "--volumes", name], { timeout: 60_000 });
  } catch (error) {
    tolerateAbsent(error);
  }
  owned.containers.delete(name);
};

export const cleanupOwned = () => {
  const errors = [];
  for (const [names, remove] of [
    [owned.containers, removeContainer],
    [owned.volumes, removeVolume],
  ])
    for (const name of names)
      try {
        remove(name);
      } catch (error) {
        errors.push(`${name}: ${error.message.split("\n")[0]}`);
      }
  return errors;
};

export const interruptible = ({ deadlineSeconds, onInterrupt }) => {
  let interrupted = false;
  const interrupt = (reason, code) => {
    if (interrupted) return;
    interrupted = true;
    beginCleanup();
    for (const child of inflight) child.kill("SIGKILL");
    try {
      onInterrupt(reason);
    } catch {}
    process.exit(code);
  };
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ])
    process.on(signal, () => interrupt(`Interrupted by ${signal}`, code));
  setTimeout(
    () => interrupt(`Deadline of ${deadlineSeconds} seconds exceeded`, 124),
    deadlineSeconds * 1000,
  ).unref();
};

export const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

export const privateDirectory = (directory) => {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
};

export const writePrivate = (directory, name, content) =>
  fs.writeFileSync(path.join(directory, name), content, { mode: 0o600 });

export const waitForRoot = async (base, timeoutMilliseconds = 120_000) => {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/`, { signal: AbortSignal.timeout(2000) });
      await response.arrayBuffer();
      if (response.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error("Image root readiness timed out");
};

export const session = (base) => {
  let cookie;
  const request = async (url, method = "GET", body) => {
    const init = {
      method,
      headers: {
        origin: base,
        "content-type": "application/json",
        ...(cookie === undefined ? {} : { cookie }),
      },
      signal: AbortSignal.timeout(60_000),
    };
    const response = await fetch(
      base + url,
      body === undefined ? init : { ...init, body: JSON.stringify(body) },
    );
    const raw = await response.text();
    if (!response.ok)
      throw new Error(`${method} ${url}: HTTP ${response.status} ${raw.slice(0, 600)}`);
    return { data: raw ? JSON.parse(raw) : undefined, headers: response.headers };
  };
  const signIn = (headers) => {
    cookie = headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  };
  return { request, signIn };
};

export const instanceOwner = {
  name: "Fork verification",
  email: "fork-verification@example.test",
  password: "Synthetic-verification-password-123!",
  organizationName: "Fork verification",
};
