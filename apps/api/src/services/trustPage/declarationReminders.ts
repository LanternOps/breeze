// Owner: W02b (30-day declaration expiry reminders, spec §18.2). W02a stub — W02b replaces the body, keeping
// this signature. Called by the hourly trust-page sweep (jobs/trustPageSnapshotWorker.ts) in its own try/catch,
// OUTSIDE any db context: the implementation owns its own `runOutsideDbContext(() => withSystemDbAccessContext(...))`
// (refreshPublishedPage precedent), or its writes match zero rows under forced RLS.
export async function runDeclarationReminders(_now: Date): Promise<{ reminded: number }> {
  return { reminded: 0 };
}
