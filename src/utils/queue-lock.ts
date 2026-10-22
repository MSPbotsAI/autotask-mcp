// Minimal promise-chaining async mutex, keyed by a string.
//
// Built for PRD-20620: when the agent processes several tickets "at the same
// time", each call to autotask_assign_least_loaded_resource reads open-ticket
// counts, picks the least-loaded resource, then writes the assignment back.
// Two calls for the SAME queue racing through that read-then-write sequence
// both see the pre-assignment counts and both pick the same resource — this
// lock makes the second call wait for the first to finish, so it re-reads
// counts that already include the first call's write. Calls for different
// queues never wait on each other.

export class KeyedAsyncLock {
  private tails = new Map<string, Promise<void>>();

  /**
   * Run `fn` after every previously-queued call for `key` has settled
   * (whether it resolved or rejected), and return its result/rejection.
   *
   * Synchronous ordering matters here: `tails.set` happens before any
   * `await`, so two calls issued back-to-back without awaiting in between
   * still chain correctly — the second `run()` call sees the first call's
   * tail already recorded.
   */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    // Record a tail that never rejects, so one failed call doesn't wedge the
    // lock for whatever is queued behind it on the same key.
    this.tails.set(key, result.then(() => undefined, () => undefined));
    return result;
  }
}

// Shared across all callers in this process — one lock per queueID string.
export const assignmentLock = new KeyedAsyncLock();

/**
 * Acquire more than one key on `lock` for the duration of `fn` (PRD-20620
 * code review follow-up).
 *
 * The original r2 call site locked on one combined key built from the whole
 * (status, queueIDs, technicians) tuple — so two calls whose technician
 * lists *overlap* without being identical (`[A,B]` vs `[A,B,C]`) hashed to
 * different keys and ran fully concurrently, even though both read/write
 * resource A and B's counts. That breaks AC4's "overlapping ... combination"
 * guarantee for anything short of an exact-set match.
 *
 * Locking on every `(status, resourceID)` pair in the candidate set instead
 * means any two calls sharing a status *and* at least one technician must
 * still serialize, regardless of how the rest of each call's technician
 * list or queueIDs differ. Keys are de-duplicated and sorted before nesting
 * `run` calls so that two callers requesting overlapping key sets always
 * acquire them in the same order — the classic fixed lock-ordering rule to
 * avoid an A-waits-for-B / B-waits-for-A deadlock.
 */
export function runWithKeys<T>(lock: KeyedAsyncLock, keys: string[], fn: () => Promise<T>): Promise<T> {
  const unique = Array.from(new Set(keys)).sort();
  const run = (index: number): Promise<T> =>
    index >= unique.length ? fn() : lock.run(unique[index], () => run(index + 1));
  return run(0);
}
