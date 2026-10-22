# Compact-response opt-in fields and Autotask's `IncludeFields` trap

Code path / area: `src/utils/response.formatter.ts` (`pickSummaryFields`, `formatCompactResponse`, `extraFields`); `src/handlers/tool.handler.ts` (shared `COMPACT_SEARCH_TOOLS` call site, and any per-tool handler branch that wants to expose an extra, normally-hidden field on its compact response).

## PRD-20317 · 2026-10-21 (rework, r2)

**Fact 1 — opt-in extra fields on a compact response belong entirely at the formatter layer, not the Autotask query layer.** `pickSummaryFields(item, entityType, extraFields)` (`src/utils/response.formatter.ts:39-78`, not yet on `main` as of this writing — see sha note below) copies any field named in `extraFields` from the *raw* item onto the compact item, in addition to the entity's fixed `SUMMARY_FIELDS` allowlist. The raw item passed in already has every field Autotask returned for that query — Autotask includes everything (including rarely-used fields like `userDefinedFields`) by default whenever a query sends **no** `IncludeFields` at all. The formatter's `extraFields` allowlist is what keeps the *compact* response small; it is not, and does not need to be, backed by a narrower Autotask-side request.

**Fact 2 — Autotask's `IncludeFields` query parameter rejects `userDefinedFields` as a value.** Confirmed live against a real Autotask instance: QA comment `90170265051691` (Minnie Zhou, 2026-10-21, INT `autotask-mcp main@29d71f7`) — a query with `IncludeFields` containing `'userDefinedFields'` returns HTTP 500 `Unable to find userDefinedFields in the Contact Entity`. This held for the `Contacts` entity specifically; it was not tested against other entities with UDFs (`Companies`, `Tickets`, etc.) and should not be assumed safe there without its own live check.

**Consequence for future tickets**: if another `COMPACT_SEARCH_TOOLS` entity (tickets, companies, projects, tasks, resources, billing items, time entries) needs an opt-in extra field on its compact response, follow the `extraFields` threading pattern only (handler strips the flag from args → calls the service with no `includeFields` override → the shared compact-response call site computes `extraFields` from the flag and passes it to `formatCompactResponse`). Do **not** also try to force-include the field via the Autotask query's `IncludeFields` parameter unless that specific field name's acceptance by `IncludeFields` has been confirmed live for that specific entity — r1 of this same ticket (`83091b7`) made exactly that mistake for `userDefinedFields`/`Contacts` and it reached INT before being caught.

### `path:line` citations

(As of commit `9577159` on `dev01.mbagent/PRD-20317` — **not yet merged to `main`** at the time this was written; re-verify against `main` once this round lands, per the usual caveat that `docs/` entries can go stale.)

- `src/utils/response.formatter.ts:39-78` — `pickSummaryFields`, `extraFields` handling.
- `src/handlers/tool.handler.ts:904-915` — `autotask_search_contacts` handler (post-r2-fix: never sets `includeFields`).
- `src/handlers/tool.handler.ts:1780-1796` — shared compact-response call site; `extraFields` computed from `args.includeUserDefinedFields`, `undefined` for every other `COMPACT_SEARCH_TOOLS` entry.
- `src/services/autotask-http.ts:301-302` — error message shape (`Autotask {method} {path} failed: HTTP {status}: {detail}`) that produced the exact text QA quoted.
