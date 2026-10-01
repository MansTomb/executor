/**
 * Each team's last observed app domain readiness. The coordinator writes it after every pass;
 * the API reads it with the request's other queries, so opening an app never wakes the
 * coordinator unless the team has no current record.
 */
import { OrganizationId, OrganizationSlug } from "@executor-js/hosted-server/organization";
import { UiFailed } from "apps/ui/contracts";
import { Context, DateTime, Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const AppDomainStatus = Schema.Literals(["pending", "ready", "failed"]);

export const AppDomainRecord = Schema.Struct({
  organization_id: OrganizationId,
  slug: OrganizationSlug,
  status: AppDomainStatus,
  checked_at: Schema.Date,
});

/** The request's database client; the API binds it to the same execution as its other reads. */
export class AppDomainDatabase extends Context.Service<
  AppDomainDatabase,
  Effect.Effect<SqlClient.SqlClient, UiFailed>
>()("cloud/AppDomainDatabase") {}

/** Additive: the running server never reads it. No backfill; the next pass writes every team. */
export const migrateAppDomainRecords = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table if not exists cloud_app_domain (
    organization_id text primary key references organization(id) on delete cascade,
    slug text not null,
    status text not null check (status in ('pending', 'ready', 'failed')),
    checked_at timestamptz not null
  )`;
});

export const readAppDomainRecord = (organization: typeof OrganizationId.Type) =>
  Effect.gen(function* () {
    const sql = yield* Effect.flatten(AppDomainDatabase);
    const rows = yield* sql`select organization_id, slug, status, checked_at
      from cloud_app_domain where organization_id = ${organization}`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(AppDomainRecord))),
      Effect.mapError(() => new UiFailed({ reason: "unavailable" })),
    );
    return rows[0];
  });

/** Upsert one pass's observations. A deleted team's record goes with it by cascade. */
export const writeAppDomainRecords = (
  records: ReadonlyArray<{
    readonly organization: typeof OrganizationId.Type;
    readonly slug: typeof OrganizationSlug.Type;
    readonly status: typeof AppDomainStatus.Type;
  }>,
  checkedAt: DateTime.Utc,
) =>
  Effect.gen(function* () {
    if (records.length === 0) return;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`insert into cloud_app_domain ${sql.insert(
      records.map((record) => ({
        organization_id: record.organization,
        slug: record.slug,
        status: record.status,
        checked_at: DateTime.toDateUtc(checkedAt),
      })),
    )} on conflict (organization_id) do update set
      slug = excluded.slug, status = excluded.status, checked_at = excluded.checked_at`;
  });
