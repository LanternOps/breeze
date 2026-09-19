import { describe, it, expect, vi, beforeEach } from 'vitest';

const { selectQueue } = vi.hoisted(() => ({ selectQueue: [] as unknown[][] }));

// db.select() is consumed FIFO: device row, org row, group rows, then the
// effective-links join. Each chain resolves when awaited.
function chainable(rows: unknown[]) {
  const obj: any = {};
  for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'limit']) obj[m] = () => obj;
  obj.then = (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve);
  return obj;
}

vi.mock('../db', () => ({
  db: { select: vi.fn(() => chainable(selectQueue.shift() ?? [])) },
}));
vi.mock('../db/schema', () => ({
  devices: {}, organizations: {}, deviceGroupMemberships: {},
  configPolicyAssignments: {}, configurationPolicies: {},
  configPolicyEffectiveFeatureLinks: {},
}));
vi.mock('./configPolicyOwnership', () => ({ policyOwnershipCondition: vi.fn(() => undefined) }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { resolveEffectiveWarrantyInlineSettings } from './warrantyPolicyResolution';

const DEVICE_ID = '00000000-0000-4000-8000-000000000001';

function seed(linkRows: unknown[]) {
  selectQueue.length = 0;
  selectQueue.push([{ orgId: 'org-1', siteId: 'site-1' }]);   // device
  selectQueue.push([{ partnerId: 'partner-1' }]);              // org
  selectQueue.push([]);                                        // group memberships
  selectQueue.push(linkRows);                                  // effective links
}

describe('resolveEffectiveWarrantyInlineSettings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns undefined when the device does not resolve at all', async () => {
    selectQueue.length = 0;
    selectQueue.push([]);
    await expect(resolveEffectiveWarrantyInlineSettings(DEVICE_ID)).resolves.toBeUndefined();
  });

  it('returns undefined when no active warranty link is assigned', async () => {
    seed([]);
    await expect(resolveEffectiveWarrantyInlineSettings(DEVICE_ID)).resolves.toBeUndefined();
  });

  it('returns the nearest level\'s WHOLE inlineSettings, not a merge (contract D5)', async () => {
    seed([
      { inlineSettings: { enabled: true, warnDays: 90, hpCmsl: { enabled: true } }, level: 'organization', priority: 0 },
      { inlineSettings: { warnDays: 14 }, level: 'device', priority: 0 },
    ]);

    // The device-level link carries no hpCmsl block, so the org-level one is
    // DROPPED wholesale. This is the inheritance footgun the UI has to surface.
    await expect(resolveEffectiveWarrantyInlineSettings(DEVICE_ID)).resolves.toEqual({ warnDays: 14 });
  });

  it('breaks a same-level tie on descending assignment priority', async () => {
    seed([
      { inlineSettings: { warnDays: 1 }, level: 'site', priority: 0 },
      { inlineSettings: { warnDays: 2 }, level: 'site', priority: 5 },
    ]);
    await expect(resolveEffectiveWarrantyInlineSettings(DEVICE_ID)).resolves.toEqual({ warnDays: 2 });
  });

  it('ranks partner below organization', async () => {
    seed([
      { inlineSettings: { warnDays: 7 }, level: 'partner', priority: 99 },
      { inlineSettings: { warnDays: 8 }, level: 'organization', priority: 0 },
    ]);
    await expect(resolveEffectiveWarrantyInlineSettings(DEVICE_ID)).resolves.toEqual({ warnDays: 8 });
  });

  it('distinguishes a resolved-but-null blob from no policy at all', async () => {
    seed([{ inlineSettings: null, level: 'organization', priority: 0 }]);
    await expect(resolveEffectiveWarrantyInlineSettings(DEVICE_ID)).resolves.toBeNull();
  });
});
