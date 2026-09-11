import { beforeEach, describe, expect, it, vi } from 'vitest';

const { flagMock, runnableMock, dispatchMock, accessMock, waitMock } = vi.hoisted(() => ({
  flagMock: vi.fn(() => true),
  runnableMock: vi.fn(async () => ({ ok: false, reason: 'not_reviewed' as const })),
  dispatchMock: vi.fn(async () => ({ ok: true, commandId: 'c1', executionId: 'e1', runAs: 'system' })),
  accessMock: vi.fn(async () => [{ id: 'd1', orgId: 'org-1', status: 'online', siteId: null }]),
  waitMock: vi.fn(async () => ({ id: 'c1', result: { status: 'completed', exitCode: 0 } })),
}));

vi.mock('../config/env', () => ({ aiScriptAuthoringEnabled: flagMock }));
vi.mock('./scriptProposals', () => ({
  assertProposalRunnable: runnableMock,
  proposalDispatchSnapshot: () => ({ proposalId: 'p1', deviceIds: ['d1'] }),
}));
vi.mock('./scriptDispatch', () => ({ dispatchScriptToDevice: dispatchMock }));
vi.mock('./commandQueue', () => ({ waitForCommandResult: waitMock, executeCommand: vi.fn() }));
vi.mock('../db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: accessMock }) }) }) },
  withSystemDbAccessContext: <T,>(fn: () => Promise<T>) => fn(),
  runOutsideDbContext: <T,>(fn: () => T) => fn(),
}));

import { __testOnly } from './aiToolsScripts';

const auth = {
  orgId: 'org-1', user: { id: 'u1' }, scope: 'organization',
  orgCondition: () => undefined, canAccessOrg: () => true, accessibleOrgIds: ['org-1'],
} as never;

beforeEach(() => { runnableMock.mockClear(); dispatchMock.mockClear(); flagMock.mockReturnValue(true); });

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
    const dispatchInput = dispatchMock.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect((dispatchInput.source as { kind: string }).kind).toBe('proposal');
    expect((dispatchInput.provenance as { approvalMethod: string }).approvalMethod).toBe('supervised_self');
    expect((dispatchInput.offlinePolicy as { kind: string }).kind).toBe('reject');
    expect(out.proposalId).toBe('p1');
    expect(out.results.d1.executionId).toBe('e1');
  });
});
