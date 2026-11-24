import { readFileSync } from "node:fs";
import type { ReleaseConfig } from "./config.ts";
import { run } from "./shell.ts";

export const notify = async (
  config: ReleaseConfig,
  scope: string,
  event: {
    readonly failed: boolean;
    readonly subject: string;
    readonly title: string;
    readonly data: unknown;
  },
) => {
  const input = {
    type: event.failed ? "executor.release.failed" : "executor.release.passed",
    subject: event.subject,
    scope,
    title: event.title,
    url: null,
    data: event.data,
    urgent: event.failed,
  };
  try {
    const output = await run(
      "bun",
      [config.notify.client, config.notify.url, "emit", JSON.stringify(input)],
      {
        env: { FUNNEL_MCP_TOKEN: readFileSync(config.notify.tokenFile, "utf8").trim() },
        timeoutSeconds: 60,
      },
    );
    return {
      sent: output.code === 0,
      input,
      reply: output.code === 0 ? (JSON.parse(output.stdout) as unknown) : output.stderr.trim(),
    };
  } catch (error) {
    return { sent: false, input, reply: error instanceof Error ? error.message : String(error) };
  }
};
