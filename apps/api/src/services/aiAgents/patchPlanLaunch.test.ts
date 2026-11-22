import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  resolveAgent: vi.fn(),
  createRun: vi.fn(),
  existing: vi.fn(),
}));

vi.mock('./effectivePolicy', () => ({ resolveEffectiveAgent: (...a: unknown[]) => h.resolveAgent(...a) }));
vi.mock('./runService', () => ({ createAndEnqueueAgentRun: (...a: unknown[]) => h.createRun(...a) }));
vi.mock('../../db', () => ({
  db: {
    select: () => {
      const chain = {
        from: () => chain,
        where: () => chain,
        limit: () => Promise.resolve(h.existing()),
      };
      return chain;
    },
  },
  runOutsideDbContext: <T>(fn: () => T) => fn(),
  withSystemDbAccessContext: <T>(fn: () => T) => fn(),
}));

import type { AuthContext } from '../../middleware/auth';
import { launchPatchPlanRun } from './patchPlanLaunch';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const AGENT = '55555555-5555-4555-8555-555555555555';
const RUN = '66666666-6666-4666-8666-666666666666';
const USER = '44444444-4444-4444-8444-444444444444';

const auth = { scope: 'organization', orgId: ORG, user: { id: USER }, canAccessOrg: (id: string) => id === ORG } as unknown as AuthContext;

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.resolveAgent.mockResolvedValue({ agentId: AGENT });
  h.createRun.mockResolvedValue({ created: true, run: { id: RUN, status: 'queued', errorCode: null } });
  h.existing.mockReturnValue([]);
});

describe('launchPatchPlanRun (#6786 T2)', () => {
  it('an org outside reach is NOT_FOUND before any lookup', async () => {
    expect(await launchPatchPlanRun(auth, OTHER, 'k')).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(h.resolveAgent).not.toHaveBeenCalled();
    expect(h.createRun).not.toHaveBeenCalled();
  });

  it('no effective patch agent is NO_PATCH_AGENT', async () => {
    h.resolveAgent.mockResolvedValue(null);
    expect(await launchPatchPlanRun(auth, ORG, 'k')).toEqual({ ok: false, code: 'NO_PATCH_AGENT' });
    expect(h.createRun).not.toHaveBeenCalled();
  });

  it('admits the org\'s effective patch agent: device-less, patch profile, manual, the caller\'s key and requester', async () => {
    expect(await launchPatchPlanRun(auth, ORG, 'patch-ai-tool-i1')).toEqual({ ok: true, runId: RUN, agentId: AGENT, enqueueFailed: false, replayed: false });
    expect(h.resolveAgent).toHaveBeenCalledWith(auth, ORG, 'patch');
    expect(h.createRun).toHaveBeenCalledWith({
      orgId: ORG, kind: 'patch', triggerKind: 'manual', deviceId: null, profile: 'patch',
      dedupeKey: 'patch-ai-tool-i1', triggerRef: { requestedByUserId: USER, agentId: AGENT },
    });
  });

  it('a declined admission is SKIPPED with the reason', async () => {
    h.createRun.mockResolvedValue({ created: false, skipped: 'org_cap' });
    expect(await launchPatchPlanRun(auth, ORG, 'k')).toEqual({ ok: false, code: 'SKIPPED', skipped: 'org_cap', agentId: AGENT });
  });

  it('a run created but never enqueued is reported, not hidden', async () => {
    h.createRun.mockResolvedValue({ created: true, run: { id: RUN, status: 'failed', errorCode: 'enqueue_failed' } });
    expect(await launchPatchPlanRun(auth, ORG, 'k')).toMatchObject({ ok: true, runId: RUN, enqueueFailed: true });
  });

  it('without replay, a duplicate key is SKIPPED and nothing is read', async () => {
    h.createRun.mockResolvedValue({ created: false, skipped: 'duplicate' });
    expect(await launchPatchPlanRun(auth, ORG, 'k')).toMatchObject({ ok: false, code: 'SKIPPED', skipped: 'duplicate' });
    expect(h.existing).not.toHaveBeenCalled();
  });

  it('with replay, a run already admitted on this key is returned without a second admission', async () => {
    h.existing.mockReturnValue([{ id: RUN, status: 'running', errorCode: null }]);
    expect(await launchPatchPlanRun(auth, ORG, 'patch-ai-tool-i1', { replay: true }))
      .toEqual({ ok: true, runId: RUN, agentId: AGENT, enqueueFailed: false, replayed: true });
    expect(h.createRun).not.toHaveBeenCalled();
  });

  it('with replay, a row that failed to enqueue is not a replay: admission reclaims it', async () => {
    h.existing.mockReturnValue([{ id: RUN, status: 'failed', errorCode: 'enqueue_failed' }]);
    await launchPatchPlanRun(auth, ORG, 'k', { replay: true });
    expect(h.createRun).toHaveBeenCalledTimes(1);
  });

  it('with replay, a duplicate raced in by a concurrent attempt resolves to that run', async () => {
    h.existing.mockReturnValueOnce([]).mockReturnValueOnce([{ id: RUN, status: 'queued', errorCode: null }]);
    h.createRun.mockResolvedValue({ created: false, skipped: 'duplicate' });
    expect(await launchPatchPlanRun(auth, ORG, 'k', { replay: true })).toMatchObject({ ok: true, runId: RUN, replayed: true });
  });
});
