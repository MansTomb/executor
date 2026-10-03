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
  programs and unscoped tool searches retain full discovery and live authorization.
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

Keep these patches separate when merging upstream changes. Remove a patch when
upstream provides the same behavior and its regression checks pass.
