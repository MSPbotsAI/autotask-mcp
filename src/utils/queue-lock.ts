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
