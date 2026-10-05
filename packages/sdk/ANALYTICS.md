# App analytics reference

This branch adds analytics to the existing Executor database. Availability requires
an Executor image upgrade and app rebuild. Existing deployments do not expose this
API until upgraded.

## Author events

Every app context supplies a Promise API:

```ts
await context.analytics.emit({ event: "webhook_received", purpose: "slack" });
await context.analytics.emit({
  event: "upstream_request",
  operation: "get_task",
  transport: "rest",
  purpose: "task",
  phase: "started",
});
await context.analytics.emit({
  event: "upstream_request",
  operation: "get_task",
  transport: "rest",
  purpose: "task",
  phase: "completed",
  outcome: "success",
  statusCode: 200,
  durationMs: 12,
});
```

`event` is required. `operation`, `transport`, and `purpose` are optional.
Names start with a letter and contain only letters, digits, underscores, periods,
and hyphens, with a maximum length of 64. `transport` accepts `rest`, `mcp`, `http`,
`executor`, or `internal`.

Events without a phase cannot contain completion fields. A `started` event has
no completion fields. A `completed` event requires `outcome`, which accepts
`success`, `error`, or `cancelled`. Optional `statusCode` accepts integers from
100 to 599. Optional `durationMs` accepts numbers from zero to 86,400,000.
Unknown fields are rejected and dropped. Use fixed names, never task IDs, account
IDs, URLs, credentials, request bodies, or task contents.

Executor emits `tool_invocation` after approval and input validation, with
`transport: "executor"` and `purpose: "tool"`. It emits `upstream_request` around
native MCP `tools/call`, with the remote tool name as `operation`,
`transport: "mcp"`, and `purpose: "tool"`. Initialization and discovery are not
MCP tool attempts. Failed calls and MCP `isError` results have an error outcome.
App authors emit their own REST attempts and separate direct MCP requests.
They must not emit a second event around the native `next()` fallback.

## Summary API

The Promise SDK exposes `executor.analytics.summary`:

```ts
const to = Date.now();
const usage = await executor.analytics.summary({
  app: appId,
  from: to - 7 * 86_400_000,
  to,
  event: "upstream_request",
  groupBy: ["transport", "purpose", "outcome"],
});
```

The authenticated HTTP endpoints are:

- Local SDK API: `GET /v1/apps/:app/analytics`.
- Hosted API: `GET /api/organizations/:organization/apps/:app/analytics`.

`from` and `to` are epoch milliseconds. The interval includes `from` and excludes
`to`. `from` must precede `to`, and the range cannot exceed 30 days or end in the
future. Optional exact filters are `event`, `operation`, `transport`, and
`purpose`. HTTP requests repeat `groupBy` for each dimension:

```text
?from=1790553600000&to=1791158400000&event=upstream_request&groupBy=transport&groupBy=purpose&groupBy=outcome
```

At most three grouping dimensions are accepted. Available dimensions are
`event`, `operation`, `transport`, `purpose`, `phase`, `outcome`, and `statusCode`.
Absent values form a group with a null dimension. `durationMs` in each group is
the sum of recorded durations. Results contain at most 1,000 groups, ordered by
count. `truncated: true` indicates omitted groups. `matchedEvents` remains the
exact total for the filtered retained events.

The generated Executor management app exposes `queries.analytics_summary`,
with `path: { app }` and `query: { from: String(from), to: String(to), event, groupBy }`.
Its generated query fields use HTTP string values. Hosted organization
selection follows that app's existing context. Reads require authentication,
organization membership, app authorization, and the app's sharing permissions.
An SDK owner filter cannot select another owner's app. Local server API keys
retain their existing authority model.

## Retention and completeness

The additive database version `4.0.2` creates `executor_analytics_events` and
indexes without altering existing tables. The trusted host supplies the app and
owner scope. Event batches append atomically with duplicate event IDs ignored.
Summaries aggregate in SQL and use the same scope.

Retention is a rolling 30 days. Each append or summary removes at most 1,000
expired rows. Queries always exclude expired rows, even when physical cleanup
has a backlog. No service, queue, or scheduled job is required. The database
must remain in the product's persistent data directory. Local and self-host
products in this checkout use PGlite. An older deployed SQLite database requires
the existing product upgrade procedure before replacing its image.

Analytics is best effort. Emission and persistence failures cannot fail a
successful primary operation. The native Node adapter captures analytics from its invocation logger.
Worker invocation logs carry the records back to
the trusted host, independently of the external debug collector. Each returned
batch accepts at most 1,000 records. Crashes, cancelled invocations, lost return
batches, invalid events, and storage failures can lose events. A completed event
may be missing even when a started event exists.

Every response includes `bestEffort: true`, `completeness: "not-guaranteed"`,
`retentionDays: 30`, and `retainedFrom`. Missing events do not establish zero
upstream usage. For attempt totals, count `started` groups, or group by `phase`
and report incomplete pairs. These counters do not establish provider billing
or remaining quota.

## Verification

The real-server scenarios are reproducible without external ClickUp requests:

```sh
bun run e2e:prepare
bun run e2e:self-host --test-name 'ClickUp authored app|MCP Promise interceptors preserve'
bun run e2e:local --test-name 'Analytics totals survive'
```

The ClickUp scenario deploys the authored app through the Worker runtime and
uses synthetic MCP, REST, and OAuth servers. Its source snapshot changes only
the fixed upstream origins. It covers credential-bound identity setup, a remote
edit, live MCP fallback, failures, redirect rejection, scope checks, and the
generated analytics tool. The local scenario covers literal concurrent totals,
restart, additive upgrade from the prior database layout, bounded physical
pruning, retention, and honest result truncation.
