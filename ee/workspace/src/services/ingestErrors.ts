// Ingest error taxonomy (W3). Two classes of per-file failure during a content
// ingest run:
//
//  - TRANSIENT: the source is likely down (SMB read refused, embedder rate-limit
//    or non-200). Retrying the same file later is the right move, so the runner
//    must NOT persist a failed/blocked row (which would park the file outside
//    the pending set) — it aborts the remaining batch and leaves the file fully
//    pending. Marked by the `transient` brand so it survives being re-thrown /
//    wrapped across module boundaries.
//
//  - PERMANENT (everything else, i.e. any plain Error): the file itself is bad
//    (extraction/parse failure). The runner records a `failed` row + snapshot so
//    the file is skipped-not-retried and one broken file cannot wedge the loop.
export class TransientIngestError extends Error {
  readonly transient = true as const;
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = 'TransientIngestError';
  }
}

export function isTransientIngestError(e: unknown): e is TransientIngestError {
  return e instanceof Error && (e as { transient?: boolean }).transient === true;
}
