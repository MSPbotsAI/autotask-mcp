// In-memory "just assigned, might not be visible to Autotask's own query
// yet" bookkeeping for autotask_assign_least_loaded_resource (PRD-20620 code
// review follow-up, Kaka Zhang's MUST FIX).
//
// The tool counts load via `countMatchingTicketsByResource(status, ...)` —
// a live Autotask query filtered on the caller-supplied `status`. The lock
// in queue-lock.ts correctly serializes two calls that are racing on the
// SAME read-then-write window (AC4), but it does nothing for the next call
// that arrives *after* the lock is released: that call re-reads Autotask,
// and if the just-assigned ticket's `status` field does not (yet, or ever)
// equal the caller's filter value, it will not be counted — the technician
// looks exactly as unloaded as before the assignment, and a second call
// picks them again. tool.handler.ts now defaults a *created* ticket's own
// `status` to the filter value so that half of the gap closes immediately
// and permanently (see "PRD-20620" comment at the createTicket payload
// site); this store is the remaining safety net for the window where that
// still is not true — a caller-supplied `createTicket.status` that
// deliberately differs from the filter, or a *reassigned* existing ticket
// whose own status does not already match the filter the caller is
// counting under.
//
// Deliberately simple: keyed by (status, resourceID) only, NOT queueIDs.
// Knowing which queue a reservation "belongs to" would need either an extra
// Autotask lookup (reassignment path) or trusting caller input we have no
// way to verify — and the failure direction of ignoring queueIDs here is
// safe: a technician can be treated as reserved for a call whose queueIDs
// filter would not actually have included this ticket, which makes that
// technician look *more* loaded than they truly are for that specific call.
// That nudges the pick toward spreading load further, never toward piling
// more onto one person — the opposite of the bug this store exists to
// close. Entries expire after `ttlMs` so this conservative bias is bounded
// in time, not permanent.
export class AssignmentReservationStore {
  private entries = new Map<string, number[]>(); // key -> array of expiresAt (ms epoch)

  constructor(private readonly ttlMs: number = 2 * 60 * 1000) {}

  private key(status: number, resourceID: number): string {
    return `${status}:${resourceID}`;
  }

  private prune(key: string, now: number): number[] {
    const list = (this.entries.get(key) ?? []).filter(expiresAt => expiresAt > now);
    if (list.length > 0) {
      this.entries.set(key, list);
    } else {
      this.entries.delete(key);
    }
    return list;
  }

  /** Record one just-made assignment toward `resourceID` under `status`. */
  add(status: number, resourceID: number): void {
    const now = Date.now();
    const key = this.key(status, resourceID);
    const list = this.prune(key, now);
    list.push(now + this.ttlMs);
    this.entries.set(key, list);
  }

  /** Count of not-yet-expired reservations for `resourceID` under `status`. */
  countFor(status: number, resourceID: number): number {
    return this.prune(this.key(status, resourceID), Date.now()).length;
  }

  /** Test-only escape hatch: drop all reservations regardless of TTL. */
  clear(): void {
    this.entries.clear();
  }
}

// Shared across all callers in this process, same lifetime/scope rationale
// as `assignmentLock` in queue-lock.ts.
export const assignmentReservations = new AssignmentReservationStore();
