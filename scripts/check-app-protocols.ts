/**
 * Released host protocols are immutable. Retained builds and published `apps` versions speak them,
 * so every later host must keep running and rebuilding those bundles unchanged. This check compares
 * each released protocol's messages with its committed snapshot in `packages/apps/protocols/`.
 * A difference means the boundary changed: restore the old schema and define the next protocol
 * with a host adapter instead. See notes/apps-publishing.md.
 *
 * A snapshot records Effect's schema representation of each message's JSON form: the document that
 * `Schema.toJsonSchemaDocument` compiles, before JSON Schema drops detail. Checks keep their exact
 * parameters, such as a length bound or a pattern's source and flags. Named schemas that several
 * messages reach are recorded once under `references`.
 *
 * `--write` records snapshots for protocols that have none yet. It never replaces a snapshot; to
 * reshape a protocol that has not been released, delete its unreleased snapshot first.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { Array as Arr, Schema, SchemaRepresentation } from "effect";
import { frameworkProtocol } from "../packages/apps/src/contracts/protocol-version.ts";
import { releasedProtocols } from "../packages/apps/src/contracts/protocols/released.ts";
import { supportedProtocols } from "../packages/sdk/src/implementation/app-protocols.ts";

const directory = new URL("../packages/apps/protocols/", import.meta.url);
const write = process.argv.includes("--write");

/** Documentation and Effect's generated failure text do not change what a message accepts. */
const documentation = new Set([
  "description",
  "title",
  "examples",
  "markdownDescription",
  "expected",
]);

/**
 * The representation as plain JSON. Functions are compiler hooks; a built-in check's hooks follow
 * from its recorded representation. Any other value that JSON cannot hold fails the check.
 */
const plain = (value: unknown, path: string, annotations = false): unknown => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry, index) => plain(entry, `${path}[${index}]`));
  if (typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new Error(`${path} is not JSON data: ${String(value)}`);
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      if (typeof entry === "function" || entry === undefined) return [];
      if (annotations && documentation.has(key)) return [];
      const json = plain(entry, `${path}.${key}`, key === "annotations");
      const empty = typeof json === "object" && json !== null && Object.keys(json).length === 0;
      return key === "annotations" && empty ? [] : [[key, json] as const];
    }),
  );
};

type Snapshot = {
  readonly protocol: number;
  readonly messages: Record<string, unknown>;
  readonly references: Record<string, unknown>;
};

const record = (version: number, schemas: Readonly<Record<string, Schema.Top>>): Snapshot => {
  const messages = Object.entries(schemas);
  const asts = messages.map(([, schema]) => Schema.toCodecJson(schema).ast);
  if (!Arr.isArrayNonEmpty(asts)) throw new Error(`Protocol ${version} has no messages.`);
  const { representations, references } = SchemaRepresentation.toRepresentations(asts);
  return JSON.parse(
    JSON.stringify({
      protocol: version,
      messages: plain(
        Object.fromEntries(messages.map(([name], index) => [name, representations[index]])),
        "messages",
      ),
      references: plain(references, "references"),
    }),
  );
};

/** Messages and shared references whose recorded representation differs. */
const differences = (committed: Partial<Snapshot>, generated: Snapshot) =>
  (["messages", "references"] as const).flatMap((part) =>
    [...new Set([...Object.keys(committed[part] ?? {}), ...Object.keys(generated[part])])]
      .filter((name) => !isDeepStrictEqual(committed[part]?.[name], generated[part][name]))
      .map((name) => (part === "messages" ? name : `reference ${name}`)),
  );

const failures: string[] = [];
const released = new Set<number>();
for (const protocol of releasedProtocols) {
  released.add(protocol.version);
  const generated = record(protocol.version, protocol.schemas);
  const file = new URL(`${protocol.version}.json`, directory);
  let committed: Partial<Snapshot>;
  try {
    committed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    if (write) {
      writeFileSync(file, `${JSON.stringify(generated, null, 2)}\n`);
      console.log(`Recorded protocol ${protocol.version}.`);
      continue;
    }
    failures.push(`Protocol ${protocol.version} has no snapshot. Run with --write to record it.`);
    continue;
  }
  if (isDeepStrictEqual(committed, generated)) continue;
  failures.push(
    `Released protocol ${protocol.version} changed (${differences(committed, generated).join(", ") || "protocol version"}). ` +
      "Released protocols are immutable: restore the old schema, then add a new protocol and a host adapter.",
  );
}
for (const name of readdirSync(directory)) {
  const version = Number(name.replace(/\.json$/, ""));
  if (!released.has(version))
    failures.push(
      `Snapshot ${name} has no released protocol. Released protocols are never removed.`,
    );
}
if (!released.has(frameworkProtocol))
  failures.push(`The framework speaks protocol ${frameworkProtocol}, which is not released.`);
if (!supportedProtocols.includes(frameworkProtocol))
  failures.push(`Hosts do not support protocol ${frameworkProtocol}, which the framework speaks.`);
for (const version of released)
  if (!supportedProtocols.includes(version))
    failures.push(`Hosts dropped released protocol ${version}; retained builds still speak it.`);

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log(`Host protocols unchanged: ${[...released].join(", ")}.`);
