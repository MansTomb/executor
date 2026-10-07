/** Current baseline and the additive repair required by existing version 4 databases. */
import { fumadb } from "fumadb-effect";
import { column, idColumn, schema, table } from "fumadb-effect/schema";
import { Effect, Schema } from "effect";
import { storageSchema } from "./storage-schema.ts";

/** Indexes that are part of the current storage contract, including fresh databases. */
export const storageIndexes = [
  "CREATE UNIQUE INDEX IF NOT EXISTS executor_workflow_runs_context_key ON executor_workflow_runs (app, COALESCE(installation, ''), start_key)",
  "CREATE UNIQUE INDEX IF NOT EXISTS executor_webhooks_context_key ON executor_webhooks (app, COALESCE(installation, ''), subscription_key)",
  "CREATE UNIQUE INDEX IF NOT EXISTS executor_schedules_context_name ON executor_schedules (app, COALESCE(installation, ''), name)",
  "CREATE INDEX IF NOT EXISTS executor_schedules_due ON executor_schedules (enabled, active_run, next_at)",
  "CREATE INDEX IF NOT EXISTS executor_scheduled_runs_pending ON executor_scheduled_runs (status, expires_at)",
  "CREATE INDEX IF NOT EXISTS executor_scheduled_runs_owner ON executor_scheduled_runs (owner, started_at)",
] as const;

/** Version 4 is the oldest supported layout. Append future compatible upgrades here. */
const analyticsTable = table("executor_analytics_events", {
  id: idColumn("id", Schema.String, { type: "varchar(36)" }),
  app: column("app", Schema.String, { type: "varchar(255)" }),
  owner: column("owner", Schema.String, { type: "varchar(255)" }),
  timestamp: column("timestamp", Schema.Number, { type: "bigint" }),
  event: column("event", Schema.String, { type: "varchar(64)" }),
  operation: column("operation", Schema.NullOr(Schema.String), { type: "varchar(64)" }),
  transport: column("transport", Schema.NullOr(Schema.String), { type: "varchar(16)" }),
  purpose: column("purpose", Schema.NullOr(Schema.String), { type: "varchar(64)" }),
  phase: column("phase", Schema.NullOr(Schema.String), { type: "varchar(16)" }),
  outcome: column("outcome", Schema.NullOr(Schema.String), { type: "varchar(16)" }),
  statusCode: column("status_code", Schema.NullOr(Schema.Int)),
  durationMs: column("duration_ms", Schema.NullOr(Schema.Number)),
});
export const analyticsIndexes = [
  "CREATE INDEX IF NOT EXISTS executor_analytics_scope_time ON executor_analytics_events (app, owner, timestamp)",
  "CREATE INDEX IF NOT EXISTS executor_analytics_time ON executor_analytics_events (timestamp)",
] as const;
export const storageSchemas = [
  storageSchema,
  schema({
    version: "4.0.1",
    tables: storageSchema.tables,
    up: () => Effect.succeed(storageIndexes.map((sql) => ({ type: "custom" as const, sql }))),
  }),
  schema({
    version: "4.0.2",
    tables: { ...storageSchema.tables, analyticsEvents: analyticsTable },
    up: () =>
      Effect.succeed([
        {
          type: "custom" as const,
          sql: "CREATE TABLE IF NOT EXISTS executor_analytics_events (id varchar(36) PRIMARY KEY, app varchar(255) NOT NULL, owner varchar(255) NOT NULL, timestamp bigint NOT NULL, event varchar(64) NOT NULL, operation varchar(64), transport varchar(16), purpose varchar(64), phase varchar(16), outcome varchar(16), status_code integer, duration_ms double precision)",
        },
        ...analyticsIndexes.map((sql) => ({ type: "custom" as const, sql })),
      ]),
  }),
] as const;

/** Versioned persistence factory; constructing it does not touch a database. */
export const executorDatabase = fumadb({
  namespace: "executor",
  schemas: storageSchemas,
});
