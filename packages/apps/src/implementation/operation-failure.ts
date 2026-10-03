import { Option, Schema } from "effect";
import type { ResolvedAccounts } from "../contracts/host.ts";
import { OpenapiError } from "../contracts/openapi.ts";
import { GraphqlError } from "../contracts/graphql.ts";
import { McpError } from "../contracts/mcp.ts";

const detail = Schema.decodeUnknownOption(
  Schema.Struct({
    message: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown),
  }),
);

function values(value: unknown, depth = 0): string[] {
  if (typeof value === "string") return value.length === 0 ? [] : [value];
  if (value === null || typeof value !== "object" || depth === 8) return [];
  return Object.values(value).flatMap((entry) => values(entry, depth + 1));
}

export function operationFailureReason(error: unknown, accounts: ResolvedAccounts, input: unknown) {
  const privateValues = [
    ...Object.values(accounts).flatMap((selection) =>
      (Array.isArray(selection) ? selection : [selection]).flatMap((account) =>
        values(account.fields),
      ),
    ),
    ...values(input),
  ]
    .flatMap((value) => [value, JSON.stringify(value).slice(1, -1)])
    .sort((a, b) => b.length - a.length);
  const redact = (text: string) => {
    let result = text;
    for (const value of privateValues) {
      result = result.replaceAll(value, "[redacted]");
    }
    return result
      .replace(
        /"(token|password|secret|api[-_]?key|authorization|cookie)"\s*:\s*"(?:\\.|[^"\\])*"/gi,
        '"$1":"[redacted]"',
      )
      .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [redacted]")
      .replace(
        /\b(token|password|secret|api[-_]?key|authorization|cookie)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
        "$1=[redacted]",
      )
      .replace(/https?:\/\/[^\s"'<>]+/gi, (address) => {
        try {
          const url = new URL(address);
          return `${url.protocol}//${url.host}${url.pathname}`;
        } catch {
          return "[redacted URL]";
        }
      })
      .replace(/[\r\n\t]+/g, " ")
      .slice(0, 1024);
  };
  const messages: string[] = [];
  const seen = new Set<unknown>();
  for (let current: unknown = error; current !== undefined && messages.length < 4;) {
    if (seen.has(current)) break;
    seen.add(current);
    if (
      Schema.is(OpenapiError)(current) ||
      Schema.is(GraphqlError)(current) ||
      Schema.is(McpError)(current)
    ) {
      messages.push(
        `${current.reason === "timeout" ? "The connected service request timed out; the action's outcome is unknown" : `The connected service request failed: ${current.reason.replaceAll("_", " ")}`}${current.status === undefined ? "" : ` (HTTP ${current.status})`}`,
      );
      break;
    }
    if (typeof current === "string") {
      messages.push(redact(current));
      break;
    }
    const parsed = detail(current);
    if (Option.isNone(parsed)) break;
    if (parsed.value.message?.trim()) messages.push(redact(parsed.value.message));
    current = parsed.value.cause;
    if (seen.size === 4) break;
  }
  return (
    messages.filter(Boolean).join(" Caused by: ").slice(0, 4096) ||
    "The app operation failed without an explanation."
  );
}
