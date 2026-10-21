# Tickets index

One row per `docs/tickets/PRD-XXXXX.md`, tracking whether it's still open on its work branch or frozen after merge/release. First populated by PRD-20620 (2026-10-21) — PRD-20217 added retroactively since it already existed in this repo.

| Ticket | Status | Work branch | Notes |
| PRD-20217 | frozen @ 5c34372 | `dev01.mbagent/PRD-20217` | English doc only (`PRD-20217.md`) — predates the 2026-10-08 dual-language rule, not backfilled retroactively |
| PRD-20620 | frozen @ 43c0078 | `dev01.mbagent/PRD-20620` | `autotask_assign_least_loaded_resource`; r2 rework superseded round 1's `PRD-20620.md` with `PRD-20620-r2.md` (breaking contract change); see `docs/modules/ticket-assignment.md` |
| PRD-20317 | in progress (r2) | `dev01.mbagent/PRD-20317` | `autotask_search_contacts` `includeUserDefinedFields`; r1 (`PRD-20317.md`, frozen @ b1b9b6a) shipped an `IncludeFields` superset that Autotask rejects live with HTTP 500; r2 (`PRD-20317-r2.md`) removes it, fixes the test mock to match real behavior, carries an open TC3 question for the reporter; see `docs/modules/compact-response-fields.md` |
