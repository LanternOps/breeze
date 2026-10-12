import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectQueue, mockDb } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const chain = (value: unknown[]) => {
    const c: Record<string, unknown> = {};
    c.from = () => c;
    c.where = () => c;
    c.orderBy = () => c;
    c.limit = () => Promise.resolve(value);
    c.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      Promise.resolve(value).then(resolve, reject);
    return c;
  };
  const mockDb = { select: vi.fn(() => chain(selectQueue.shift() ?? [])) };
  return { selectQueue, mockDb };
});

vi.mock('../db', () => ({ db: mockDb }));

import {
  rankDiscoveryAgentCandidates,
  loadSiteDiscoveryAgentCandidates,
  resolvePinnedDiscoveryAgent,
} from './discoveryAgentSelection';

const cand = (deviceId: string, addresses: string[]) => ({
  deviceId,
  agentId: `agent-${deviceId}`,
  label: `host-${deviceId}`,
  addresses,
});

describe('rankDiscoveryAgentCandidates (#7969)', () => {
  it('prefers an agent with an address inside a profile subnet over an off-LAN agent that sorts first', () => {
    const ranked = rankDiscoveryAgentCandidates(
      [cand('a', ['10.8.0.5']), cand('b', ['192.168.1.20'])],
      ['192.168.1.0/24'],
    );
    expect(ranked.map((r) => r.deviceId)).toEqual(['b', 'a']);
    expect(ranked[0]!.subnetMatch).toBe(true);
    expect(ranked[1]!.subnetMatch).toBe(false);
  });

  it('breaks ties on device id, independent of input order', () => {
    const subnets = ['192.168.1.0/24'];
    const one = rankDiscoveryAgentCandidates(
      [cand('c', ['192.168.1.3']), cand('a', ['192.168.1.1']), cand('b', ['10.0.0.1'])],
      subnets,
    );
    const two = rankDiscoveryAgentCandidates(
      [cand('b', ['10.0.0.1']), cand('a', ['192.168.1.1']), cand('c', ['192.168.1.3'])],
      subnets,
    );
    expect(one.map((r) => r.deviceId)).toEqual(['a', 'c', 'b']);
    expect(two.map((r) => r.deviceId)).toEqual(['a', 'c', 'b']);
  });

  it('treats a bare-IP profile target as a /32 and ignores unparseable entries', () => {
    const ranked = rankDiscoveryAgentCandidates(
      [cand('a', ['10.0.0.9']), cand('b', ['192.168.1.20', 'not-an-ip'])],
      ['garbage', '192.168.1.20'],
    );
    expect(ranked[0]!.deviceId).toBe('b');
    expect(ranked[0]!.subnetMatch).toBe(true);
  });

  it('matches IPv6 targets within the same family only', () => {
    const ranked = rankDiscoveryAgentCandidates(
      [cand('a', ['192.168.1.1']), cand('b', ['2001:db8::10'])],
      ['2001:db8::/64'],
    );
    expect(ranked.map((r) => [r.deviceId, r.subnetMatch])).toEqual([['b', true], ['a', false]]);
  });

  it('returns an empty list for no candidates', () => {
    expect(rankDiscoveryAgentCandidates([], ['10.0.0.0/8'])).toEqual([]);
  });
});

describe('loadSiteDiscoveryAgentCandidates', () => {
  beforeEach(() => {
    selectQueue.length = 0;
    mockDb.select.mockClear();
  });

  it('attaches each device\'s known interface addresses and skips the address query when no device is online', async () => {
    selectQueue.push(
      [
        { deviceId: 'd1', agentId: 'a1', hostname: 'h1', displayName: null },
        { deviceId: 'd2', agentId: 'a2', hostname: 'h2', displayName: 'Front desk' },
      ],
      [
        { deviceId: 'd1', ipAddress: '10.0.0.1' },
        { deviceId: 'd1', ipAddress: '192.168.1.5' },
        { deviceId: 'd2', ipAddress: null },
      ],
    );
    const candidates = await loadSiteDiscoveryAgentCandidates('org-1', 'site-1');
    expect(candidates).toEqual([
      { deviceId: 'd1', agentId: 'a1', label: 'h1', addresses: ['10.0.0.1', '192.168.1.5'] },
      { deviceId: 'd2', agentId: 'a2', label: 'Front desk', addresses: [] },
    ]);

    selectQueue.push([]);
    expect(await loadSiteDiscoveryAgentCandidates('org-1', 'site-1')).toEqual([]);
    expect(mockDb.select).toHaveBeenCalledTimes(3);
  });
});

describe('resolvePinnedDiscoveryAgent (#7969 — no silent fallback)', () => {
  const ONLINE = {
    deviceId: 'dev-1', agentId: 'agent-1', hostname: 'scanner-01', displayName: null,
    orgId: 'org-1', siteId: 'site-1', status: 'online', isEphemeral: false,
  };

  beforeEach(() => {
    selectQueue.length = 0;
  });

  it('resolves an online pinned device in the profile site to its agent', async () => {
    selectQueue.push([ONLINE]);
    await expect(resolvePinnedDiscoveryAgent('dev-1', 'org-1', 'site-1')).resolves.toEqual({
      ok: true, agentId: 'agent-1', label: 'scanner-01',
    });
  });

  it('fails naming the agent when the pinned device is offline', async () => {
    selectQueue.push([{ ...ONLINE, status: 'offline' }]);
    const result = await resolvePinnedDiscoveryAgent('dev-1', 'org-1', 'site-1');
    expect(result).toEqual({ ok: false, agentId: 'agent-1', message: expect.stringContaining('scanner-01') });
    expect(result.ok ? '' : result.message).toMatch(/offline/i);
    expect(result.ok ? '' : result.message).toMatch(/not run from any other agent/i);
  });

  it('fails when the pinned device moved to another site', async () => {
    selectQueue.push([{ ...ONLINE, siteId: 'site-2' }]);
    const result = await resolvePinnedDiscoveryAgent('dev-1', 'org-1', 'site-1');
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toMatch(/site/i);
  });

  it('fails when the pinned device belongs to another organization', async () => {
    selectQueue.push([{ ...ONLINE, orgId: 'org-2' }]);
    const result = await resolvePinnedDiscoveryAgent('dev-1', 'org-1', 'site-1');
    expect(result).toEqual({ ok: false, agentId: null, message: expect.stringMatching(/organization/i) });
  });

  it('fails when the pinned device is missing, parked or ephemeral', async () => {
    selectQueue.push([]);
    const missing = await resolvePinnedDiscoveryAgent('dev-1', 'org-1', 'site-1');
    expect(missing).toEqual({ ok: false, agentId: null, message: expect.stringMatching(/no longer available/i) });

    selectQueue.push([{ ...ONLINE, isEphemeral: true }]);
    const ephemeral = await resolvePinnedDiscoveryAgent('dev-1', 'org-1', 'site-1');
    expect(ephemeral.ok).toBe(false);
  });

  it('fails when the pinned device has no agent id', async () => {
    selectQueue.push([{ ...ONLINE, agentId: null }]);
    const result = await resolvePinnedDiscoveryAgent('dev-1', 'org-1', 'site-1');
    expect(result.ok).toBe(false);
  });
});
