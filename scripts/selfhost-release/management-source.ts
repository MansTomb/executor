import { Effect } from "effect";
import { defaultExecutorAppSource } from "../../apps/hosted/server/src/implementation/executor-app.ts";

type Document = Parameters<typeof defaultExecutorAppSource>[1];

const origin = process.argv[2];
if (origin === undefined) throw new Error("Usage: management-source.ts <server origin>");
const response = await fetch(`${origin}/openapi.json`, { signal: AbortSignal.timeout(30_000) });
if (!response.ok) throw new Error(`${origin}/openapi.json answered ${response.status}`);
const document = (await response.json()) as Document;
const source = await Effect.runPromise(defaultExecutorAppSource(origin, document));
const operations = Object.values(document.paths as Record<string, Record<string, unknown>>)
  .flatMap((item) => Object.values(item))
  .map((operation) => (operation as { readonly operationId?: unknown }).operationId)
  .filter((operation): operation is string => typeof operation === "string");
process.stdout.write(JSON.stringify({ files: source.files, operations }));
