# Module docs index

Maps a code path / product area in this repo to the module doc that records accumulated, hard-won facts about it (why it's built that way, what constraints apply, what the next change needs to know). See `docs/tickets/` for per-ticket design/self-test records; this index is for facts that outlive any single ticket.

| Code path / area | Module doc |
| `src/handlers/tool.handler.ts` ticket-assignment dispatch entries, `src/services/autotask.service.ts` eligibility/counting queries, `src/utils/queue-lock.ts` | `ticket-assignment.md` |

Entries get appended here as tickets touch new areas worth tracking this way — see `docs/tickets/PRD-20620.md` Handoff section for the first entry.
