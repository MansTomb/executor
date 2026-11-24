import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { elapsed, must, run } from "./shell.ts";

export const builder = "executor-release";

const ensureBuilder = async () => {
  if ((await run("docker", ["buildx", "inspect", builder])).code === 0) return;
  await must(
    "docker",
    ["buildx", "create", "--name", builder, "--driver", "docker-container", "--bootstrap"],
    { timeoutSeconds: 300 },
  );
};

export type Image = {
  readonly tag: string;
  readonly digest: string;
  readonly reference: string;
  readonly seconds: number;
  readonly cachedSteps: number;
  readonly builtSteps: number;
};

export const buildImage = async (options: {
  readonly worktree: string;
  readonly candidate: string;
  readonly repository: string;
  readonly tagPrefix: string;
  readonly sourceUrl: string;
  readonly log: string;
  readonly metadata: string;
}): Promise<Image> => {
  const started = Date.now();
  await ensureBuilder();
  const context = mkdtempSync(path.join(tmpdir(), "executor-release-context-"));
  try {
    const archive = `${context}.tar`;
    await must("git", [
      "-C",
      options.worktree,
      "archive",
      "--format=tar",
      `--output=${archive}`,
      options.candidate,
    ]);
    await must("tar", ["-xf", archive, "-C", context]);
    rmSync(archive);
    const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const tag = `${options.repository}:${options.tagPrefix}-${date}-${options.candidate.slice(0, 9)}`;
    await must(
      "docker",
      [
        "buildx",
        "build",
        "--builder",
        builder,
        "--progress",
        "plain",
        "--file",
        path.join(context, "apps/hosted/self-host/Dockerfile"),
        "--build-arg",
        `EXECUTOR_BUILD_VERSION=${options.candidate}`,
        "--label",
        `org.opencontainers.image.revision=${options.candidate}`,
        "--label",
        `org.opencontainers.image.source=${options.sourceUrl}`,
        "--tag",
        tag,
        "--push",
        "--metadata-file",
        options.metadata,
        context,
      ],
      { log: options.log, timeoutSeconds: 1800 },
    );
    const metadata = JSON.parse(readFileSync(options.metadata, "utf8")) as Record<string, unknown>;
    const digest = metadata["containerimage.digest"];
    if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest))
      throw new Error("The build reported no image digest");
    const reference = `${options.repository}@${digest}`;
    await must("docker", ["pull", "--quiet", reference], { timeoutSeconds: 900 });
    const output = readFileSync(options.log, "utf8");
    return {
      tag,
      digest,
      reference,
      seconds: elapsed(started),
      cachedSteps: output.match(/^#\d+ CACHED$/gm)?.length ?? 0,
      builtSteps: output.match(/^#\d+ DONE /gm)?.length ?? 0,
    };
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
};
