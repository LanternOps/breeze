import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectQueue } = vi.hoisted(() => ({ selectQueue: [] as unknown[][] }));
vi.mock('../../middleware/auth', () => ({
  siteAccessCheck: (allowed?: string[]) => (siteId?: string | null) =>
    allowed === undefined || (!!siteId && allowed.includes(siteId)),
}));
vi.mock('../../db/schema', () => ({
  alertRules: { templateId: 'rule.templateId', orgId: 'rule.orgId', targetType: 'rule.targetType', targetId: 'rule.targetId', overrideSettings: 'rule.overrideSettings' },
  sites: { id: 'site.id', orgId: 'site.orgId' },
  devices: { id: 'device.id', orgId: 'device.orgId', siteId: 'device.siteId' },
  deviceGroups: { id: 'group.id', orgId: 'group.orgId', siteId: 'group.siteId' },
}));
vi.mock('../../db', () => {
  const chain: any = {};
  chain.from = () => chain;
  chain.where = () => Promise.resolve(selectQueue.shift() ?? []);
  return { db: { select: vi.fn(() => chain) } };
});

import {
  canAccessAlertRuleTargets,
  canAccessTemplateDependents,
  legacyRuleTarget,
} from './siteScope';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const ALLOWED_SITE = '22222222-2222-4222-8222-222222222222';
const HIDDEN_SITE = '33333333-3333-4333-8333-333333333333';

describe('alert-template site-scope helpers', () => {
  beforeEach(() => { vi.clearAllMocks(); selectQueue.length = 0; });

  it('normalizes legacy defaults and first concrete target deterministically', () => {
    expect(legacyRuleTarget(undefined, ORG_ID)).toEqual({ targetType: 'all', targetId: ORG_ID });
    expect(legacyRuleTarget({ scope: 'organization' }, ORG_ID)).toEqual({ targetType: 'org', targetId: ORG_ID });
    expect(legacyRuleTarget({ deviceIds: ['device-a', 'device-b'], siteIds: ['site-a'] }, ORG_ID))
      .toEqual({ targetType: 'device', targetId: 'device-a' });
  });

  it('denies org-wide, hidden, missing, and foreign targets while allowing an owned visible target', async () => {
    const restricted = { allowedSiteIds: [ALLOWED_SITE] };
    await expect(canAccessAlertRuleTargets(restricted as any, ORG_ID, 'org', [], true)).resolves.toBe(false);
    selectQueue.push([{ id: 'device-a', orgId: ORG_ID, siteId: HIDDEN_SITE }]);
    await expect(canAccessAlertRuleTargets(restricted as any, ORG_ID, 'device', ['device-a'], true)).resolves.toBe(false);
    selectQueue.push([]);
    await expect(canAccessAlertRuleTargets(restricted as any, ORG_ID, 'device', ['missing'], true)).resolves.toBe(false);
    selectQueue.push([{ id: 'foreign', orgId: 'another-org', siteId: ALLOWED_SITE }]);
    await expect(canAccessAlertRuleTargets(restricted as any, ORG_ID, 'device', ['foreign'], true)).resolves.toBe(false);
    selectQueue.push([{ id: 'device-a', orgId: ORG_ID, siteId: ALLOWED_SITE }]);
    await expect(canAccessAlertRuleTargets(restricted as any, ORG_ID, 'device', ['device-a'], true)).resolves.toBe(true);
    await expect(canAccessAlertRuleTargets({ allowedSiteIds: undefined } as any, ORG_ID, 'org', [], true)).resolves.toBe(true);
  });

  it('rejects a shared template when any dependent rule resolves outside the grant', async () => {
    selectQueue.push([
      { targetType: 'device', targetId: 'visible-device', overrideSettings: null },
      { targetType: 'device', targetId: 'hidden-device', overrideSettings: null },
    ]);
    selectQueue.push([{ id: 'visible-device', orgId: ORG_ID, siteId: ALLOWED_SITE }]);
    selectQueue.push([{ id: 'hidden-device', orgId: ORG_ID, siteId: HIDDEN_SITE }]);
    await expect(canAccessTemplateDependents(
      { allowedSiteIds: [ALLOWED_SITE] } as any, 'template-a', ORG_ID,
    )).resolves.toBe(false);
  });
});
