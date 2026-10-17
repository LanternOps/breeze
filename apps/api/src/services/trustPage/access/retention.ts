// Owner: W02d (access-request retention: requester PII 365 days after the last state change, tokens 30 days
// after expiry — Open Decision 8). W02a stub — W02d replaces the body, keeping this signature. Called by the
// hourly trust-page sweep (jobs/trustPageSnapshotWorker.ts) in its own try/catch.
export async function pruneTrustAccessData(_now: Date): Promise<{ tokens: number; requests: number }> {
  return { tokens: 0, requests: 0 };
}
