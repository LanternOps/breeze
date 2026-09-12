import { beforeEach, describe, expect, it, vi } from 'vitest';

const { flagMock, runnableMock, dispatchMock, accessMock, waitMock, transitionMock } = vi.hoisted(() => ({
  flagMock: vi.fn(() => true),
  transitionMock: vi.fn(async () => true),
  runnableMock: vi.fn(async () => ({ ok: false, reason: 'not_reviewed' as const })),
  dispatchMock: vi.fn(async () => ({ ok: true, commandId: 'c1', executionId: 'e1', runAs: 'system' })),
  accessMock: vi.fn(async () => [{ id: 'd1', orgId: 'org-1', status: 'online', siteId: null }]),
  waitMock: vi.fn(async () => ({ id: 'c1', result: { status: 'completed', exitCode: 0 } })),
}));

vi.mock('../config/env', () => ({ aiScriptAuthoringEnabled: flagMock }));
vi.mock('./scriptProposals', () => ({
  assertProposalRunnable: runnableMock,
  proposalDispatchSnapshot: () => ({ proposalId: 'p1', deviceIds: ['d1'] }),
  transitionProposal: transitionMock,
}));
vi.mock('./scriptDispatch', () => ({ dispatchScriptToDevice: dispatchMock }));
vi.mock('./commandQueue', () => ({ waitForCommandResult: waitMock, executeCommand: vi.fn() }));
const TX = { tx: true };
vi.mock('../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: accessMock }) }) }),
    transaction: (fn: (tx: unknown) => unknown) => fn(TX),
  },
  withSystemDbAccessContext: <T,>(fn: () => Promise<T>) => fn(),
  runOutsideDbContext: <T,>(fn: () => T) => fn(),
}));

import { __testOnly } from './aiToolsScripts';

const auth = {
  orgId: 'org-1', user: { id: 'u1' }, scope: 'organization',
  orgCondition: () => undefined, canAccessOrg: () => true, accessibleOrgIds: ['org-1'],
} as never;

beforeEach(() => { runnableMock.mockClear(); dispatchMock.mockClear(); transitionMock.mockClear(); flagMock.mockReturnValue(true); });

describe('run_script proposal branch', () => {
  it('returns feature_disabled without touching the database when the flag is off', async () => {
    flagMock.mockReturnValueOnce(false);
    const out = JSON.parse(await __testOnly.runScriptHandler({ proposalId: 'p1', deviceIds: ['d1'] }, auth));
    expect(out.error).toContain('feature_disabled');
    expect(runnableMock).not.toHaveBeenCalled();
  });

  it('returns the typed refusal reason and never falls back to a library run', async () => {
    const out = JSON.parse(await __testOnly.runScriptHandler({ proposalId: 'p1', deviceIds: ['d1'] }, auth));
    expect(out.error).toContain('not_reviewed');
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('dispatches with the proposal source kind and echoes the proposalId', async () => {
    runnableMock.mockResolvedValueOnce({
      ok: true,
      proposal: { id: 'p1', language: 'powershell', runAs: 'system', timeoutSeconds: 300, contentDigest: 'a'.repeat(64), riskTier: 'low' },
    } as never);
    const out = JSON.parse(await __testOnly.runScriptHandler({ proposalId: 'p1', deviceIds: ['d1'] }, auth));
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const dispatchInput = (dispatchMock.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0];
    expect((dispatchInput.source as { kind: string }).kind).toBe('proposal');
    expect((dispatchInput.provenance as { approvalMethod: string }).approvalMethod).toBe('supervised_self');
    expect((dispatchInput.offlinePolicy as { kind: string }).kind).toBe('reject');
    expect(out.proposalId).toBe('p1');
    expect(out.results.d1.executionId).toBe('e1');
  });

  it('passes the releasing intent id from the execution context to the runnability check', async () => {
    await __testOnly.runScriptHandler({ proposalId: 'p1', deviceIds: ['d1'] }, auth, { actionIntentId: 'i1' } as never);
    expect(runnableMock).toHaveBeenLastCalledWith(auth, expect.objectContaining({ proposalId: 'p1', releasingIntentId: 'i1' }));
  });

  // W03 (#5612): `executed` is the precondition for verification (§4.9) and,
  // through `verified`, for promotion (§4.8).
  it('moves a proposal-backed run to executed once the dispatch is accepted', async () => {
    runnableMock.mockResolvedValueOnce({
      ok: true,
      proposal: { id: 'p1', language: 'powershell', runAs: 'system', timeoutSeconds: 300, contentDigest: 'a'.repeat(64), riskTier: 'low' },
    } as never);
    await __testOnly.runScriptHandler({ proposalId: 'p1', deviceIds: ['d1'] }, auth);
    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(transitionMock).toHaveBeenCalledWith(
      TX, 'p1', ['reviewed', 'approved'], 'executed', expect.objectContaining({}),
    );
  });

  it('does NOT move the proposal when the dispatch was refused', async () => {
    runnableMock.mockResolvedValueOnce({
      ok: true,
      proposal: { id: 'p1', language: 'powershell', runAs: 'system', timeoutSeconds: 300, contentDigest: 'a'.repeat(64), riskTier: 'low' },
    } as never);
    dispatchMock.mockResolvedValueOnce({ ok: false, error: 'maintenance_suppressed' } as never);
    await __testOnly.runScriptHandler({ proposalId: 'p1', deviceIds: ['d1'] }, auth);
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it('transitions once for a multi-device call (CAS from reviewed|approved)', async () => {
    runnableMock.mockResolvedValueOnce({
      ok: true,
      proposal: { id: 'p1', language: 'powershell', runAs: 'system', timeoutSeconds: 300, contentDigest: 'a'.repeat(64), riskTier: 'low' },
    } as never);
    accessMock.mockResolvedValue([{ id: 'd1', orgId: 'org-1', status: 'online', siteId: null }] as never);
    await __testOnly.runScriptHandler({ proposalId: 'p1', deviceIds: ['d1', 'd1'] }, auth);
    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(transitionMock).toHaveBeenCalledTimes(1);
  });
});
