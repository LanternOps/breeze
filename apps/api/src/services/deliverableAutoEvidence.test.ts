import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rows, inserted, updated, generateReportMock, resolveLiveMock, preflightMock } = vi.hoisted(() => ({
  rows: [] as unknown[], inserted: [] as unknown[], updated: [] as unknown[],
  generateReportMock: vi.fn(), resolveLiveMock: vi.fn(), preflightMock: vi.fn(),
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
vi.mock('./reportGenerationService', () => ({ generateReport: generateReportMock, assertReportExecutionPreflight: preflightMock }));
vi.mock('./siteScope', async (orig) => ({ ...(await orig<typeof import('./siteScope')>()), resolveLiveReportAuthority: resolveLiveMock }));

import { AUTO_EVIDENCE_TICKET_NOTE, generateAutoEvidenceForDeliverable, generateAutoEvidenceForOccurrence } from './deliverableAutoEvidence';
import { siteScopeFingerprint } from './siteScope';

// A persisted definition as the report routes write it: complete, with a
// fingerprint that matches its scope (decodeSiteScope verifies it).
const DEF = { id: 'r1', orgId: 'org1', type: 'vulnerability_summary', config: {}, name: 'Vulnerability summary',
  executionScopePrincipalKind: 'user', executionScopeUserId: 'u1',
  executionScopeVersion: 1, executionScopeKind: 'unrestricted', executionScopeSiteIds: null,
  executionScopeFingerprint: siteScopeFingerprint({ version: 1, kind: 'unrestricted', orgId: 'org1' }),
  executionScopeCapturedAt: new Date('2026-10-01T00:00:00Z') };
const ARGS = { orgId: 'org1', occurrenceId: 'o1', ticketId: 't1', reportId: 'r1', dueAt: '2026-10-31', today: '2026-10-31' };
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
    expect(inserted).toHaveLength(0);
  });

  it('refuses when the preflight rejects the config against the authority', async () => {
    rows.push([], [DEF]);
    resolveLiveMock.mockResolvedValue(LIVE);
    preflightMock.mockImplementationOnce(() => { throw new Error('outside'); });
    expect(await generateAutoEvidenceForOccurrence(ARGS)).toEqual({ ok: false, reason: 'scope_unverifiable' });
    expect(inserted).toHaveLength(0);
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
    expect(inserted).toHaveLength(0);   // no run row is even opened
  });

  it('records a failed run and attaches no evidence when generation throws', async () => {
    rows.push([], [DEF]);
    resolveLiveMock.mockResolvedValue(LIVE);
    rows.push([{ id: 'run1' }]);
    generateReportMock.mockRejectedValue(new Error('boom'));
    rows.push([]);
    expect(await generateAutoEvidenceForOccurrence(ARGS)).toEqual({ ok: false, reason: 'generation_failed' });
    expect(inserted).toHaveLength(1);                       // only the run row
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
    rows.push([{ id: 'o1', ticketId: 't1', dueAt: '2026-10-31' }, { id: 'o2', ticketId: null, dueAt: '2026-11-30' }]);
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
