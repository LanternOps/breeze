import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ snapshot: vi.fn(), transactionDepth: 0, lock: vi.fn(), update: vi.fn(), set: vi.fn(), where: vi.fn() }));
vi.mock('../../db', () => ({ db: { update: h.update }, withDbTransaction: async (fn: () => Promise<unknown>) => { h.transactionDepth++; try { return await fn(); } finally { h.transactionDepth--; } } }));
vi.mock('../../services/networkIsolation/episodeStore', async original => ({ ...(await original<typeof import('../../services/networkIsolation/episodeStore')>()), withEpisodeLock: h.lock, writeEpisodeSnapshot: h.snapshot }));

import { isolationVerifyRoutes } from './isolationVerify';
import { db } from '../../db';

const DEVICE = '33333333-3333-4333-8333-333333333333';
const OTHER_DEVICE = '33333333-3333-4333-8333-333333333334';
const ORG = '22222222-2222-4222-8222-222222222222';
const EPISODE = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-10-31T12:34:56Z');
let episode: Record<string, unknown>;

function app(agent: Record<string, unknown> | null = {}) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    if (agent !== null) c.set('agent', {
      role: 'agent', deviceId: DEVICE, orgId: ORG, agentId: 'agent-test',
      partnerId: null, siteId: null, installIncarnation: 1, ...agent,
    } as never);
    await next();
  });
  a.route('/agents', isolationVerifyRoutes);
  return a;
}

const post = (a = app(), isolationId = EPISODE, extraBody: Record<string, unknown> = {}) =>
  a.request(`/agents/agent-test/isolation/${isolationId}/verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(extraBody),
  });

describe('POST /agents/:id/isolation/:isolationId/verify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    episode = { id: EPISODE, deviceId: DEVICE, orgId: ORG, state: 'applying', desiredState: 'isolated', generation: 1, verifiedAt: null };
    h.snapshot.mockReset().mockResolvedValue(true);
    h.lock.mockReset().mockImplementation(async (_tx: unknown, _id: string, fn: (row: unknown) => Promise<unknown>) => {
      expect(h.transactionDepth).toBe(1);
      return { found: true, value: await fn(episode) };
    });
    const chain: any = {
      where: h.where,
      returning: vi.fn(async () => [{ id: EPISODE }]),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve([{ id: EPISODE }]).then(resolve),
    };
    h.update.mockReset().mockReturnValue({ set: h.set });
    h.set.mockReset().mockReturnValue(chain);
    h.where.mockReset().mockReturnValue(chain);
  });
  afterEach(() => vi.useRealTimers());

  it('does not attach the isolation role guard to watchdog command polling when mounted', async () => {
    const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const commands = new Hono().get('/:id/commands', c => c.json({ commands: [] }));
    const mounted = new Hono();
    mounted.use('*', async (c, next) => { c.set('agent', { role: 'watchdog' } as never); await next(); });
    const order = [
      { offset: index.indexOf("agentRoutes.route('/', commandsRoutes)"), router: commands },
      { offset: index.indexOf("agentRoutes.route('/', isolationVerifyRoutes)"), router: isolationVerifyRoutes },
    ];
    for (const { offset, router } of order.sort((a, b) => a.offset - b.offset)) {
      expect(offset).toBeGreaterThan(-1);
      mounted.route('/agents', router);
    }
    expect((await mounted.request('/agents/agent-test/commands')).status).toBe(200);
  });

  it('stamps server time under the episode lock and returns the Date header', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(h.lock).toHaveBeenCalledWith(db, EPISODE, expect.any(Function));
    expect(h.snapshot).toHaveBeenCalledWith(db, EPISODE, expect.anything(), expect.objectContaining({ state: episode.state, verifiedAt: NOW }), NOW);
    expect(res.headers.get('date')).toBe(NOW.toUTCString());
  });

  it('ignores client timestamps and cannot certify a newer generation from input', async () => {
    const res = await post(app(), EPISODE, { verifiedAt: '2099-01-01T00:00:00Z', generation: 100 });
    expect(res.status).toBe(200);
    expect(h.snapshot).toHaveBeenCalledWith(db, EPISODE, expect.anything(), expect.objectContaining({ state: episode.state, verifiedAt: NOW }), NOW);
    expect(h.snapshot.mock.calls[0]![3]).toMatchObject({ generation: 1, state: 'applying' });
  });

  it.each(['applied', 'verified', 'dispatched', 'requested'])('accepts live %s episodes without changing state', async (state) => {
    episode.state = state;
    const res = await post();
    expect(res.status).toBe(200);
    expect(h.snapshot.mock.calls[0]![3]).toHaveProperty('state', state);
  });

  it('rejects another device credential even in the same org', async () => {
    const res = await post(app({ deviceId: OTHER_DEVICE }));
    expect(res.status).toBe(404);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('rejects another org credential even if supplied a matching device id', async () => {
    const res = await post(app({ orgId: '22222222-2222-4222-8222-222222222223' }));
    expect(res.status).toBe(404);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('rejects unknown episodes', async () => {
    h.lock.mockResolvedValue({ found: false });
    expect((await post()).status).toBe(404);
    expect(h.update).not.toHaveBeenCalled();
  });

  it.each(['release_requested', 'released', 'expired', 'failed', 'released_locally', 'self_released', 'uninstalled'])('rejects %s episodes', async (state) => {
    episode.state = state;
    episode.desiredState = 'released';
    const res = await post();
    expect(res.status).toBe(409);
    expect(h.update).not.toHaveBeenCalled();
  });

  it.each(['watchdog', 'backup'])('refuses the %s credential before reading the episode', async (role) => {
    expect((await post(app({ role }))).status).toBe(403);
    expect(h.lock).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it('refuses a request without agent auth context', async () => {
    expect((await post(app(null))).status).toBe(403);
    expect(h.lock).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });
  it('refuses a different agent id before reading the episode', async () => {
    expect((await post(app({ agentId: 'different-agent' }))).status).toBe(403);
    expect(h.lock).not.toHaveBeenCalled();
  });
  it('refuses a lost snapshot CAS', async () => {
    h.snapshot.mockResolvedValue(false);
    expect((await post()).status).toBe(409);
  });
  it('does not replace an existing verification timestamp', async () => {
    const first = new Date('2026-10-30T00:00:00Z'); episode.verifiedAt = first;
    expect((await post()).status).toBe(200);
    expect(h.snapshot.mock.calls[0]![3]).toHaveProperty('verifiedAt', first);
  });

});
