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

Keep these patches separate when merging upstream changes. Remove a patch when
upstream provides the same behavior and its regression checks pass.
