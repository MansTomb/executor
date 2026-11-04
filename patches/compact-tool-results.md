# Compact MCP results, November 1, 2026

Executor and Funnel now deliver one result representation. Default discovery and
inbox reads return compact pages, with complete data available through the same
tools and Funnel's existing temporary payload files.

The behavior commits are Executor `c6bf71038fb91bb1171f2651d5bc82d9387e0553` on
`selfhost` and Funnel `3406c3bd4fc70f97895bb96ded737fbfb5c0f9e8` on `main`.
Sol approved both changes in two rounds on `gpt-6.1-sol`, high effort, default
tier. The second round resolved one broken describe consumer and strengthened
preservation and reconstruction checks. Review usage was not exposed.

## Measurements

The baseline is October 25 10:00 UTC to November 1 10:00 UTC. The scan uses
`session-metrics`' native log parser and deduplicates results by call, time and
fingerprint. It reproduces 1,015 clipped Codex results out of 6,812, or 149 per
1,000. Results containing Executor calls include search 20/55, describe 11/18,
call 17/82 and execute 14/54. Batched calls overlap these groups, so their
clipping cannot be attributed to one nested operation.

953 clipped calls included shell tools and no Executor call, 47 included both,
six included Executor without shell tools, and nine were in other calls. Most
of the historical clipping therefore remains outside these two repositories.

These deployed measurements use the same call inputs before and after. Sizes
are the complete MCP envelope encoded as UTF-8 JSON, including repeated text in
the old result. Smaller defaults intentionally return a first page.

| Call | Before bytes | Deployed bytes | Reduction |
| --- | ---: | ---: | ---: |
| Funnel get, item 5129 | 121,106 | 1,578 | 98.7% |
| Describe, three exact paths | 63,284 | 2,644 | 95.8% |
| Funnel list, personal | 43,596 | 7,059 | 83.8% |
| Funnel summary, personal | 23,586 | 4,244 | 82.0% |
| Search, clickup/task | 10,854 | 3,049 | 71.9% |

The old summary and list returned 27 items. The new responses returned 20 and
19, respectively, with continuation cursors. Search defaults changed from ten
to five matches. Describe exposes a continuation after 2,000 Unicode
characters, rather than cutting a whole signature at the harness boundary.

A fresh Codex session before deployment made one describe call and produced one
native clip, reporting 15,821 original tokens. Its surviving envelope cannot be
parsed. A fresh session after deployment made the identical call and produced
zero native clips. Its complete 2,644-byte envelope parses and includes `next`.
The after session's final text called the bounded signature a clip; the native
transport record distinguishes deliberate paging from a clipping warning.
This is a controlled comparison, not a measured reduction in the weekly rate.

The existing metrics parser marks structured-only text sizes as unknown.
Independent byte measurement and parsing of the native record verify the after
result's actual size. No metrics or agent configuration was changed.

## Delivered behavior

Modern MCP revisions carry structured content and an empty content array. Older
revisions carry one JSON text result. Executor removes embedded plain text
blocks only when they repeat the structured value. Distinct text, media,
annotations, metadata and errors remain. Programs inside execute receive the
original app results. Direct calls compact before applying their output budget.

Search keeps 600 characters of input detail and defaults to five matches.
Describe callers follow `next` and concatenate description and signature fields
by path. The app-management consumer now follows this contract too.

Funnel list defaults to 20 previews. Summary returns up to 20 recent item
previews. Get defaults to ten event previews without payloads and supports
`cursor`, `limit` and `payloads: true`. Full pages above 8,000 bytes use the
existing seven-day temporary JSON file mechanism. No service, result store or
database migration was added. A production full read recovered both original
event payloads, 22,934 characters, with matching before/after fingerprints.

## Verification and deployment

Executor passed format, lint and typecheck through `bun run check`. Preparation
used the repository's Bun 1.4.4. The affected scenarios passed in
`mcp-direct-calls`, `mcp-result-contract`, `mcp-search-concise`,
`mcp-discovery-schemas`, `mcp-output-truncation`, `mcp-protocol-versions` and
`app-management-contracts`. The new assertions fail against the duplicate
representation. Reconstruction asserts the complete 4,841-character record
signature and 5,653-character enum signature, including every variant.

Funnel passed `bun run verify`: 89 tests, 555 assertions and the separate T3
watcher checks. Coverage includes legacy revisions, bounded inbox pages, every
item and event across cursors, Unicode fields, exact payload recovery, and
large-page file retrieval.

The built image passed native Go tests, upgrade from the exact previous image,
a 16-second admitted-write drain, backup restoration, and a soak with 60 app
deployments, 200 MCP sessions and 500 searches. The final reviewed image repeated
the upgrade and soak. The upgrade helper reports analytics retention unverified
because the previous published framework exposes no authored analytics.

The November 1 rollout deployed image
`registry.iwannalocal.duckdns.org/dokploy/executor@sha256:9002bd113dc9ad6a36d1604f4e13f1ae2d531014d0c72d68d5a8e0bfb1f045a2`.
Its previous image was
`registry.iwannalocal.duckdns.org/dokploy/executor@sha256:4a806bef79f2b425a0fd0e3d6ed43bb6beb7ac34f638befac9d9ba108e57640d`.
Dokploy deployment `iyPiFNSggB2gTPE_wpMeL` completed. Only the Compose image
reference changed; private fetching, the volume and other settings were kept.
Docker, Traefik and Dokploy were not restarted.

The stopped-volume backups were read back and their product databases,
`encryption.key` and `auth-secret.key` verified:

| Backup under rustfs:backups/compose-parse-online-port-xjtnok_executor/ | SHA-256 |
| --- | --- |
| compose-parse-online-port-xjtnok_executor-v2-data-2026-11-01T11-12-34-422Z.tar | 6a963ea76173332e87a19ee359b229bf90896743abe74dc8ae01852201dac862 |
| compose-parse-online-port-xjtnok_executor-v2-data-2026-11-01T11-16-34-496Z.tar | 888020099bd76cd3efc4cf7674e1b8078d4dd8a8a3ffc7e9c34e156ed4c063aa |

Funnel deployment `P7vYJkvxAUvb8F41es-3G` completed for its exact commit and
returned healthy. The management app advanced from
`dpl_5b95272a-40a3-498a-97c7-e1f54e5740d4` to
`dpl_5671f9e3-67ec-480d-ad37-c115938c5bc9`. Its deployed files and workspace
match the current generator, its account links match, and all 105 callable
OpenAPI operations appear in its catalog. Browser-only and streaming routes
are excluded as intended. The executor and code-mode skills advertise the
new continuation contract.

All 15 connected apps with usable read tools passed before and after.
Cloudflare's catalog still returns its pre-existing 409 account refusal.
Slack Files has no read tool and passed catalog discovery. Stake Engine has no
active deployment. The 15-minute watch passed all 91 samples for both health
endpoints. Executor retained the same container with zero restarts and no OOM.
Working memory peaked at 1.29 GiB and ended at 1.24 GiB.

## Proposals outside this change

- Apply single-representation delivery to T3's MCP tools and compact the combined
  native command/read output in the Codex harness. Preserve full command output
  behind a continuation in existing run artifacts. Adding that result retention
  needs separate authorization. Increasing context limits or repeating narrow-read
  instructions would not repair the dominant call shape.
- Let the Pi Funnel inbox wrapper forward `payloads`, `cursor` and `limit` for get.
  Its current numeric get form returns the new previews. The raw MCP get tool
  already exposes full reads and paging.
- Count structured-only results once in session-metrics, instead of recording
  their text size as unknown. Keep native clipping warnings separate from
  server-provided pagination.

No agent kit, Codex configuration or T3 source was changed.

## Friction

Missing upstream notes and a workspace check aimed at the older main branch
misdirected setup. Bun 1.4.3 failed the collector build before using pinned
1.4.4. Funnel's test server registers MCP separately from its entrypoint.
Tightening explicit search pages caused extra schema reads and test churn, so
the existing explicit-page budget was restored while defaults stayed compact.
Broad instruction and native-record reads clipped in this task too. The
stopped-volume backup dropped its own Executor MCP response; the independent
Dokploy API verified completion. A clearer result-size contract, current fork
instructions and direct deployment access would have shortened that path.


The November 4 weekly rollout superseded this image with source `285a173d0`
and immutable image
`sha256:6100bdd30305d43a2ed6b4dc71351167107d06ebbc84c43057ed07dc4d5c4b7b`.
The compact-result patch is unchanged. See `FORK.md` for the current deployment
and schema rollback requirement.
