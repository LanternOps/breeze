import { beforeEach, describe, expect, it, vi } from 'vitest';

// Each db.select() call takes the next queued outcome. The chain is thenable
// at every step, so `.where()` (awaited directly) and `.limit()` both resolve.
const queue: Array<{ rows?: unknown[]; error?: Error }> = [];

function chain(outcome: { rows?: unknown[]; error?: Error }) {
  const settle = () => (outcome.error ? Promise.reject(outcome.error) : Promise.resolve(outcome.rows ?? []));
  const node: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'innerJoin', 'limit', 'orderBy']) {
    node[method] = vi.fn(() => node);
  }
  node.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    settle().then(onFulfilled, onRejected);
  return node;
}

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => chain(queue.shift() ?? { rows: [] })),
  },
}));

vi.mock('../db/schema', () => ({
  configPolicyAssignments: {},
  configPolicyEffectiveFeatureLinks: {},
  configurationPolicies: {},
  deviceGroupMemberships: {},
  devices: {},
  organizations: {},
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn(() => ({})),
  asc: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
  inArray: vi.fn(() => ({})),
  or: vi.fn(() => ({})),
}));

vi.mock('./configPolicyOwnership', () => ({
  policyOwnershipCondition: vi.fn(() => ({})),
}));

const redis = { get: vi.fn(), set: vi.fn() };
vi.mock('./redis', () => ({ getRedis: vi.fn(() => redis) }));

import { buildHelperConfigUpdate } from './helperSettings';

/** No helper policy link matches, so the legacy org flag decides. */
function queueNoPolicyMatch() {
  queue.push(
    { rows: [{ orgId: 'org-1', siteId: 'site-1' }] }, // device
    { rows: [{ partnerId: 'partner-1' }] }, // org partner
    { rows: [] }, // group memberships
    { rows: [] }, // policy rows
  );
}

describe('buildHelperConfigUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queue.length = 0;
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
  });

  it('uses the org flag when no policy matches, and caches the result', async () => {
    queueNoPolicyMatch();
    queue.push({ rows: [{ settings: { helper: { enabled: true } } }] });

    const settings = await buildHelperConfigUpdate('dev-1', 'org-1');

    expect(settings.enabled).toBe(true);
    expect(redis.set).toHaveBeenCalledWith('helper:settings:device:dev-1', expect.any(String), 'EX', 120);
  });

  it('surfaces a failed org-flag read instead of reporting the Helper disabled', async () => {
    queueNoPolicyMatch();
    queue.push({ error: new Error('connection terminated') });

    await expect(buildHelperConfigUpdate('dev-1', 'org-1')).rejects.toThrow('connection terminated');
  });

  it('does not cache anything when the org-flag read fails', async () => {
    queueNoPolicyMatch();
    queue.push({ error: new Error('connection terminated') });

    await buildHelperConfigUpdate('dev-1', 'org-1').catch(() => undefined);

    expect(redis.set).not.toHaveBeenCalled();
  });

  it('does not cache anything when the policy resolution fails', async () => {
    queue.push({ error: new Error('connection terminated') });

    await expect(buildHelperConfigUpdate('dev-1', 'org-1')).rejects.toThrow('connection terminated');
    expect(redis.set).not.toHaveBeenCalled();
  });
});
