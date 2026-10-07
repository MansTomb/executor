import { Clock, Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { AnalyticsRecord } from "@executor-js/telemetry";
import { AnalyticsInputs, AnalyticsSummary } from "../contracts/analytics.ts";
import { type OwnerId, RequestInvalid, StorageError } from "../contracts/shared.ts";

const retention = 30 * 86_400_000;
const columns = {
  event: "event",
  operation: "operation",
  transport: "transport",
  purpose: "purpose",
  phase: "phase",
  outcome: "outcome",
  statusCode: "status_code",
} as const;
export const makeAnalyticsStorage = (sql: SqlClient.SqlClient) => {
  const prune = Effect.gen(function* () {
    const cutoff = (yield* Clock.currentTimeMillis) - retention;
    yield* sql`DELETE FROM executor_analytics_events WHERE id IN (SELECT id FROM executor_analytics_events WHERE timestamp < ${cutoff} ORDER BY timestamp LIMIT 1000)`;
  });
  return {
    append: (scope: { app: string; owner: string }, records: readonly AnalyticsRecord[]) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const valid = yield* Schema.decodeUnknownEffect(Schema.Array(AnalyticsRecord))(records);
        const rows = valid
          .filter((record) => record.timestamp >= now - retention && record.timestamp <= now)
          .map((record) => ({
            id: record.id,
            app: scope.app,
            owner: scope.owner,
            timestamp: record.timestamp,
            event: record.value.event,
            operation: record.value.operation ?? null,
            transport: record.value.transport ?? null,
            purpose: record.value.purpose ?? null,
            phase: record.value.phase ?? null,
            outcome: "outcome" in record.value ? (record.value.outcome ?? null) : null,
            status_code: "statusCode" in record.value ? (record.value.statusCode ?? null) : null,
            duration_ms: "durationMs" in record.value ? (record.value.durationMs ?? null) : null,
          }));
        if (rows.length > 0)
          yield* sql`INSERT INTO executor_analytics_events ${sql.insert(rows)} ON CONFLICT (id) DO NOTHING`;
        yield* prune;
      }).pipe(
        sql.withTransaction,
        Effect.catchCause(() =>
          Effect.logWarning("Analytics persistence failed; events may be lost"),
        ),
      ),
    summary: (input: Omit<typeof AnalyticsInputs.Type, "owner"> & { readonly owner: OwnerId }) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (input.from >= input.to || input.to - input.from > retention || input.to > now)
          return yield* new RequestInvalid();
        yield* prune;
        const retainedFrom = Math.max(0, now - retention);
        const filters = [
          sql`app = ${input.app}`,
          sql`owner = ${input.owner}`,
          sql`timestamp >= ${Math.max(input.from, retainedFrom)}`,
          sql`timestamp < ${input.to}`,
        ];
        for (const key of ["event", "operation", "transport", "purpose"] as const) {
          const value = input[key];
          if (value !== undefined) filters.push(sql`${sql(columns[key])} = ${value}`);
        }
        const groupBy = [...new Set(input.groupBy ?? [])];
        const selection = sql.csv(groupBy.map((key) => sql`${sql(columns[key])} AS ${sql(key)}`));
        const rows = yield* sql<
          Record<string, unknown>
        >`SELECT ${groupBy.length ? sql`${selection},` : sql.literal("")} COUNT(*) AS count, COALESCE(SUM(duration_ms), 0) AS duration FROM executor_analytics_events WHERE ${sql.and(filters)} ${groupBy.length ? sql`GROUP BY ${sql.csv(groupBy.map((key) => sql`${sql(columns[key])}`))}` : sql.literal("")} ORDER BY count DESC LIMIT 1001`;
        const totals = yield* sql<{
          count: number | string;
        }>`SELECT COUNT(*) AS count FROM executor_analytics_events WHERE ${sql.and(filters)}`;
        return yield* Schema.decodeUnknownEffect(AnalyticsSummary)({
          from: input.from,
          to: input.to,
          retainedFrom,
          retentionDays: 30,
          bestEffort: true,
          completeness: "not-guaranteed",
          matchedEvents: Number(totals[0]?.count ?? 0),
          truncated: rows.length > 1000,
          groups: rows.slice(0, 1000).map((row) => ({
            dimensions: Object.fromEntries(groupBy.map((key) => [key, row[key] ?? null])),
            count: Number(row.count),
            durationMs: Number(row.duration),
          })),
        });
      }).pipe(
        sql.withTransaction,
        Effect.catchTag("SqlError", () => new StorageError()),
        Effect.catchTag("SchemaError", () => new StorageError()),
      ),
  };
};
