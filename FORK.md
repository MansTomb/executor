# Self-host reliability patches

This fork starts from `executor@2.0.0-beta.4`. The upstream remote is
`https://github.com/usefulsoftwareco/executor.git`; v2 development is on `v2`.
Upstream `main` currently contains the older 1.x architecture.

The maintained branch is `selfhost`. Local patches:

- `433ab7f6f`, `c77c0baec`: retain up to 16 idle app workers for five minutes.
  The October upstream merge ports this policy to `app-worker-residency.ts`;
  upstream capacity eviction is retained, with the fork limit and idle expiry.
  Evict idle workers under capacity pressure, preserve active calls, and dispose
  forwarded RPC results. Named dynamic workers in workerd 1.20260901.1 otherwise
  survive indefinitely. Declaration checks use uncached workers. Since the
  2026-10-14 merge upstream unloads idle Workers itself after
  `EXECUTOR_APP_WORKER_IDLE_SECONDS` (300 by default), so the fork's own expiry
  timer is gone; the fork keeps `defaultAppWorkerLimit` at 16, which now also
  counts data Workers.
- `37facaf6c`: discover only statically referenced app namespaces. Dynamic
  programs and unscoped tool searches retain full discovery and live authorization.
  Since 2026-10-14 upstream's on-demand discovery (`programReach`) provides it:
  only apps a program names or reaches load, each on first use; see below.
- `6565a3749`: drain admitted HTTP requests before stopping workerd. Close the
  listener during shutdown and allow 40 seconds for a 35-second drain deadline.
- `e23b30dfd`: use `--gc-global` in the packaged self-host runtime. Default GC
  allowed collectible worker and buffer memory to exceed a 4 GiB container even
  after worker eviction was fixed. More frequent major collections passed the
  same workload without reducing the per-isolate heap ceiling. This trades CPU
  and occasional collection pauses for lower memory use.
- `f70d35bcc`: load authorized tool summaries first, then batch schemas for
  selected search results. Discovery previously transported and rendered every
  schema twice. Live authorization, deployment and profile checks remain on each
  read; no cross-request catalog cache is added. Older builds retain full-list
  fallback. Warm ten-result search improved from 3.067/3.737 to 0.955/1.030 seconds
  p50/p95 with 4,090 synthetic tools. Full export is slower because it also reads
  summaries. The discovery and grant-restriction E2Es cover freshness and access.
  Ported on 2026-10-14 onto upstream's search; see below.
- `5e21403ca`: describe native MCP result envelopes instead of advertising their
  inner structured payload as the whole return value. Preserve upstream output
  validation and returned values. Ordinary references and statically bound
  recursion retain their schemas; unsupported relocation exposes generic
  structured content in discovery. Declared successful outputs still require
  structured content. Existing MCP apps must be rebuilt to pick up this helper.
  Result-contract and account-template E2Es cover projection and validation.
- `d616eaf1b`: retain SDK semantic tool failures in MCP per-call outcomes,
  including approved resumptions. A program that handles an error can still
  succeed and receives the original result. Ordinary data containing `isError`
  remains successful. Observability E2E covers handled, discarded, parallel and
  resumed results on self-host and Cloud.
- `69a64ab74`, `613ce0b00`: discover only the app named by a literal
  `tools.search` or `search` namespace, unioned with every app the program
  references statically. Unscoped searches, computed, spread or duplicated
  namespaces, tool-expression namespaces such as `tools.app`, and any other use
  of `search` keep full discovery. Live account, deployment, profile and grant
  checks are unchanged. The execute descriptions tell agents to use the scoped
  form. A scoped production search after five idle minutes fell from 27.5 to
  1.1 seconds end to end, and its warm repeat from 10.0 to 0.6 seconds. Selection, schema and grant-restriction E2Es
  cover scoped, unscoped, dynamic, repeated, mixed-app and narrowed searches.
  Since 2026-10-14 upstream's search reads only the apps a literal namespace names;
  the scoped-search guidance in the execute descriptions is kept.
- `163e32725`: report truncated execute output before the cut value. Agent
  harnesses keep only a prefix of a tool result (Pi and OptChat clip at 30,000
  characters), and CodeMode appends its notice after the value while
  `execution.ok` stays true, so agents lost both the notice and
  `execution.truncated`. A completed result whose output was cut now carries
  `truncation: { outputLimitBytes, notice }` ahead of `execution`, in
  structured content and in the text JSON. The 65,536-byte limit and the
  existing fields are unchanged. The output-truncation E2E covers the byte
  boundary, multibyte text, objects, logs sharing the budget, a 30,000-character
  prefix and a narrowed read.

Keep these patches separate when merging upstream changes. Remove a patch when
upstream provides the same behavior and its regression checks pass.

## Error boundary

The error-boundary patch preserves bounded, redacted thrown cause text through the
app host and SDK. MCP failures include the attempted callable operation and a
next step, including caught errors. Timeouts name each call's confirmed completion,
failure or unknown outcome and require a safe read before repeating mutations.
Expired accounts retain their trusted label and ID and name `accounts_reconnect`.
The initial execute search example uses the `executor` namespace.

The thrown-error handler is bundled into each app build. Existing builds need
recompilation against a compatible framework to receive that handler; upgrading
the server alone updates timeout, authentication and operation attribution. No
database migration is required. The production rollout rebuilt all 17 apps from
unchanged source. Fifteen retained their new deployments. Executor and Figma API
restored their previous deployments after the rebuilt bundles failed tool discovery;
their thrown-error handling remains on the previous framework pending a separate
compatibility fix. The error-boundary E2Es exercise thrown
causes, a timeout after an external mutation and refused account renewal. Existing
OpenAPI, provider, discovery, worker-lifetime and timeout scenarios cover the
shared contracts.

## Production interceptors and analytics

The maintained branch also includes the already-deployed
`feat/mcp-operation-interceptor-release` work through `fa2031490`:

- `8cd2985c0`: Promise MCP operation interceptors preserve native validation,
  selected-account isolation, fallback and transport failure classification.
  `redirect: "error"` remains supported through manual redirect handling,
  preserving existing app code and preventing redirects from being followed.
  The ClickUp app routes supported task reads through REST without caching tasks
  and retains MCP fallback for other operations.
- `b8d1ffb3e`: durable, best-effort app analytics with authorized summaries,
  bounded emissions and groups, and 30-day retention. Native MCP requests and
  intercepted host operations contribute transport and outcome measurements.

## Upstream integration on 2026-10-07

Upstream `v2` at `8853b9db4` contains 312 exported commits since the identical
`4c9392fed` baseline. That baseline has the same tree as fork `fab44e5a3`, but
upstream exported a separate Git history. An unchanged-tree merge connects the
histories before the production patches and upstream changes are merged.

Upstream replaces the pinned Effect build with Effect 4.0.1. This fork follows
that upstream version. The merge also adopts the router and account APIs, the
search/describe split, account credential generations and checks, legacy app
protocol metadata, and upstream lifecycle and discovery fixes. Fork discovery
uses authorized summaries with schemas loaded for selected tools. Search returns
input detail; `tools.search.describe({ paths })` returns complete signatures.
Newly built management apps use the nested `analytics.summary` and
`accounts.reconnect` paths. Existing builds retain their original callable paths.

Read-only authorization reads selected metadata live and binds execution to the
approved query kind. A dynamic query that becomes a mutation before execution is
refused. Complete bulk schema reads also stay live, and SDK catalog responses use
one deployment snapshot for both schemas and identity.

No fork patch is retired in this merge. The error-boundary assertions retain
redaction, callable operation attribution and reconnect identity while accepting
upstream's failure presentation. The timeout check uses upstream's five-minute
budget and still requires unknown mutation outcomes and a safe read before retry.
The worker-lifetime check also verifies expiry after five idle minutes.

The shipped fork schema 4.0.2 contains analytics. Its immutable baseline is kept.
The next migration, 4.0.3, adds upstream credential generations and account
checks, followed by additive upgrades through 4.0.6. Actual old-image upgrade
verification covers retained encrypted accounts, keys, sessions, legacy app
builds, active deployments and analytics across two candidate starts. Artificial
migration downgrades are unsupported because upstream's down steps retain added
columns. Rollback uses a stopped-volume backup and the previous immutable image.
It discards writes made after that backup.

A release requires no OOM or restart in the soak, the focused fork scenarios,
native upgrade and backup restoration, and a 15-minute production watch with one
read per connected app.

## Slack read recovery

Bounded MCP discovery now joins an index evaluation already running instead of
starting a new one after each ten-second discovery timeout. Fast completed indexes
remain live on the next read. Slow completed indexes are kept only in process
memory for at most 30 seconds after completion, without background refresh or
extending the window on access. This is a bounded-staleness exception to the
summary patch's original no-cross-request-cache policy. Deployment, profile,
account, credential and app-cache invalidation checks still apply.

The app framework includes schemas when factory evaluation or catalog discovery
is slow, using the same evaluated factory. The first dynamic catalog read is kept.
Routers with summaries and named descriptions keep the selective path; full
schemas supplied with summaries survive parsing. Slow sparse summaries obtain
schemas by name without listing the catalog again. Routers without named
schema reads are listed once with schemas. Static operations render schemas only
when the completed read requires them. Bounded search can describe selected tools
from that retained result. Existing summary-only app builds need
recompilation to provide those schemas. Ordinary SDK and HTTP index reads and
explicit live descriptions still evaluate live. Read-only grants force live
metadata; the shared grant wrapper also rechecks when its final policy newly
requires metadata.

A sparse summary response does not contain schemas to retain. Its named schema
reads still consume the 45-second evaluation lifetime; separate 25-second summary
and description reads can exhaust it. This patch avoids catalog rereads, but does
not guarantee one upstream request for sources that return only summaries.

Custom SDK declaration-cache implementations must now provide `delete` so a
fast successful retry can clear an obsolete remembered failure.

Executor's execute output budget is 65,536 bytes. A truncated result now includes
`outputRecovery` with the configured limit and instructions for upstream paging
or returning smaller slices from read-only calls. Mutation results must be
recovered through a safe read, not by repeating the mutation.

The slow-listing, dynamic-router, failure-recovery and output-recovery regressions
are in the focused fork gate.
Immediate remote-catalog freshness assertions remain unchanged. The inherited
`mcpListingInputs` scenario expects fast completed factories to be reused, which
conflicts with the live-index behavior already on `selfhost`; it fails the same
evaluation-ID assertion with the original SDK and is not added to the gate.

## Upstream integration on 2026-10-14

Upstream `v2` at `2868b6e5b` adds 241 exported commits to `8853b9db4`. The merge
keeps Effect 4.0.1 and adopts upstream's structure where it overlaps fork patches.

Upstream changes that matter here:

- Profiles are removed. Members link accounts to app requirements, and calls use
  the caller's links. App authoring moves to `user: { accounts }` and
  `app: { accounts }` (apps protocol 13). Bundles built for earlier protocols keep
  running; their requirements become user requirements.
- Storage runs 4.0.7 through 4.0.15: app events, targeted connections (4.0.8
  deletes connections without a target), tool search rows, stored OAuth clients,
  the profile conversion (4.0.13: a member's profile accounts become links, and a
  member whose profiles used different accounts for one plain requirement gets an
  "App (Profile)" copy with an empty database), app-scope schedules and webhook
  retry counts.
- MCP discovery loads apps on demand from the program's static reach, `tools.search`
  ranks stored search rows in the backend (a literal namespace reads only that
  app's rows), and listings are kept across executions. New `call`, `search` and
  `describe` MCP tools sit beside `execute`.
- Read-only grants force calls to run as queries and refuse a call that names a
  mutation, including resumed approvals.
- Self-host unloads idle app Workers after five minutes, collects each isolate's
  garbage after a call and keeps WebAssembly Liftoff code.
- Removed: stdio MCP connections.

Fork patches after this merge:

- Retained unchanged in policy: `6565a3749` drain, `e23b30dfd` `--gc-global`
  (now beside upstream's `--expose-gc` and `--no-flush-liftoff-code`), `5e21403ca`
  result envelopes, `d616eaf1b` semantic failures (also for upstream's direct `call`
  tool), `163e32725` truncation notice with the 65,536-byte limit, the error
  boundary (operation attribution now precedes upstream's `Retryable (unchanged
call)` suffix; reconnect errors name the account's label and ID, and add the
  agent reconnect step only for an account the caller linked), interceptors and
  analytics, the worker limit of 16 and `outputRecovery`. The app framework keeps
  its slow-catalog schema inclusion, and the host still accepts a full catalog in
  reply to a summary read, so bundles built by the fork framework keep working.
- MCP interceptors run as the app's code in upstream's tool-call timing.
- The 65,536-byte execute output budget is kept; upstream raised its default to
  100,000. Approval requests are bounded by the same budget, so upstream's
  approval-size and concise-search scenarios use the fork's limit.
- Local serves the analytics route again: upstream now lists the SDK groups local
  serves, which dropped it.
- `mcpDiscoverySelection` keeps every returned value and access check. Its eager
  discovery counts now assert upstream's lazy loading instead: reaching the fast
  app dynamically, listing app names, a run-time search namespace and programs
  that never run leave the unrelated app unevaluated, while searching or calling
  it, or searching every app, evaluates it.
- Live, summary-first discovery is ported onto upstream's lazy discovery and
  backend ranking. Upstream keeps listings fresh for 30 seconds, then serves them
  stale for up to a day, and its MCP search read stored rows without evaluating
  the app; that would leave remote catalog changes, removed tools and read-only
  flags stale. MCP discovery instead reads each app's index (names and
  descriptions, `ToolListOptions.live`) on every execution: a catalog that
  evaluates within discovery's wait is evaluated again every time, a slower one is
  shared while it runs and served from process memory for at most 30 seconds after
  it finishes, measured from completion, never stored or refreshed in the
  background. Remembered failures, invalidation and access checks apply as before,
  and a fast success replaces a remembered failure. Search rows are rewritten from
  that live index (an unchanged index rewrites none) before the backend ranks
  them, so stored rows never answer for a catalog that was not read. Program
  namespaces take no schemas; the app validates each call's input. Schemas are
  read live by name only for a search page, a describe, or a call that passes
  `$accounts`, at most once per tool per execution. A page that names every tool
  of a listing larger than 64 reads it whole, and falls back to names when that
  read fails. A slow index whose build answered with schemas is kept with them, so
  describing its tools within the retention reads that index instead of evaluating
  the catalog again. HTTP `tools/index` evaluates live, so upstream's
  `toolsIndexCache` scenario, which expects browsing to reuse a kept listing, fails
  by design; it is not in the focused gate. `tools.get` keeps upstream's kept
  listing, as the fork's base did.
- Read-only grants keep upstream's query binding, and both the hosted and MCP
  grant checks describe the tool live instead of reading a kept listing. MCP
  catalog reads check the grant again after the catalog returns and narrow the
  result with it, including catalogs merged across grant entries; a grant that
  newly needs metadata reads it live.
- `scopedConnectionProfiles` became upstream's `scopedConnectionAccounts`, and the
  output-truncation scenario joined the focused gate.

Storage keeps the shipped fork 4.0.2 to 4.0.6 steps byte for byte. Every later
layout carries the analytics table through `version406Tables`, and a fresh
database also builds the analytics indexes. Generated migration operations from
4.0.6 to 4.0.15 never touch `executor_analytics_events`. The previous server
refuses a database at 4.0.15, and 4.0.8 and 4.0.13 change data, so rollback is a
stopped-volume restore plus the previous image. The upgrade check seeds the
previous image through two profiles of one member with distinct accounts and
app data, and calls the candidate without a profile. It proves that the app keeps
the oldest profile's account and its data, and that the second account set
becomes the "App (Profile)" copy linking only its account. The copy starts with
an empty database and is rebuilt from source, so with the registry unreachable it
is not deployed; the report records which. Profile-targeted grants and
`.many()` unions are not covered.

## Merging upstream

Upstream's exported history and `selfhost` are now connected through the merge of
the identical `4c9392fed` baseline. Fetch `upstream/v2` and merge it into `selfhost`.
Never rebase or re-export `selfhost` after a merge, and never force-push it. Fetch,
merge anything new on `origin/selfhost`, and push as a fast-forward.

Effect follows upstream only: take the `effect` version and APIs upstream ships, and
do not pin a different build here. Keep every patch listed above. Drop one only when
upstream provides the same behavior and the scenario that guards it passes on
upstream's implementation. Resolve conflicts by keeping upstream's structure and
reapplying the patch's policy, as the October merge did for `app-worker-residency.ts`.

Verify the merged tree with one command, from a checkout with `bun install` done:

Run one release gate at a time on this host. The test containers use host networking,
and concurrent gates can collide on workerd's internal ports.

```sh
bun run selfhost:verify --evidence <new directory> \
  --previous <registry>/<repository>@sha256:<digest of the image now in production>
```

The command runs, in order: `e2e:prepare`, `check`, the focused scenarios, a
candidate image build from the checkout (or `--image <reference>` to reuse one), the
native Go tests in the Dockerfile's Go image, the persisted upgrade and drain, and
the soak. `--steps prepare,check,...` selects a subset and `--workers` bounds the E2E
workers. `--evidence` must not exist yet; logs, `summary.json` and the upgrade and
soak reports are written there with private permissions.

`summary.json` carries a top-level `status`: `incomplete` while steps run, `passed`
only after every selected step passed its validation, and `failed` on any failure,
deadline or interruption. A step is recorded after its validation, with the failure
`message` or a `note` for what it verified, so a summary that stops early is never green.
Each step has a deadline (15 minutes for `prepare` and `check`, 45 for `focused`, 30 for
`image`, 10 for `go` and `upgrade`, 25 for `soak`); `--deadline-seconds` replaces them all
for a rehearsal. A step that overruns is stopped with SIGTERM, and a helper that ignores
it is killed after 90 seconds, which covers its 60-second cleanup budget.
Removing the image the gate built and the Go container are finalizers with their own
60-second limit each; a stalled `docker` is killed with SIGKILL. A finalizer that fails or
stalls, other than a resource that is already gone, turns `status` into `failed` with
`Cleanup failed: ...` (also in `cleanup.log`) and makes the command exit non-zero even when
every step passed. `status` stays `incomplete`, and "Verified" is not printed, until the
finalizers have finished.

- The focused scenarios are listed by key in `e2e/selfhost/verify.ts`, so a renamed
  or deleted scenario fails the typecheck. Add a patch's regression there. A
  scenario must also be registered in `e2e/test-plan.ts` to execute. The step fails
  and records the count unless every selected scenario ran and passed.
- The upgrade seeds the immutable previous image with an app, an encrypted account,
  analytics and generated keys, then starts the candidate twice on that volume,
  drains an admitted 16-second write across SIGTERM, and restores a stopped-volume
  backup into the previous image. The previous image builds its app against the
  `apps` release it names from the public registry, never the checkout's staged
  archive, so the candidate runs a build made by the previous framework. The candidate
  and the restored previous image run with an unreachable registry, so they can only
  execute the stored build. `--previous-api router` (the default) seeds an app written
  with `router` and the account APIs, pinned to the `apps` version the previous host
  names (`previousAppsVersion` in the report). `--previous-api legacy` seeds the older
  `defineApp` factory with `queries` and `mutations`, for images that predate the router,
  and must seed analytics. A router seed records `analyticsSeeded: false`, asserts no
  analytics were retained, and reports "analytics retention not verified" in its checks
  and in the step note when the published `apps` release exposes no authored analytics;
  the gate never claims analytics retention it did not exercise. Containers use host
  networking.
- The soak runs 60 deployments, 200 MCP sessions and 500 searches in a 4 GiB
  container, with no inspector or manual GC, against the checkout's staged `apps`
  package served by `e2e/support/npm-registry.ts` on host loopback. It fails on a stop,
  restart or OOM, and on any wrong answer: every `initialize` must succeed and negotiate
  the requested protocol and a new session ID; every arithmetic `execute` must return
  its sum; the deployed app's tool must answer through `execute` with the last deployed
  version; every search must include exactly one `tools.soak.version` result with its
  description and one `tools.soak` namespace; every session `DELETE` must answer 200, 202, 204 or 405
  within 30 seconds. The self-host server is stateless and answers `DELETE /mcp` with 405,
  and the session stays usable; the report records the statuses in `sessionDelete`.
- Helpers decide every container and volume name before creating it (`agent-test-executor-*`
  only; any other name is refused), and remove what they own on success, failure, SIGINT,
  SIGTERM, SIGHUP and their own deadline, including a container that `docker run` created
  and then failed to start. A helper never blocks its event loop while it works: every
  docker call, including the volume backup and restore streams, is asynchronous with its own
  timeout, so the helper's deadline timer and signal handlers fire during a stalled `docker`
  and kill the call in flight. Synchronous `docker` is allowed only for cleanup, which runs
  under one 60-second budget; a call that finds the budget spent fails, the failure is
  recorded as `cleanupError` in the helper's report, and the helper still exits.
  `--deadline-seconds` on a helper overrides its 8-minute (upgrade) or 20-minute (soak)
  default. An image the command built is removed again. A helper killed with SIGKILL cannot
  clean up; the daily `agent-test-*` cleanup removes what it leaves.

The helpers are in `scripts/selfhost-verify/` because `e2e/check-boundary.ts` forbids
Node I/O and async code under `e2e/`. Machine-specific rollout is not here; it lives
in the Agents project runbook.
