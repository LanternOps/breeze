import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Strix (PR #12184): a compliance rule the per-org probe cap leaves uncollected
 * is `pending`: no violation, no alert, no remediation. That is the owner's
 * decision (#12130), but it must never be silent. `policy.not_assessed` tells
 * the rule's OWNER: the partner's full-access staff for a partner-wide rule, the
 * org's policy managers for an org rule. One notice per rule, per org, per week,
 * however many devices and scans report it.
 */

const h = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  createNotification: vi.fn(),
  partnerUsers: vi.fn(),
  orgUsers: vi.fn(),
  redisSet: vi.fn(),
  redisDel: vi.fn(),
  redisExists: vi.fn(),
  redisAvailable: true,
  loadRule: vi.fn(),
  ruleReachesOrg: vi.fn(),
  persistedConfig: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => {
      const rows = h.selectQueue.shift() ?? [];
      const chain: Record<string, unknown> = {};
      const step = () => chain;
      chain.from = step;
      chain.where = step;
      chain.innerJoin = step;
      chain.leftJoin = step;
      chain.orderBy = step;
      chain.limit = () => Promise.resolve(rows);
      chain.then = (resolve: (v: unknown) => unknown) => resolve(rows);
      return chain;
    }),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./userNotifications', () => ({ createNotification: h.createNotification }));
vi.mock('./usersWithPermission', () => ({
  resolvePartnerUsersWithPermission: h.partnerUsers,
  resolveUsersWithPermissionForOrg: h.orgUsers,
}));
vi.mock('./redis', () => ({
  getRedis: () => (h.redisAvailable ? { set: h.redisSet, del: h.redisDel, exists: h.redisExists } : null),
}));
vi.mock('./configComplianceAlertBridge', () => ({
  isConfigCompliancePayload: (p: unknown) =>
    typeof (p as { configPolicyComplianceRuleId?: unknown })?.configPolicyComplianceRuleId === 'string',
  loadConfigComplianceEventRule: h.loadRule,
  configComplianceRuleReachesOrg: h.ruleReachesOrg,
  persistedConfigCompliance: h.persistedConfig,
}));

import { handlePolicyNotAssessedEvent, NOT_ASSESSED_NOTICE_PERIOD_MS } from './policyNotAssessedNotice';
import type { BreezeEvent } from './eventBus';
import * as dbModule from '../db';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const PARTNER_ID = '99999999-9999-4999-8999-999999999999';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const POLICY_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-11-18T12:00:00.000Z');

const capDetails = {
  ruleResults: [
    { ruleType: 'registry_check', passed: null, message: 'Not assessed', data: { outcome: 'not_collected', reason: 'probe_cap' } },
  ],
};

function event(payload: Record<string, unknown>, orgId = ORG_ID): BreezeEvent {
  return {
    id: 'evt-1',
    type: 'policy.not_assessed',
    orgId,
    source: 'test',
    priority: 'normal',
    timestamp: NOW.toISOString(),
    payload,
  } as unknown as BreezeEvent;
}

const automationPayload = {
  policyId: POLICY_ID,
  policyName: 'Partner baseline',
  deviceId: DEVICE_ID,
  hostname: 'WS-1',
  status: 'pending',
  reason: 'probe_cap',
  notAssessedRules: 3,
};

beforeEach(() => {
  vi.mocked(dbModule.db.select).mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  h.selectQueue.length = 0;
  h.createNotification.mockReset().mockResolvedValue('n-1');
  h.partnerUsers.mockReset().mockResolvedValue(['partner-admin-1', 'partner-admin-2']);
  h.orgUsers.mockReset().mockResolvedValue(['org-admin-1']);
  h.redisSet.mockReset().mockResolvedValue('OK');
  h.redisDel.mockReset().mockResolvedValue(1);
  h.redisExists.mockReset().mockResolvedValue(0);
  h.redisAvailable = true;
  h.loadRule.mockReset();
  h.ruleReachesOrg.mockReset().mockResolvedValue(true);
  h.persistedConfig.mockReset();
});

describe('policy.not_assessed → owner notice', () => {
  it('a partner-wide automation policy notifies the partner\'s full-access staff, not the org', async () => {
    h.selectQueue.push(
      [{ id: POLICY_ID, name: 'Partner baseline', orgId: null, partnerId: PARTNER_ID }],
      [{ name: 'Contoso', partnerId: PARTNER_ID }],
      [{ details: capDetails }],
    );

    await handlePolicyNotAssessedEvent(event(automationPayload));

    expect(h.partnerUsers).toHaveBeenCalledWith(PARTNER_ID, { resource: 'devices', action: 'write' });
    expect(h.orgUsers).not.toHaveBeenCalled();
    expect(h.createNotification).toHaveBeenCalledTimes(2);
    const notice = h.createNotification.mock.calls[0]![0];
    expect(notice).toMatchObject({
      userId: 'partner-admin-1',
      orgId: ORG_ID,
      type: 'system',
      priority: 'high',
      link: `/policies/${POLICY_ID}`,
      metadata: expect.objectContaining({ event: 'policy.not_assessed', reason: 'probe_cap', ownerScope: 'partner', policyId: POLICY_ID }),
    });
    expect(notice.title).toContain('Partner baseline');
    expect(notice.message).toContain('Contoso');
    expect(notice.message).toContain('probe list is full');
    // One key per (policy, org, week): never per device or per scan.
    const bucket = Math.floor(NOW.getTime() / NOT_ASSESSED_NOTICE_PERIOD_MS);
    expect(notice.dedupeKey).toBe(`policy-not-assessed:policy:${POLICY_ID}:${ORG_ID}:${bucket}`);
    expect(h.createNotification.mock.calls[1]![0].dedupeKey).toBe(notice.dedupeKey);
    expect(h.redisSet).toHaveBeenCalledWith(notice.dedupeKey, '1', 'EX', expect.any(Number), 'NX');
  });

  it('an org-owned automation policy notifies the org\'s policy managers', async () => {
    h.selectQueue.push(
      [{ id: POLICY_ID, name: 'Org baseline', orgId: ORG_ID, partnerId: null }],
      [{ name: 'Contoso', partnerId: PARTNER_ID }],
      [{ details: capDetails }],
    );

    await handlePolicyNotAssessedEvent(event(automationPayload));

    expect(h.orgUsers).toHaveBeenCalledWith(ORG_ID, { resource: 'devices', action: 'write' });
    expect(h.partnerUsers).not.toHaveBeenCalled();
    expect(h.createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'org-admin-1',
      orgId: ORG_ID,
      metadata: expect.objectContaining({ ownerScope: 'organization' }),
    }));
  });

  it('a later device or scan in the same week notifies nobody again', async () => {
    h.redisSet.mockResolvedValue(null); // marker already set
    h.selectQueue.push(
      [{ id: POLICY_ID, name: 'Partner baseline', orgId: null, partnerId: PARTNER_ID }],
      [{ name: 'Contoso', partnerId: PARTNER_ID }],
      [{ details: capDetails }],
    );

    await handlePolicyNotAssessedEvent(event(automationPayload));

    expect(h.partnerUsers).not.toHaveBeenCalled();
    expect(h.createNotification).not.toHaveBeenCalled();
  });

  it('without Redis it still notifies, bounded by the notification dedupe key', async () => {
    h.redisAvailable = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.selectQueue.push(
      [{ id: POLICY_ID, name: 'Partner baseline', orgId: null, partnerId: PARTNER_ID }],
      [{ name: 'Contoso', partnerId: PARTNER_ID }],
      [{ details: capDetails }],
    );

    await handlePolicyNotAssessedEvent(event(automationPayload));

    expect(h.createNotification).toHaveBeenCalledTimes(2);
    expect(h.createNotification.mock.calls[0]![0].dedupeKey).toMatch(/^policy-not-assessed:policy:/);
    warn.mockRestore();
  });

  it('acts on the persisted row: a rule that is assessed again by now notifies nobody', async () => {
    h.selectQueue.push(
      [{ id: POLICY_ID, name: 'Partner baseline', orgId: null, partnerId: PARTNER_ID }],
      [{ name: 'Contoso', partnerId: PARTNER_ID }],
      [{ details: { ruleResults: [{ ruleType: 'registry_check', passed: false, message: 'mismatch', data: { outcome: 'mismatched' } }] } }],
    );

    await handlePolicyNotAssessedEvent(event(automationPayload));

    expect(h.redisSet).not.toHaveBeenCalled();
    expect(h.createNotification).not.toHaveBeenCalled();
  });

  it('a partner-wide policy of another partner is dropped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.selectQueue.push(
      [{ id: POLICY_ID, name: 'Other partner', orgId: null, partnerId: 'another-partner' }],
      [{ name: 'Contoso', partnerId: PARTNER_ID }],
    );

    await handlePolicyNotAssessedEvent(event(automationPayload));

    expect(h.createNotification).not.toHaveBeenCalled();
    expect(h.partnerUsers).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('an org-owned policy of another org is dropped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.selectQueue.push(
      [{ id: POLICY_ID, name: 'Other org', orgId: 'another-org', partnerId: null }],
      [{ name: 'Contoso', partnerId: PARTNER_ID }],
    );

    await handlePolicyNotAssessedEvent(event(automationPayload));

    expect(h.createNotification).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // Events fire per device per scan; once the week's notice is out, a repeat
  // must cost one Redis read, not the policy, org and compliance-row queries.
  it('a repeat event whose week is already noticed does no database work', async () => {
    h.redisExists.mockResolvedValue(1);
    const bucket = Math.floor(NOW.getTime() / NOT_ASSESSED_NOTICE_PERIOD_MS);

    await handlePolicyNotAssessedEvent(event(automationPayload));

    expect(h.redisExists).toHaveBeenCalledWith(`policy-not-assessed:policy:${POLICY_ID}:${ORG_ID}:${bucket}`);
    expect(dbModule.db.select).not.toHaveBeenCalled();
    expect(h.createNotification).not.toHaveBeenCalled();
  });

  it('releases the marker when the notice transaction fails to commit', async () => {
    h.selectQueue.push(
      [{ id: POLICY_ID, name: 'Partner baseline', orgId: null, partnerId: PARTNER_ID }],
      [{ name: 'Contoso', partnerId: PARTNER_ID }],
      [{ details: capDetails }],
    );
    vi.mocked(dbModule.withSystemDbAccessContext).mockImplementationOnce(async (fn: () => Promise<unknown>) => {
      await fn();
      throw new Error('commit failed');
    });

    await expect(handlePolicyNotAssessedEvent(event(automationPayload))).rejects.toThrow('commit failed');
    expect(h.createNotification).toHaveBeenCalled();
    expect(h.redisDel).toHaveBeenCalledWith(h.redisSet.mock.calls[0]![0]);
  });

  it('ignores any other reason', async () => {
    await handlePolicyNotAssessedEvent(event({ ...automationPayload, reason: 'not_collectable' }));
    expect(h.createNotification).not.toHaveBeenCalled();
    expect(h.selectQueue).toHaveLength(0);
  });

  it('releases the week\'s marker when delivery fails, so the next event retries', async () => {
    h.createNotification.mockRejectedValueOnce(new Error('insert failed'));
    h.selectQueue.push(
      [{ id: POLICY_ID, name: 'Partner baseline', orgId: null, partnerId: PARTNER_ID }],
      [{ name: 'Contoso', partnerId: PARTNER_ID }],
      [{ details: capDetails }],
    );

    await expect(handlePolicyNotAssessedEvent(event(automationPayload))).rejects.toThrow('insert failed');
    expect(h.redisDel).toHaveBeenCalledWith(h.redisSet.mock.calls[0]![0]);
  });

  describe('configuration-policy compliance rules', () => {
    const FEATURE_LINK_ID = '44444444-4444-4444-8444-444444444444';
    const CONFIG_POLICY_ID = '55555555-5555-4555-8555-555555555555';
    const configPayload = {
      configPolicyComplianceRuleId: '66666666-6666-4666-8666-666666666666',
      configPolicyComplianceRuleName: 'Firewall on',
      configPolicyId: FEATURE_LINK_ID,
      deviceId: DEVICE_ID,
      hostname: 'WS-1',
      status: 'pending',
      reason: 'probe_cap',
      notAssessedRules: 1,
    };
    const rule = (policyOrgId: string | null) => ({
      id: configPayload.configPolicyComplianceRuleId,
      name: 'Firewall on',
      enforcementLevel: 'enforce',
      featureLinkId: FEATURE_LINK_ID,
      policyId: CONFIG_POLICY_ID,
      policyName: 'Partner security baseline',
      policyOrgId,
      policyPartnerId: policyOrgId ? null : PARTNER_ID,
    });

    it('a rule authored by a partner-wide policy notifies the partner and links its policy', async () => {
      h.loadRule.mockResolvedValue(rule(null));
      h.persistedConfig.mockResolvedValue({ status: 'pending', details: capDetails });
      h.selectQueue.push([{ name: 'Contoso', partnerId: PARTNER_ID }]);

      await handlePolicyNotAssessedEvent(event(configPayload));

      expect(h.ruleReachesOrg).toHaveBeenCalledWith(rule(null), ORG_ID);
      expect(h.persistedConfig).toHaveBeenCalledWith({ featureLinkId: FEATURE_LINK_ID, ruleName: 'Firewall on' }, DEVICE_ID);
      expect(h.partnerUsers).toHaveBeenCalledWith(PARTNER_ID, { resource: 'devices', action: 'write' });
      const notice = h.createNotification.mock.calls[0]![0];
      expect(notice).toMatchObject({
        link: `/configuration-policies/${CONFIG_POLICY_ID}`,
        metadata: expect.objectContaining({ ownerScope: 'partner', configPolicyId: CONFIG_POLICY_ID, featureLinkId: FEATURE_LINK_ID }),
      });
      expect(notice.title).toContain('Firewall on');
      expect(notice.dedupeKey).toMatch(new RegExp(`^policy-not-assessed:rule:${FEATURE_LINK_ID}:[0-9a-f]{32}:${ORG_ID}:\\d+$`));
    });

    it('a rule authored by an org policy notifies that org', async () => {
      h.loadRule.mockResolvedValue(rule(ORG_ID));
      h.persistedConfig.mockResolvedValue({ status: 'non_compliant', details: capDetails });
      h.selectQueue.push([{ name: 'Contoso', partnerId: PARTNER_ID }]);

      await handlePolicyNotAssessedEvent(event(configPayload));

      expect(h.orgUsers).toHaveBeenCalledWith(ORG_ID, { resource: 'devices', action: 'write' });
      expect(h.partnerUsers).not.toHaveBeenCalled();
    });

    it('a rule that no longer reaches the event org notifies nobody', async () => {
      h.loadRule.mockResolvedValue(rule(null));
      h.ruleReachesOrg.mockResolvedValue(false);

      await handlePolicyNotAssessedEvent(event(configPayload));

      expect(h.persistedConfig).not.toHaveBeenCalled();
      expect(h.createNotification).not.toHaveBeenCalled();
    });
  });
});
