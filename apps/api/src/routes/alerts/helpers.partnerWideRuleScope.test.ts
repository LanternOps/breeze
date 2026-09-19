import { beforeEach, describe, expect, it, vi } from 'vitest';

// #4952 — getAlertRuleWithOrgCheck granted access to a partner-wide alert rule
// (org_id NULL, #2128) on `rule.partnerId === auth.partnerId` alone. Org tokens
// carry a partnerId too (`middleware/auth.ts` feeds it into
// DbAccessContext.currentPartnerId), so every by-id alert-rule path — GET
// /alerts/rules/:id, POST /alerts/rules/:id/test, and the PUT/PATCH/DELETE
// gates that load through this helper — disclosed the partner's partner-wide
// rules to plain org users.
//
// Before the partner-wide SELECT branch landed, RLS hid those rows from an org
// context and masked the app-layer bug. The branch makes them readable, so the
// scope gate is now the whole control. It also makes the by-id paths agree with
// GET /alerts/rules, whose partner-wide arm is already partner-scope only.

const selectMock = vi.fn();
vi.mock('../../db', () => ({
  db: { select: (...args: unknown[]) => selectMock(...args) },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({
  alertRules: { id: 'id', orgId: 'orgId', partnerId: 'partnerId' },
  alertTemplates: {},
  alerts: {},
  devices: {},
  notificationChannels: {},
  escalationPolicies: {},
  organizations: { id: 'id', partnerId: 'partnerId' },
  partners: { id: 'id' },
}));

vi.mock('../../middleware/auth', () => ({ siteAccessCheck: vi.fn(() => true) }));
vi.mock('../../services/alertConditions', () => ({ retiredConditionTypeError: vi.fn(() => null) }));
vi.mock('../../services/notificationSenders', () => ({
  validateEmailConfig: vi.fn(),
  validateWebhookConfig: vi.fn(),
  validateSmsConfig: vi.fn(),
  validatePagerDutyConfig: vi.fn(),
  validatePushoverConfig: vi.fn(),
}));

import { getAlertRuleWithOrgCheck } from './helpers';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';
const OTHER_PARTNER_ID = '44444444-4444-4444-4444-444444444444';
const RULE_ID = '5d4c3b2a-1111-4222-8333-444455556666';

const PARTNER_WIDE_RULE = { id: RULE_ID, orgId: null, partnerId: PARTNER_ID, name: 'Partner-wide rule' };
const ORG_OWNED_RULE = { id: RULE_ID, orgId: ORG_ID, partnerId: null, name: 'Org rule' };

function returnRule(rule: unknown) {
  selectMock.mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    const step = () => chain;
    chain.from = step;
    chain.where = step;
    chain.limit = () => Promise.resolve(rule ? [rule] : []);
    return chain;
  });
}

/** An org token: real partnerId, org scope, org-only canAccessOrg. */
const orgAuth = {
  scope: 'organization',
  partnerId: PARTNER_ID,
  canAccessOrg: (orgId: string) => orgId === ORG_ID,
};

beforeEach(() => {
  selectMock.mockReset();
});

describe('getAlertRuleWithOrgCheck partner-wide scope gate (#4952)', () => {
  it('hides a partner-wide rule from an ORG token that carries the same partnerId', async () => {
    returnRule(PARTNER_WIDE_RULE);
    await expect(getAlertRuleWithOrgCheck(RULE_ID, orgAuth)).resolves.toBeNull();
  });

  it('hides a partner-wide rule from a PARTNER token of a different partner', async () => {
    returnRule(PARTNER_WIDE_RULE);
    await expect(
      getAlertRuleWithOrgCheck(RULE_ID, {
        scope: 'partner',
        partnerId: OTHER_PARTNER_ID,
        canAccessOrg: () => true,
      })
    ).resolves.toBeNull();
  });

  it('returns a partner-wide rule to a PARTNER token of the owning partner', async () => {
    returnRule(PARTNER_WIDE_RULE);
    await expect(
      getAlertRuleWithOrgCheck(RULE_ID, {
        scope: 'partner',
        partnerId: PARTNER_ID,
        canAccessOrg: () => true,
      })
    ).resolves.toEqual(PARTNER_WIDE_RULE);
  });

  it('returns a partner-wide rule to a SYSTEM token', async () => {
    returnRule(PARTNER_WIDE_RULE);
    await expect(
      getAlertRuleWithOrgCheck(RULE_ID, { scope: 'system', partnerId: null, canAccessOrg: () => true })
    ).resolves.toEqual(PARTNER_WIDE_RULE);
  });

  it('still returns an ORG-OWNED rule to the owning org token', async () => {
    returnRule(ORG_OWNED_RULE);
    await expect(getAlertRuleWithOrgCheck(RULE_ID, orgAuth)).resolves.toEqual(ORG_OWNED_RULE);
  });

  it('returns null when the rule does not exist', async () => {
    returnRule(null);
    await expect(getAlertRuleWithOrgCheck(RULE_ID, orgAuth)).resolves.toBeNull();
  });
});
