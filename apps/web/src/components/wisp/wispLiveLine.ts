// Wisp W06 (web) Task 14: the live "Checking Greenwood…" line (w00 A31,
// `currentActivity(grantId)` → `{ orgId, orgName, startedAt } | null`).
// Read tolerantly from the thread payload's `data.currentActivity`: a payload
// without it (older API) shows no line rather than a wrong one.

export type CurrentActivity = { orgId: string | null; orgName: string | null; startedAt: string };

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export function currentActivityFromThread(body: unknown): CurrentActivity | null {
  const data = (body as { data?: Record<string, unknown> } | null)?.data;
  const raw = data?.currentActivity as Record<string, unknown> | null | undefined;
  if (!raw || typeof raw !== 'object') return null;
  const startedAt = str(raw.startedAt);
  if (!startedAt) return null;
  return { orgId: str(raw.orgId), orgName: str(raw.orgName), startedAt };
}
