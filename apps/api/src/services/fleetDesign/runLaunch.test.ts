import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ resolve: vi.fn(), admit: vi.fn(), sites: [] as unknown[], runs: [] as unknown[] }));

vi.mock('../aiAgents/effectivePolicy', () => ({ resolveEffectiveAgent: h.resolve }));
vi.mock('../aiAgents/runService', () => ({ createAndEnqueueAgentRun: h.admit }));
vi.mock('../../db', () => {
  const name = Symbol.for('drizzle:Name');
  const query = (rows: () => unknown[]) => ({ where: () => ({ limit: async () => rows() }) });
  return {
    db: { select: () => ({ from: (table: Record<symbol, unknown>) => query(() => (table[name] === 'sites' ? h.sites : h.runs)) }) },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

import type { AuthContext } from '../../middleware/auth';
import { launchFleetDesignRun } from './runLaunch';

const ORG = '00000000-0000-4000-8000-0000000000c1';
const SITE = '00000000-0000-4000-8000-0000000000c2';
const auth = (over: Partial<AuthContext> = {}) => ({
  user: { id: 'u-1' },
  canAccessOrg: (id: string) => id === ORG,
  ...over,
}) as unknown as AuthContext;

beforeEach(() => {
  h.resolve.mockReset();
  h.admit.mockReset();
  h.sites = [];
  h.runs = [];
  h.resolve.mockResolvedValue({ agentId: 'agent-1' });
  h.admit.mockResolvedValue({ created: true, run: { id: 'run-1', status: 'queued', errorCode: null } });
});

describe('launchFleetDesignRun', () => {
  it('an org outside reach is NOT_FOUND with no admission', async () => {
    await expect(launchFleetDesignRun(auth(), { orgId: 'other' }, 'k')).resolves.toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.admit).not.toHaveBeenCalled();
  });

  it('a site not in the org is the same NOT_FOUND', async () => {
    await expect(launchFleetDesignRun(auth(), { orgId: ORG, siteId: SITE }, 'k')).resolves.toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(h.admit).not.toHaveBeenCalled();
  });

  it('no designer agent is NO_DESIGNER_AGENT', async () => {
    h.resolve.mockResolvedValue(null);
    await expect(launchFleetDesignRun(auth(), { orgId: ORG }, 'k')).resolves.toEqual({ ok: false, code: 'NO_DESIGNER_AGENT' });
  });

  it("admits a device-less design run for the org's effective designer, carrying the verified site", async () => {
    h.sites = [{ id: SITE }];
    await expect(launchFleetDesignRun(auth(), { orgId: ORG, siteId: SITE }, 'k-1')).resolves.toEqual({
      ok: true, runId: 'run-1', agentId: 'agent-1', enqueueFailed: false, replayed: false,
    });
    expect(h.admit).toHaveBeenCalledWith({
      orgId: ORG,
      kind: 'designer',
      triggerKind: 'manual',
      deviceId: null,
      profile: 'design',
      dedupeKey: 'k-1',
      triggerRef: { requestedByUserId: 'u-1', agentId: 'agent-1', siteId: SITE },
    });
  });

  it('a declined admission is SKIPPED with the reason', async () => {
    h.admit.mockResolvedValue({ created: false, skipped: 'mode_off' });
    await expect(launchFleetDesignRun(auth(), { orgId: ORG }, 'k')).resolves.toEqual({ ok: false, code: 'SKIPPED', skipped: 'mode_off', agentId: 'agent-1' });
  });

  it('a failed enqueue is reported, not hidden', async () => {
    h.admit.mockResolvedValue({ created: true, run: { id: 'run-1', status: 'failed', errorCode: 'enqueue_failed' } });
    await expect(launchFleetDesignRun(auth(), { orgId: ORG }, 'k')).resolves.toMatchObject({ ok: true, enqueueFailed: true });
  });

  describe('replay (a retried release)', () => {
    it('returns the run already admitted on the key and admits nothing', async () => {
      h.runs = [{ id: 'run-0', status: 'running', errorCode: null }];
      await expect(launchFleetDesignRun(auth(), { orgId: ORG }, 'k', { replay: true })).resolves.toMatchObject({ ok: true, runId: 'run-0', replayed: true });
      expect(h.admit).not.toHaveBeenCalled();
    });

    it('a raced duplicate resolves to that run', async () => {
      h.admit.mockImplementation(async () => {
        h.runs = [{ id: 'run-raced', status: 'queued', errorCode: null }];
        return { created: false, skipped: 'duplicate' };
      });
      await expect(launchFleetDesignRun(auth(), { orgId: ORG }, 'k', { replay: true })).resolves.toMatchObject({ ok: true, runId: 'run-raced', replayed: true });
    });

    it('a row left enqueue_failed is not a replay', async () => {
      h.runs = [{ id: 'run-0', status: 'failed', errorCode: 'enqueue_failed' }];
      await launchFleetDesignRun(auth(), { orgId: ORG }, 'k', { replay: true });
      expect(h.admit).toHaveBeenCalledTimes(1);
    });

    it('without replay a duplicate stays SKIPPED, as REST', async () => {
      h.admit.mockResolvedValue({ created: false, skipped: 'duplicate' });
      await expect(launchFleetDesignRun(auth(), { orgId: ORG }, 'k')).resolves.toMatchObject({ ok: false, code: 'SKIPPED', skipped: 'duplicate' });
    });
  });
});
