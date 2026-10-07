import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { AppId, OwnerId, RequestInvalid, StorageError } from "./shared.ts";
import { AppNotFound } from "./apps.ts";

export const AnalyticsDimension = Schema.Literals([
  "event",
  "operation",
  "transport",
  "purpose",
  "phase",
  "outcome",
  "statusCode",
]);
const name = Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u));
const timestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const AnalyticsQuery = {
  from: timestamp,
  to: timestamp,
  event: Schema.optional(name),
  operation: Schema.optional(name),
  transport: Schema.optional(Schema.Literals(["rest", "mcp", "http", "executor", "internal"])),
  purpose: Schema.optional(name),
  groupBy: Schema.optional(Schema.Array(AnalyticsDimension).check(Schema.isMaxLength(3))),
};
export const AnalyticsSummary = Schema.Struct({
  from: timestamp,
  to: timestamp,
  retainedFrom: timestamp,
  retentionDays: Schema.Literal(30),
  bestEffort: Schema.Literal(true),
  completeness: Schema.Literal("not-guaranteed"),
  matchedEvents: Schema.Int,
  truncated: Schema.Boolean,
  groups: Schema.Array(
    Schema.Struct({
      dimensions: Schema.Record(
        Schema.String,
        Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
      ),
      count: Schema.Int,
      durationMs: Schema.Number,
    }),
  ),
});
export const AnalyticsInputs = Schema.Struct({
  app: AppId,
  ...AnalyticsQuery,
  owner: Schema.optional(OwnerId),
});
export const AnalyticsGroup = HttpApiGroup.make("analytics").add(
  HttpApiEndpoint.get("summary", "/v1/apps/:app/analytics", {
    params: { app: AppId },
    query: { ...AnalyticsQuery, owner: Schema.optional(OwnerId) },
    success: AnalyticsSummary,
    error: [AppNotFound, RequestInvalid, StorageError],
  }),
);
