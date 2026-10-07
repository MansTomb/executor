import { Schema } from "effect";
import { column, idColumn, table } from "fumadb-effect/schema";

export const analyticsTable = table("executor_analytics_events", {
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
