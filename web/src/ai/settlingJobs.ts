/**
 * Batch jobs of an old Gemini key being collected or let go for books that were not open when the key
 * changed (`releaseJobsOfOldKey`). A book opened in those seconds leaves them alone (asking with the new
 * key would mark finished, paid pages failed) and, once one is settled, takes the saved outcome instead
 * of writing its own stale "waiting" copy over it (audit final F-2). Only job names are held here.
 */
const settling = new Set<string>()
const listeners = new Set<(job: string) => void>()

export function isSettlingElsewhere(job: string): boolean {
  return settling.has(job)
}

export function startSettling(jobs: Iterable<string>): void {
  for (const job of jobs) settling.add(job)
}

/** The job's outcome is saved: stores that hold its pages reload them. */
export function finishSettling(job: string): void {
  if (!settling.delete(job)) return
  for (const listener of listeners) listener(job)
}

export function onJobSettled(listener: (job: string) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
