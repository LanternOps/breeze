import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rows, inserted, updated, generateReportMock, resolveLiveMock, preflightMock, generateManagedEvidenceMock, baselineMock, managedTypes } = vi.hoisted(() => ({
  rows: [] as unknown[], inserted: [] as unknown[], updated: [] as unknown[],
  generateReportMock: vi.fn(), resolveLiveMock: vi.fn(), preflightMock: vi.fn(),
  generateManagedEvidenceMock: vi.fn(), baselineMock: vi.fn(),
  // The real registry is empty in W01; the managed branch is proven against a
  // stand-in type that W02 makes real.
  managedTypes: new Set(['threat_detection_review']),
}));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit', 'orderBy', 'update', 'insert', 'returning']) chain[m] = vi.fn(() => chain);
  chain.values = vi.fn((v: unknown) => { inserted.push(v); return chain; });
  chain.set = vi.fn((v: unknown) => { updated.push(v); return chain; });
  chain.transaction = vi.fn(async (run: (tx: unknown) => unknown) => run(chain));
  (chain as { then: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve(rows.shift() ?? []).then(r);
  return { db: chain, runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn() };
});
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./reportGenerationService', () => ({
  generateReport: generateReportMock, assertReportExecutionPreflight: preflightMock,
  generateManagedEvidenceReport: generateManagedEvidenceMock,
}));
vi.mock('./evidenceBaseline', () => ({ previousOccurrenceBaselineFor: baselineMock }));
vi.mock('./managedEvidenceRegistry', () => ({ isManagedEvidenceType: (v: string) => managedTypes.has(v) }));
vi.mock('./siteScope', async (orig) => ({ ...(await orig<typeof import('./siteScope')>()), resolveLiveReportAuthority: resolveLiveMock }));

import {
  AUTO_EVIDENCE_REFUSAL_NOTES, AUTO_EVIDENCE_TICKET_NOTE, generateAutoEvidenceForDeliverable, generateAutoEvidenceForOccurrence,
} from './deliverableAutoEvidence';
import { siteScopeFingerprint } from './siteScope';

// A persisted definition as the report routes write it: complete, with a
// fingerprint that matches its scope (decodeSiteScope verifies it).
const DEF = { id: 'r1', orgId: 'org1', type: 'vulnerability_summary', config: {}, name: 'Vulnerability summary',
  executionScopePrincipalKind: 'user', executionScopeUserId: 'u1',
  executionScopeVersion: 1, executionScopeKind: 'unrestricted', executionScopeSiteIds: null,
  executionScopeFingerprint: siteScopeFingerprint({ version: 1, kind: 'unrestricted', orgId: 'org1' }),
  executionScopeCapturedAt: new Date('2026-10-01T00:00:00Z') };
const ARGS = { orgId: 'org1', occurrenceId: 'o1', ticketId: 't1', reportId: 'r1', dueAt: '2026-10-31', today: '2026-10-31',
  deliverableId: 'd1', periodStart: '2026-10-01', periodEnd: '2026-10-31', lastRefusal: null };
const internalComments = () => inserted.filter((r) => (r as { commentType?: string }).commentType === 'internal');
// #5784: a refusal now posts ONE internal note, so "nothing inserted" means no run row and no evidence row.
const nonCommentInserts = () => inserted.filter((r) => (r as { commentType?: string }).commentType !== 'internal');
const LIVE = { ok: true, authority: { principalKind: 'user', principalUserId: 'u1', capturedAt: new Date(),
  fingerprint: 'f', scope: { version: 1, kind: 'unrestricted', orgId: 'org1' } } };

describe('generateAutoEvidenceForOccurrence (spec D12)', () => {
  beforeEach(() => { rows.length = 0; inserted.length = 0; updated.length = 0; vi.clearAllMocks(); });

  it('does nothing before the due date', async () => {
    expect(await generateAutoEvidenceForOccurrence({ ...ARGS, today: '2026-10-30' })).toEqual({ ok: false, reason: 'not_due' });
    expect(generateReportMock).not.toHaveBeenCalled();
  });

  it('never generates twice for the same occurrence', async () => {
    rows.push([{ id: 'e1' }]);
    expect(await generateAutoEvidenceForOccurrence(ARGS)).toEqual({ ok: false, reason: 'already_attached' });
    expect(generateReportMock).not.toHaveBeenCalled();
  });

  it('refuses a definition of another org', async () => {
    rows.push([], []);
    expect(await generateAutoEvidenceForOccurrence(ARGS)).toEqual({ ok: false, reason: 'definition_not_found' });
  });

  it('stamps the run requested_by_kind=system with BOTH requester ids null, attaches evidence and an internal note', async () => {
    rows.push([], [DEF]);
    resolveLiveMock.mockResolvedValue(LIVE);
    baselineMock.mockResolvedValue(undefined);
    rows.push([{ id: 'run1' }]);
    generateReportMock.mockResolvedValue({ rows: [{ a: 1 }], rowCount: 1, summary: {} });
    rows.push([], [{ id: 'e1' }], []);
    expect(await generateAutoEvidenceForOccurrence(ARGS)).toEqual({ ok: true, reportRunId: 'run1' });
    expect(resolveLiveMock).toHaveBeenCalledWith('u1', 'org1', 'read');
    expect(inserted[0]).toMatchObject({ reportId: 'r1', status: 'running', requestedByKind: 'system', requestedByUserId: null, requestedByPortalUserId: null,
      // execution scope records whose scope actually ran: the owner's live, intersected scope
      executionScopePrincipalKind: 'user', executionScopeUserId: 'u1' });
    // The authority handed to the generator is the reauthorized USER authority — no system arm invented.
    expect(generateReportMock.mock.calls[0]![3]).toMatchObject({ principalKind: 'user', principalUserId: 'u1' });
    expect(updated.at(-1)).toMatchObject({ status: 'completed', rowCount: 1, outputUrl: '/api/reports/runs/run1/download' });
    expect(inserted[1]).toMatchObject({ orgId: 'org1', occurrenceId: 'o1', kind: 'report_run', reportId: 'r1', reportRunId: 'run1', createdByUserId: null });
    expect(inserted[2]).toMatchObject({ ticketId: 't1', commentType: 'internal', isPublic: false, content: AUTO_EVIDENCE_TICKET_NOTE,
      userId: null, originPrincipalKind: 'system' });
    expect(AUTO_EVIDENCE_TICKET_NOTE).toBe('Report attached, review and resolve');
  });

  it('refuses a system-principal definition instead of inventing a principal', async () => {
    rows.push([], [{ ...DEF, executionScopePrincipalKind: 'system', executionScopeUserId: null }]);
    expect(await generateAutoEvidenceForOccurrence(ARGS)).toEqual({ ok: false, reason: 'system_principal_definition' });
    expect(generateReportMock).not.toHaveBeenCalled();
    expect(resolveLiveMock).not.toHaveBeenCalled();
  });

  it('refuses a portal-user-principal definition', async () => {
    rows.push([], [{ ...DEF, executionScopePrincipalKind: 'portal_user' }]);
    expect(await generateAutoEvidenceForOccurrence(ARGS)).toEqual({ ok: false, reason: 'portal_user_principal_definition' });
  });

  it('refuses when the owning user no longer holds the scope', async () => {
    rows.push([], [DEF]);
    resolveLiveMock.mockResolvedValue({ ok: false, reason: 'permission_removed' });
    expect(await generateAutoEvidenceForOccurrence(ARGS)).toEqual({ ok: false, reason: 'scope_unverifiable' });
    expect(nonCommentInserts()).toHaveLength(0);
    expect(internalComments()).toHaveLength(1);
  });

  it('refuses when the preflight rejects the config against the authority', async () => {
    rows.push([], [DEF]);
    resolveLiveMock.mockResolvedValue(LIVE);
    preflightMock.mockImplementationOnce(() => { throw new Error('outside'); });
    expect(await generateAutoEvidenceForOccurrence(ARGS)).toEqual({ ok: false, reason: 'scope_unverifiable' });
    expect(nonCommentInserts()).toHaveLength(0);
  });

  it('refuses when the persisted site scope and the owner\'s live site scope no longer overlap', async () => {
    const siteA = '11111111-1111-4111-8111-111111111111';
    const siteB = '22222222-2222-4222-8222-222222222222';
    rows.push([], [{ ...DEF, executionScopeKind: 'restricted', executionScopeSiteIds: [siteA],
      executionScopeFingerprint: siteScopeFingerprint({ version: 1, kind: 'restricted', orgId: 'org1', siteIds: [siteA] }) }]);
    resolveLiveMock.mockResolvedValue({ ok: true, authority: { ...LIVE.authority,
      scope: { version: 1, kind: 'restricted', orgId: 'org1', siteIds: [siteB] } } });
    expect(await generateAutoEvidenceForOccurrence(ARGS)).toEqual({ ok: false, reason: 'scope_no_intersection' });
    expect(generateReportMock).not.toHaveBeenCalled();
    expect(nonCommentInserts()).toHaveLength(0);   // no run row is even opened
  });

  it('records a failed run and attaches no evidence when generation throws', async () => {
    rows.push([], [DEF]);
    resolveLiveMock.mockResolvedValue(LIVE);
    rows.push([{ id: 'run1' }]);
    generateReportMock.mockRejectedValue(new Error('boom'));
    rows.push([]);
    expect(await generateAutoEvidenceForOccurrence(ARGS)).toEqual({ ok: false, reason: 'generation_failed' });
    expect(nonCommentInserts()).toHaveLength(1);            // only the run row — no evidence
    expect(updated.at(-1)).toMatchObject({ status: 'failed', errorMessage: 'boom' });
  });

  it('attaches evidence but posts no comment when the occurrence has no ticket', async () => {
    rows.push([], [DEF]);
    resolveLiveMock.mockResolvedValue(LIVE);
    rows.push([{ id: 'run1' }]);
    generateReportMock.mockResolvedValue({ rows: [], rowCount: 0 });
    rows.push([], [{ id: 'e1' }]);
    expect(await generateAutoEvidenceForOccurrence({ ...ARGS, ticketId: null })).toEqual({ ok: true, reportRunId: 'run1' });
    expect(inserted).toHaveLength(2);                       // run + evidence, no comment
  });
});

describe('generateAutoEvidenceForDeliverable', () => {
  beforeEach(() => { rows.length = 0; inserted.length = 0; updated.length = 0; vi.clearAllMocks(); });
  const D = { id: 'd1', orgId: 'org1', name: 'Vuln review', cadence: 'monthly' as const, anchorDueDate: '2026-10-31',
    effectiveFrom: '2026-10-01', effectiveUntil: null, leadDays: 7, graceDays: 14, autoEvidenceReportId: 'r1' };

  it('is a no-op without a configured report', async () => {
    expect(await generateAutoEvidenceForDeliverable({ ...D, autoEvidenceReportId: null }, '2026-10-31')).toBe(0);
  });

  it('counts only successful generations and warns (never silently) on a refusal', async () => {
    rows.push([
      { id: 'o1', ticketId: 't1', dueAt: '2026-10-31', periodStart: '2026-10-01', periodEnd: '2026-10-31', lastRefusal: null },
      { id: 'o2', ticketId: null, dueAt: '2026-11-30', periodStart: '2026-11-01', periodEnd: '2026-11-30', lastRefusal: null },
    ]);
    // o1: due, definition is system-principal → refused; o2: not due
    rows.push([], [{ ...DEF, executionScopePrincipalKind: 'system' }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await generateAutoEvidenceForDeliverable(D, '2026-10-31')).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('auto-evidence skipped'), 'occurrenceId=o1', 'reportId=r1', 'reason=system_principal_definition');
    } finally { warn.mockRestore(); }
  });
});

describe('managed evidence path and visible refusal state (#5784 W01)', () => {
  beforeEach(() => { rows.length = 0; inserted.length = 0; updated.length = 0; vi.clearAllMocks(); baselineMock.mockResolvedValue(undefined); });
  const MANAGED = { ...DEF, type: 'threat_detection_review', portalSelfService: true, executionScopeUserId: 'departed' };

  it('generates a managed evidence type under system authority, ignoring the definition owner', async () => {
    // The case OD-5 exists for: the owning user is gone. The user path would
    // return scope_unverifiable; the managed path must still produce a run.
    resolveLiveMock.mockResolvedValue({ ok: false, reason: 'unverifiable_scope' });
    rows.push([], [MANAGED]);
    rows.push([{ id: 'run1' }]);
    generateManagedEvidenceMock.mockResolvedValue({ rows: [], rowCount: 0, summary: { n: 2 } });
    rows.push([], [], [{ id: 'e1' }], []);
    expect(await generateAutoEvidenceForOccurrence(ARGS)).toEqual({ ok: true, reportRunId: 'run1' });
    expect(generateManagedEvidenceMock).toHaveBeenCalledWith('threat_detection_review', 'org1', {}, expect.objectContaining({ deliverableId: 'd1' }));
    expect(resolveLiveMock).not.toHaveBeenCalled();
    expect(generateReportMock).not.toHaveBeenCalled();
    // The run row records that the SYSTEM authority ran, org-wide, no user.
    expect(inserted[0]).toMatchObject({ reportId: 'r1', requestedByKind: 'system', requestedByUserId: null,
      executionScopePrincipalKind: 'system', executionScopeKind: 'unrestricted', executionScopeUserId: null });
    expect(inserted.at(-2)).toMatchObject({ kind: 'report_run', reportId: 'r1', reportRunId: 'run1' });
  });

  it('passes the occurrence period and the prior-occurrence baseline into generation and persists the baseline', async () => {
    baselineMock.mockResolvedValue({ generatedAt: '2026-09-30T05:18:00Z', summary: { n: 1 } });
    rows.push([], [MANAGED], [{ id: 'run1' }]);
    generateManagedEvidenceMock.mockResolvedValue({ rows: [], rowCount: 0, summary: { n: 2 } });
    rows.push([], [], [{ id: 'e1' }], []);
    await generateAutoEvidenceForOccurrence(ARGS);
    const evidence = generateManagedEvidenceMock.mock.calls[0]![3];
    expect(evidence).toMatchObject({ periodStart: '2026-10-01', periodEnd: '2026-10-31', deliverableId: 'd1' });
    expect(typeof evidence.generatedAt).toBe('string');
    expect(baselineMock).toHaveBeenCalledWith({ deliverableId: 'd1', currentPeriodStart: '2026-10-01' });
    // The baseline lands in the persisted result, not only in memory.
    const completed = updated.find((u) => (u as { status?: string }).status === 'completed') as { result: unknown };
    expect(completed.result).toMatchObject({ previous: { summary: { n: 1 } } });
  });

  it('adds the baseline to the existing user path too, so #5573 users get comparators', async () => {
    baselineMock.mockResolvedValue({ generatedAt: '2026-09-30T05:18:00Z', summary: { n: 1 } });
    rows.push([], [DEF]);
    resolveLiveMock.mockResolvedValue(LIVE);
    rows.push([{ id: 'run1' }]);
    generateReportMock.mockResolvedValue({ rows: [], rowCount: 0, summary: {} });
    rows.push([], [], [{ id: 'e1' }], []);
    expect(await generateAutoEvidenceForOccurrence(ARGS)).toEqual({ ok: true, reportRunId: 'run1' });
    const completed = updated.find((u) => (u as { status?: string }).status === 'completed') as { result: unknown };
    expect(completed.result).toMatchObject({ previous: { summary: { n: 1 } } });
  });

  it('leaves a NON-managed definition on the existing user-authority path', async () => {
    rows.push([], [DEF]);
    resolveLiveMock.mockResolvedValue(LIVE);
    rows.push([{ id: 'run1' }]);
    generateReportMock.mockResolvedValue({ rows: [], rowCount: 0 });
    rows.push([], [], [{ id: 'e1' }], []);
    await generateAutoEvidenceForOccurrence(ARGS);
    expect(resolveLiveMock).toHaveBeenCalled();
    expect(generateManagedEvidenceMock).not.toHaveBeenCalled();
  });

  it('a user-authored definition of a managed type (not portal_self_service) stays on the user path', async () => {
    rows.push([], [{ ...MANAGED, portalSelfService: false, executionScopeUserId: 'u1' }]);
    resolveLiveMock.mockResolvedValue(LIVE);
    rows.push([{ id: 'run1' }]);
    generateReportMock.mockResolvedValue({ rows: [], rowCount: 0 });
    rows.push([], [], [{ id: 'e1' }], []);
    await generateAutoEvidenceForOccurrence(ARGS);
    expect(generateManagedEvidenceMock).not.toHaveBeenCalled();
    expect(resolveLiveMock).toHaveBeenCalled();
  });

  it('records the refusal and comments once, not once per nightly sweep', async () => {
    // First refusal: state written, one internal comment.
    rows.push([], []);
    expect(await generateAutoEvidenceForOccurrence(ARGS)).toEqual({ ok: false, reason: 'definition_not_found' });
    expect(updated.at(-1)).toMatchObject({ autoEvidenceRefusal: 'definition_not_found', autoEvidenceAttemptedAt: expect.any(Date) });
    expect(internalComments()).toHaveLength(1);
    expect(internalComments()[0]).toMatchObject({ ticketId: 't1', authorName: 'Breeze', authorType: 'system', isPublic: false,
      originPrincipalKind: 'system', content: AUTO_EVIDENCE_REFUSAL_NOTES.definition_not_found });

    // Same refusal tomorrow: state refreshed, NO second comment.
    inserted.length = 0; updated.length = 0;
    rows.push([], []);
    await generateAutoEvidenceForOccurrence({ ...ARGS, lastRefusal: 'definition_not_found' });
    expect(updated.at(-1)).toMatchObject({ autoEvidenceRefusal: 'definition_not_found' });
    expect(internalComments()).toHaveLength(0);

    // A DIFFERENT refusal comments again.
    inserted.length = 0;
    rows.push([], [{ ...DEF, executionScopePrincipalKind: 'system', executionScopeUserId: null }]);
    await generateAutoEvidenceForOccurrence({ ...ARGS, lastRefusal: 'definition_not_found' });
    expect(internalComments()).toHaveLength(1);
    expect(internalComments()[0]).toMatchObject({ content: AUTO_EVIDENCE_REFUSAL_NOTES.system_principal_definition });
  });

  it('records generation_failed after stamping the run failed', async () => {
    rows.push([], [DEF]);
    resolveLiveMock.mockResolvedValue(LIVE);
    rows.push([{ id: 'run1' }]);
    generateReportMock.mockRejectedValue(new Error('boom'));
    expect(await generateAutoEvidenceForOccurrence(ARGS)).toEqual({ ok: false, reason: 'generation_failed' });
    expect(updated.some((u) => (u as { autoEvidenceRefusal?: string }).autoEvidenceRefusal === 'generation_failed')).toBe(true);
    expect(updated.some((u) => (u as { status?: string }).status === 'failed')).toBe(true);
    expect(internalComments()).toHaveLength(1);
  });

  it('does not comment without a ticket, but still records the state', async () => {
    rows.push([], []);
    await generateAutoEvidenceForOccurrence({ ...ARGS, ticketId: null });
    expect(updated.at(-1)).toMatchObject({ autoEvidenceRefusal: 'definition_not_found' });
    expect(internalComments()).toHaveLength(0);
  });

  it('clears the refusal state on a successful run', async () => {
    rows.push([], [DEF]);
    resolveLiveMock.mockResolvedValue(LIVE);
    rows.push([{ id: 'run1' }]);
    generateReportMock.mockResolvedValue({ rows: [], rowCount: 0 });
    rows.push([], [], [{ id: 'e1' }], []);
    await generateAutoEvidenceForOccurrence({ ...ARGS, lastRefusal: 'generation_failed' });
    expect(updated.some((u) => (u as { autoEvidenceRefusal?: unknown }).autoEvidenceRefusal === null
      && (u as { autoEvidenceAttemptedAt?: unknown }).autoEvidenceAttemptedAt instanceof Date)).toBe(true);
  });

  it('never writes state or comments for not_due or already_attached', async () => {
    await generateAutoEvidenceForOccurrence({ ...ARGS, today: '2026-10-30' });
    rows.push([{ id: 'e1' }]);
    await generateAutoEvidenceForOccurrence(ARGS);
    expect(updated).toHaveLength(0);
    expect(internalComments()).toHaveLength(0);
  });

  it('has a note for every refusal reason except the two quiet ones', () => {
    expect(AUTO_EVIDENCE_REFUSAL_NOTES.not_due).toBeNull();
    expect(AUTO_EVIDENCE_REFUSAL_NOTES.already_attached).toBeNull();
    for (const [reason, note] of Object.entries(AUTO_EVIDENCE_REFUSAL_NOTES)) {
      if (reason === 'not_due' || reason === 'already_attached') continue;
      expect(typeof note).toBe('string');
      expect((note as string).length).toBeGreaterThan(20);
    }
  });
});
