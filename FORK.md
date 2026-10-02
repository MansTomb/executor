# Self-host reliability patches

This fork starts from `executor@2.0.0-beta.4`. The upstream remote is
`https://github.com/usefulsoftwareco/executor.git`; v2 development is on `v2`.
Upstream `main` currently contains the older 1.x architecture.

The maintained branch is `selfhost`. Local patches:

- `433ab7f6f`, `c77c0baec`: retain up to 16 idle app workers for five minutes.
  Evict idle workers under capacity pressure, preserve active calls, and dispose
  forwarded RPC results. Named dynamic workers in workerd 1.20260901.1 otherwise
  survive indefinitely. Declaration checks use uncached workers.
- `37facaf6c`: discover only statically referenced app namespaces. Dynamic
  programs and tool searches retain full discovery and live authorization.
- `6565a3749`: drain admitted HTTP requests before stopping workerd. Close the
  listener during shutdown and allow 40 seconds for a 35-second drain deadline.
- `e23b30dfd`: use `--gc-global` in the packaged self-host runtime. Default GC
  allowed collectible worker and buffer memory to exceed a 4 GiB container even
  after worker eviction was fixed. More frequent major collections passed the
  same workload without reducing the per-isolate heap ceiling. This trades CPU
  and occasional collection pauses for lower memory use.
- Discovery performance patch: MCP loads authorized tool summaries first and
  reads schemas only for the selected search results, grouped by deployment and
  profile. SDK filtered listing uses existing runtime inspection capabilities;
  older app builds retain their full-list fallback. Dynamic tool authors can
  provide Promise-based `summaries` and `describe` callbacks. Filtered runtime
  inspection limits concurrent descriptions to eight.
  Complete catalogs above 64 tools use bulk listing. An app evaluation failure
  on that bulk path falls back to filtered inspection; authorization, deployment
  and profile failures propagate. Every stage retains live authorization.
  No evaluated app catalog or authorization result is cached across requests,
  and existing spec-cache freshness and invalidation stay unchanged.

The discovery comparison uses the pinned `b8f5b3cb` image and a candidate built
from that image on the same host, with a 4 GiB limit. Four synthetic live OpenAPI
apps expose 1,000 tools each, alongside the management app. Broad search returning
ten signatures improved from 3.067/3.737 seconds p50/p95 to 0.955/1.030 seconds
over 20 warm requests per image. All returned paths, signatures, pagination and
availability results matched. These are local measurements, not production
latencies. Source compilation on an empty cache is measured separately from a
process restart with retained spec data.

Direct calls into one 1,000-tool app improved from 1.095/1.317 seconds p50/p95 to
0.258/0.393 seconds over 20 warm requests. Three first calls after a fresh process,
deployment and source cache took 3.457 to 5.077 seconds before and 2.319 to 2.405 seconds
after. Broad search after process restart with retained spec data took
3.939 to 6.019 seconds before and 1.992 to 2.025 seconds after. Three broad searches with
all four source caches empty in a running process took 10.230 to 17.007 seconds
before and 8.666 to 9.317 seconds after. These three-sample ranges do not establish
a cold p95. Every direct call returned the expected value and made one upstream
API request.

Exporting all 4,090 signatures still costs more than the baseline because it
reads summaries before full metadata. One candidate request took 4.616 seconds,
compared with the baseline's 3.400-second median over 20 warm requests. The
candidate stayed below its 4 GiB limit throughout the measurements, with no OOM
events or automatic restarts.

The E2E scenario `MCP discovery loads selected search schemas and refreshes live
catalogs` fails with eager discovery and passes with the patch. It checks precise
signatures, pagination, live metadata changes, input rejection, and fallback when
bulk metadata is unavailable. The grant restriction scenario also checks search
before and after live narrowing.

Keep these patches separate when merging upstream changes. Remove a patch when
upstream provides the same behavior and its regression checks pass.
