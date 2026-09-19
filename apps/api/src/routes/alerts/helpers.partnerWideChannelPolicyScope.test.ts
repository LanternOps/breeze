import { beforeEach, describe, expect, it, vi } from 'vitest';

// Sweep 2026-09-08 (G6-4) — getNotificationChannelWithOrgCheck and
// getEscalationPolicyWithOrgCheck granted access to a partner-wide row
// (org_id NULL, #2130) on `row.partnerId === auth.partnerId` alone, with no
// `auth.scope === 'partner'` gate. Org tokens carry a partnerId too
// (`middleware/auth.ts` feeds it into DbAccessContext.currentPartnerId), so
// every by-id path through these helpers — the PUT/DELETE/test gates in
// channels.ts and the PUT/DELETE gates in policies.ts — disclosed the
// existence of the partner's partner-wide channels/policies to plain org
// users (a 403 "requires full partner org access" instead of a 404 "not
// found").
//
// This mirrors the #4952 fix already applied to getAlertRuleWithOrgCheck
// (helpers.partnerWideRuleScope.test.ts): use the shared canReadPartnerWideRows
// gate instead of an inline `!!auth.partnerId && row.partnerId === auth.partnerId`
// check. partnerWideAccess.ts is a dependency-free leaf and intentionally NOT
// mocked (per CLAUDE.md / the repo's app-layer-gate testing convention).

const selectMock = vi.fn();
vi.mock('../../db', () => ({
  db: { select: (...args: unknown[]) => selectMock(...args) },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({
  alertRules: {},
  alertTemplates: {},
  alerts: {},
  devices: {},
  notificationChannels: { id: 'id', orgId: 'orgId', partnerId: 'partnerId' },
  escalationPolicies: { id: 'id', orgId: 'orgId', partnerId: 'partnerId' },
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

import { getNotificationChannelWithOrgCheck, getEscalationPolicyWithOrgCheck } from './helpers';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';
const OTHER_PARTNER_ID = '44444444-4444-4444-4444-444444444444';
const ROW_ID = '5d4c3b2a-1111-4222-8333-444455556666';

const PARTNER_WIDE_CHANNEL = { id: ROW_ID, orgId: null, partnerId: PARTNER_ID, name: 'Fleet Webhook' };
const ORG_OWNED_CHANNEL = { id: ROW_ID, orgId: ORG_ID, partnerId: null, name: 'Org Webhook' };
const PARTNER_WIDE_POLICY = { id: ROW_ID, orgId: null, partnerId: PARTNER_ID, name: 'Fleet Escalation' };
const ORG_OWNED_POLICY = { id: ROW_ID, orgId: ORG_ID, partnerId: null, name: 'Org Escalation' };

function returnRow(row: unknown) {
  selectMock.mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    const step = () => chain;
    chain.from = step;
    chain.where = step;
    chain.limit = () => Promise.resolve(row ? [row] : []);
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

describe.each([
  {
    label: 'getNotificationChannelWithOrgCheck',
    lookup: getNotificationChannelWithOrgCheck,
    partnerWideRow: PARTNER_WIDE_CHANNEL,
    orgOwnedRow: ORG_OWNED_CHANNEL,
  },
  {
    label: 'getEscalationPolicyWithOrgCheck',
    lookup: getEscalationPolicyWithOrgCheck,
    partnerWideRow: PARTNER_WIDE_POLICY,
    orgOwnedRow: ORG_OWNED_POLICY,
  },
])('$label partner-wide scope gate (sweep G6-4)', ({ lookup, partnerWideRow, orgOwnedRow }) => {
  it('hides a partner-wide row from an ORG token that carries the same partnerId', async () => {
    returnRow(partnerWideRow);
    await expect(lookup(ROW_ID, orgAuth)).resolves.toBeNull();
  });

  it('hides a partner-wide row from a PARTNER token of a different partner', async () => {
    returnRow(partnerWideRow);
    await expect(
      lookup(ROW_ID, { scope: 'partner', partnerId: OTHER_PARTNER_ID, canAccessOrg: () => true })
    ).resolves.toBeNull();
  });

  it('returns a partner-wide row to a PARTNER token of the owning partner', async () => {
    returnRow(partnerWideRow);
    await expect(
      lookup(ROW_ID, { scope: 'partner', partnerId: PARTNER_ID, canAccessOrg: () => true })
    ).resolves.toEqual(partnerWideRow);
  });

  it('returns a partner-wide row to a SYSTEM token', async () => {
    returnRow(partnerWideRow);
    await expect(
      lookup(ROW_ID, { scope: 'system', partnerId: null, canAccessOrg: () => true })
    ).resolves.toEqual(partnerWideRow);
  });

  it('still returns an ORG-OWNED row to the owning org token', async () => {
    returnRow(orgOwnedRow);
    await expect(lookup(ROW_ID, orgAuth)).resolves.toEqual(orgOwnedRow);
  });

  it('returns null when the row does not exist', async () => {
    returnRow(null);
    await expect(lookup(ROW_ID, orgAuth)).resolves.toBeNull();
  });
});
