import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync, chmodSync } from "node:fs";
import path from "node:path";
import { envFile, type ReleaseConfig } from "./config.ts";
import { must, run, sleep } from "./shell.ts";

export type Access = "read-only" | "mutating";

type Json = Record<string, unknown>;

export const dokployClient = (access: Access) => {
  const env = envFile("dokploy", ["DOKPLOY_URL", "DOKPLOY_API_KEY"]);
  const origin = env("DOKPLOY_URL")
    .replace(/\/+$/, "")
    .replace(/\/api$/, "");
  const call = async (endpoint: string, params: Json, mutation: boolean): Promise<unknown> => {
    if (mutation && access !== "mutating")
      throw new Error(`Refusing the mutating Dokploy call ${endpoint} in a read-only run`);
    const url = new URL(`${origin}/api/${endpoint}`);
    if (!mutation)
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const response = await fetch(url, {
      method: mutation ? "POST" : "GET",
      headers: { "x-api-key": env("DOKPLOY_API_KEY"), "content-type": "application/json" },
      ...(mutation ? { body: JSON.stringify(params) } : {}),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Dokploy ${endpoint} answered ${response.status}`);
    const text = await response.text();
    return text === "" ? null : JSON.parse(text);
  };
  return {
    get: (endpoint: string, params: Json = {}) => call(endpoint, params, false),
    post: (endpoint: string, params: Json) => call(endpoint, params, true),
  };
};

export type Dokploy = ReturnType<typeof dokployClient>;

export type Service = {
  readonly composeId: string;
  readonly appName: string;
  readonly serviceName: string;
  readonly volumeBackupId: string;
  readonly repository: string;
  readonly image: string;
  readonly origin: string;
};

type Compose = { readonly composeFile: string; readonly env: string; readonly appName: string };

const immutableImage = /([a-z0-9][a-z0-9.-]*(?::\d+)?\/[a-z0-9._/-]+)@sha256:[0-9a-f]{64}/g;

export const readCompose = async (dokploy: Dokploy, composeId: string) => {
  const row = (await dokploy.get("compose.one", { composeId })) as Compose;
  return { composeFile: row.composeFile, env: row.env, appName: row.appName };
};

export const discoverService = async (dokploy: Dokploy, config: ReleaseConfig) => {
  const projects = (await dokploy.get("project.all")) as ReadonlyArray<{
    readonly environments?: ReadonlyArray<{
      readonly compose?: ReadonlyArray<{ readonly composeId: string; readonly name: string }>;
    }>;
  }>;
  const matches = projects.flatMap((project) =>
    (project.environments ?? []).flatMap((environment) =>
      (environment.compose ?? []).filter((compose) => compose.name === config.composeName),
    ),
  );
  const [match] = matches;
  if (match === undefined || matches.length !== 1)
    throw new Error(
      `Expected one Dokploy compose named ${config.composeName}, found ${matches.length}`,
    );
  const compose = await readCompose(dokploy, match.composeId);
  const images = [...new Set(compose.composeFile.match(immutableImage) ?? [])];
  const [image] = images;
  if (image === undefined || images.length !== 1)
    throw new Error(`Expected one immutable image in the Executor compose, found ${images.length}`);
  const backups = (
    (await dokploy.get("volumeBackups.list", {
      id: match.composeId,
      volumeBackupType: "compose",
    })) as ReadonlyArray<{
      readonly volumeBackupId: string;
      readonly enabled: boolean;
      readonly turnOff: boolean;
      readonly serviceName: string;
    }>
  ).filter((backup) => backup.enabled && backup.turnOff);
  const [backup] = backups;
  if (backup === undefined || backups.length !== 1)
    throw new Error(`Expected one enabled stopped-volume backup, found ${backups.length}`);
  const executor = envFile("executor", ["EXECUTOR_URL"]);
  return {
    composeId: match.composeId,
    appName: compose.appName,
    serviceName: backup.serviceName,
    volumeBackupId: backup.volumeBackupId,
    repository: image.slice(0, image.indexOf("@")),
    image,
    origin: executor("EXECUTOR_URL")
      .replace(/\/+$/, "")
      .replace(/\/(mcp|api)$/, ""),
  } satisfies Service;
};

export const imageSource = async (image: string) => {
  const inspect = () => run("docker", ["image", "inspect", image, "--format", "{{json .Config}}"]);
  let output = await inspect();
  if (output.code !== 0) {
    await must("docker", ["pull", "--quiet", image], { timeoutSeconds: 600 });
    output = await inspect();
  }
  const configuration = JSON.parse(output.stdout) as {
    readonly Labels?: Record<string, string> | null;
    readonly Env?: ReadonlyArray<string>;
  };
  const label = configuration.Labels?.["org.opencontainers.image.revision"];
  const environment = configuration.Env?.find((entry) =>
    entry.startsWith("EXECUTOR_BUILD_VERSION="),
  )?.slice("EXECUTOR_BUILD_VERSION=".length);
  const revision = label ?? environment;
  if (revision === undefined || !/^[0-9a-f]{7,40}$/.test(revision))
    throw new Error(`${image} names no source revision`);
  return { revision, from: label === undefined ? "EXECUTOR_BUILD_VERSION" : "OCI revision label" };
};

export type ContainerState = {
  readonly id: string;
  readonly image: string;
  readonly health: string;
  readonly restarts: number;
  readonly oom: boolean;
  readonly volume: string;
};

const inspectFormat =
  '{{.Id}} {{.Config.Image}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}} {{.State.OOMKilled}} {{.State.Status}} {{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}';

export const inspectContainer = async (identity: string): Promise<ContainerState | undefined> => {
  const output = await run("docker", ["inspect", "--format", inspectFormat, identity], {
    timeoutSeconds: 15,
  });
  if (output.code !== 0) return undefined;
  const [id = "", image = "", health = "", restarts = "0", oom = "", status = "", volume = ""] =
    output.stdout.trim().split(" ");
  if (status !== "running") return undefined;
  return { id, image, health, restarts: Number(restarts), oom: oom === "true", volume };
};

export const serviceContainer = async (service: Service) => {
  const ids = (
    await must(
      "docker",
      [
        "ps",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${service.appName}`,
        "--filter",
        `label=com.docker.compose.service=${service.serviceName}`,
      ],
      { timeoutSeconds: 15 },
    )
  )
    .split("\n")
    .filter((line) => line !== "");
  if (ids.length > 1) throw new Error("Expected one Executor container");
  const [id] = ids;
  return id === undefined ? undefined : inspectContainer(id);
};

export const httpStatus = async (url: string) => {
  try {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(8_000) });
    await response.arrayBuffer();
    return response.status;
  } catch {
    return 0;
  }
};

export const waitHealthy = async (service: Service, image: string, seconds = 135) => {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const live = await serviceContainer(service);
    if (live !== undefined && live.image === image) {
      if (live.health === "unhealthy" || live.restarts > 0 || live.oom)
        throw new Error(`The container on ${image} failed its start: ${live.health}`);
      if (live.health === "healthy" && (await httpStatus(`${service.origin}/`)) === 200)
        return live;
    }
    await sleep(2);
  }
  throw new Error(`Executor on ${image} did not become healthy within ${seconds} seconds`);
};

const waitJob = async (
  dokploy: Dokploy,
  endpoint: string,
  query: Json,
  known: ReadonlySet<string>,
  seconds: number,
) => {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const jobs = (
      (await dokploy.get(endpoint, query)) as ReadonlyArray<{
        readonly deploymentId: string;
        readonly status: string;
      }>
    ).filter((job) => !known.has(job.deploymentId));
    if (jobs.some((job) => job.status === "error"))
      throw new Error(`A Dokploy job from ${endpoint} failed`);
    const done = jobs.filter((job) => job.status === "done");
    const [first] = done;
    if (first !== undefined && done.length === 1) return first.deploymentId;
    if (done.length > 1) throw new Error("More than one Dokploy job completed");
    await sleep(2);
  }
  throw new Error(`No Dokploy job from ${endpoint} completed within ${seconds} seconds`);
};

const knownJobs = async (dokploy: Dokploy, endpoint: string, query: Json) =>
  new Set(
    ((await dokploy.get(endpoint, query)) as ReadonlyArray<{ readonly deploymentId: string }>).map(
      (job) => job.deploymentId,
    ),
  );

export const composeFingerprint = (compose: Compose, service: Service, image: string) => {
  if (compose.composeFile.split(image).length !== 2)
    throw new Error(`The Executor compose does not name ${image} exactly once`);
  const normalized = [
    compose.composeFile.replace(image, `${service.repository}@COMPOSE_IMAGE`),
    compose.env,
  ];
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
};

export const sha256File = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .once("error", reject)
      .once("end", () => resolve(hash.digest("hex")));
  });

export type BackupRecord = {
  readonly job: string;
  readonly remote: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly volume: string;
  readonly archive: string;
};

const rclone = ["-n", "rclone", "--config", "/root/.config/rclone/rclone.conf"];

export const stoppedVolumeBackup = async (
  dokploy: Dokploy,
  service: Service,
  config: ReleaseConfig,
  image: string,
  archive: string,
): Promise<BackupRecord> => {
  const row = (await dokploy.get("volumeBackups.one", {
    volumeBackupId: service.volumeBackupId,
  })) as { readonly enabled: boolean; readonly turnOff: boolean; readonly composeId: string };
  if (!row.enabled || !row.turnOff || row.composeId !== service.composeId)
    throw new Error("The stopped-volume backup configuration changed");
  const query = { id: service.volumeBackupId, type: "volumeBackup" };
  const known = await knownJobs(dokploy, "deployment.allByType", query);
  await dokploy.post("volumeBackups.runManually", { volumeBackupId: service.volumeBackupId });
  const job = await waitJob(dokploy, "deployment.allByType", query, known, 240);
  const log = String(await dokploy.get("deployment.readLogs", { deploymentId: job, tail: 10000 }));
  for (const text of [
    "Turning off volume backup: Yes",
    "Volume backup done",
    "Compose container started",
    "Upload to S3 done",
  ])
    if (!log.includes(text))
      throw new Error(`The backup log does not confirm "${text}"; see Dokploy job ${job}`);
  const filename = /Backup file name:\s*([a-zA-Z0-9_-]+\.tar)/.exec(log)?.[1];
  if (filename === undefined) throw new Error("The backup log names no archive");
  const remote = `${config.backupRemote}/${service.appName}_${service.serviceName}/${filename}`;
  const uploaded = JSON.parse(await must("sudo", [...rclone, "lsjson", "--stat", remote])) as {
    readonly Size: number;
  };
  await must("sudo", [...rclone, "copyto", remote, archive], { timeoutSeconds: 900 });
  const owner = statSync(path.dirname(archive));
  await must("sudo", ["-n", "chown", `${owner.uid}:${owner.gid}`, archive]);
  chmodSync(archive, 0o600);
  const bytes = statSync(archive).size;
  if (bytes !== uploaded.Size)
    throw new Error("The backup readback size differs from the uploaded archive");
  const sha256 = await sha256File(archive);
  const names = (await must("tar", ["-tf", archive], { timeoutSeconds: 300 })).split("\n");
  for (const suffix of ["encryption.key", "auth-secret.key"])
    if (!names.some((name) => name.endsWith(suffix)))
      throw new Error(`The backup archive has no ${suffix}`);
  if (!names.some((name) => /\.(sqlite|db)$/.test(name)))
    throw new Error("The backup archive has no database");
  const live = await waitHealthy(service, image);
  return { job, remote, bytes, sha256, volume: live.volume, archive };
};

export const switchImage = async (
  dokploy: Dokploy,
  service: Service,
  from: string,
  to: string,
  title: string,
  expectedFingerprint: string,
) => {
  const compose = await readCompose(dokploy, service.composeId);
  if (composeFingerprint(compose, service, from) !== expectedFingerprint)
    throw new Error("The Executor compose changed outside this release");
  const query = { composeId: service.composeId };
  const known = await knownJobs(dokploy, "deployment.allByCompose", query);
  await dokploy.post("compose.update", {
    ...query,
    composeFile: compose.composeFile.replace(from, to),
  });
  await dokploy.post("compose.deploy", { ...query, title, freshVolumes: false });
  const job = await waitJob(dokploy, "deployment.allByCompose", query, known, 150);
  return { job, ...(await waitHealthy(service, to)) };
};

export const restoreVolume = async (
  dokploy: Dokploy,
  service: Service,
  backup: BackupRecord,
  aside: string,
) => {
  if ((await sha256File(backup.archive)) !== backup.sha256)
    throw new Error("The backup archive no longer matches its recorded SHA-256");
  if (existsSync(aside)) throw new Error(`${aside} already exists; inspect the earlier restore`);
  await must("sudo", ["-n", "true"], { timeoutSeconds: 5 });
  await dokploy.post("compose.stop", { composeId: service.composeId });
  const end = Date.now() + 45_000;
  while ((await serviceContainer(service)) !== undefined && Date.now() < end) await sleep(1);
  if ((await serviceContainer(service)) !== undefined) throw new Error("Executor is still running");
  const mount = await must("docker", [
    "volume",
    "inspect",
    backup.volume,
    "--format",
    "{{.Mountpoint}}",
  ]);
  if (mount !== `/var/lib/docker/volumes/${backup.volume}/_data`)
    throw new Error(`Unexpected volume location ${mount}`);
  mkdirSync(aside, { mode: 0o700 });
  await must("sudo", [
    "-n",
    "find",
    mount,
    "-mindepth",
    "1",
    "-maxdepth",
    "1",
    "-exec",
    "mv",
    "-t",
    aside,
    "--",
    "{}",
    "+",
  ]);
  await must("sudo", ["-n", "tar", "--numeric-owner", "-xpf", backup.archive, "-C", mount], {
    timeoutSeconds: 900,
  });
};
