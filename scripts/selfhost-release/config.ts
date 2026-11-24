import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type ReadCall = { readonly app: string; readonly path: string; readonly input: unknown };

export type ReleaseConfig = {
  readonly composeName: string;
  readonly organization: string;
  readonly analyticsApp: string;
  readonly reads: ReadonlyArray<ReadCall>;
  readonly catalogOnly: ReadonlyArray<{ readonly app: string; readonly query: string }>;
  readonly backupRemote: string;
  readonly evidenceRoot: string;
  readonly availability: string;
  readonly sourceUrl: string;
  readonly notify: {
    readonly url: string;
    readonly tokenFile: string;
    readonly client: string;
    readonly scope: string;
  };
};

export const home = (value: string) =>
  value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;

export const defaultConfig = "~/Work/Agents/projects/executor/release.json";

export const readConfig = (file: string): ReleaseConfig => {
  const value = JSON.parse(readFileSync(home(file), "utf8")) as ReleaseConfig;
  return {
    ...value,
    evidenceRoot: home(value.evidenceRoot),
    availability: home(value.availability),
    notify: {
      ...value.notify,
      tokenFile: home(value.notify.tokenFile),
      client: home(value.notify.client),
    },
  };
};

export const envFile = (name: string, keys: ReadonlyArray<string>) => {
  const values = new Map<string, string>();
  for (const line of readFileSync(path.join(homedir(), ".config", `${name}.env`), "utf8").split(
    "\n",
  )) {
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    if (keys.includes(key))
      values.set(
        key,
        line
          .slice(separator + 1)
          .trim()
          .replace(/^["']|["']$/g, ""),
      );
  }
  for (const key of keys)
    if (!values.has(key)) throw new Error(`~/.config/${name}.env does not set ${key}`);
  return (key: string) => values.get(key) ?? "";
};
