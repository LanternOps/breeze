/** AI Suggested Fixes W2 — pure grouping + research state for the panel. */
export interface TrackRecordLite {
  memoryId: string; scope: 'all_clients' | 'this_client'; fixKind: string; scriptName: string | null;
  builtinAction: string | null; instructionsTitle: string | null; attempts: number; verified: number;
  successRate: number; lastVerifiedAt: string | null; status: string;
}
export interface ResearchStatusDto { runId: string; depth: 'quick' | 'deep'; status: string; errorCode: string | null; noSafeFix: boolean; finishedAt: string | null }
export interface GroupedSuggestions<R> { proven: R[]; provenRecordsOnly: TrackRecordLite[]; ai: R[]; similar: TrackRecordLite[]; legacy: R[] }
export type ResearchPanelState =
  | { kind: 'idle' } | { kind: 'running'; depth: 'quick' | 'deep' } | { kind: 'failed'; errorCode: string | null }
  | { kind: 'no_safe_fix' } | { kind: 'done' } | { kind: 'credits'; message: string } | { kind: 'denied'; code: string; message: string };

/**
 * Denials that mean "out of AI budget" (shown with a link to the usage page). Includes the
 * agent-run skip codes quick-research admission can return besides the cost-tracker reasons.
 */
export const CREDIT_DENIALS: ReadonlySet<string> = new Set([
  'credits_exhausted', 'daily_budget', 'monthly_budget',
  'compute_credits_exhausted', 'agent_daily_budget_exceeded', 'org_budget_exceeded',
]);
const ACTIVE = new Set(['queued', 'running', 'awaiting_approval']);
const FAILED = new Set(['failed', 'cancelled', 'expired', 'skipped']);

export function isActiveResearch(status: string | undefined | null): boolean {
  return status != null && ACTIVE.has(status);
}

function memoryIdOf(evidence: unknown): string | null {
  const id = evidence && typeof evidence === 'object' ? (evidence as Record<string, unknown>).memoryId : null;
  return typeof id === 'string' ? id : null;
}

export function groupSuggestions<R extends { origin?: string | null; evidence?: unknown }>(
  rows: readonly R[],
  memory: { proven: TrackRecordLite[]; similar: TrackRecordLite[] },
): GroupedSuggestions<R> {
  const proven = rows.filter((r) => r.origin === 'memory');
  const attached = new Set(proven.map((r) => memoryIdOf(r.evidence)).filter((id): id is string => id !== null));
  return {
    proven,
    provenRecordsOnly: memory.proven.filter((m) => !attached.has(m.memoryId)),
    ai: rows.filter((r) => r.origin === 'ai_research'),
    similar: memory.similar,
    legacy: rows.filter((r) => r.origin !== 'memory' && r.origin !== 'ai_research'),
  };
}

export function researchPanelState(status: ResearchStatusDto | null, denial: { code: string; message: string } | null): ResearchPanelState {
  if (denial) return CREDIT_DENIALS.has(denial.code) ? { kind: 'credits', message: denial.message } : { kind: 'denied', code: denial.code, message: denial.message };
  if (!status) return { kind: 'idle' };
  if (ACTIVE.has(status.status)) return { kind: 'running', depth: status.depth };
  if (FAILED.has(status.status)) return { kind: 'failed', errorCode: status.errorCode };
  return status.noSafeFix ? { kind: 'no_safe_fix' } : { kind: 'done' };
}

export function trackRecordText(r: Pick<TrackRecordLite, 'verified' | 'attempts' | 'scope' | 'lastVerifiedAt'>, now: Date = new Date()) {
  const days = r.lastVerifiedAt ? Math.floor((now.getTime() - new Date(r.lastVerifiedAt).getTime()) / 86_400_000) : null;
  return { worked: `${r.verified}/${r.attempts}`, scope: r.scope, lastVerifiedDays: days };
}
