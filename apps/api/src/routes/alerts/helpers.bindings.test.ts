import { describe, it, expect, vi, beforeEach } from 'vitest';

const selectMock = vi.fn();

vi.mock('../../db', () => ({
  db: { select: (...args: unknown[]) => selectMock(...(args as [])) },
  runOutsideDbContext: vi.fn((fn) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn())
}));

vi.mock('../../db/schema', () => ({
  organizations: { id: 'organizations.id', partnerId: 'organizations.partner_id' },
  partners: { id: 'partners.id', settings: 'partners.settings' },
  notificationChannels: { id: 'nc.id', orgId: 'nc.org_id', partnerId: 'nc.partner_id' },
  escalationPolicies: { id: 'ep.id', orgId: 'ep.org_id', partnerId: 'ep.partner_id' },
  alertRules: {}, alerts: {}, alertTemplates: {}, sites: {}, devices: {}
}));

import { validateAlertRuleNotificationBindings } from './helpers';

const ORG = '11111111-1111-1111-1111-111111111111';
const PARTNER = '99999999-9999-9999-9999-999999999999';
const CHANNEL = '22222222-2222-2222-2222-222222222222';

const chain = (rows: unknown[]) => {
  const c: Record<string, any> = {};
  for (const m of ['from', 'where', 'limit']) c[m] = vi.fn(() => Object.assign(Promise.resolve(rows), c));
  return Object.assign(Promise.resolve(rows), c);
};

describe('validateAlertRuleNotificationBindings — partner arm is caller-scope gated (#4956)', () => {
  beforeEach(() => selectMock.mockReset());

  it('org-scope caller: never resolves the org partner and matches on org ownership only', async () => {
    // Before the partner-wide SELECT branch (#4956) RLS hid partner-wide rails
    // from org tokens, so the OR arm was dead for them. Now it is live, and an
    // org admin could bind their MSP's shared rail to a rule they control.
    // CLAUDE.md "Partner-Wide First" step 3: app-layer dual-axis reads gate on
    // auth.scope === 'partner'.
    const channelsChain = chain([{ id: CHANNEL }]);
    selectMock.mockReturnValueOnce(channelsChain as never);

    const err = await validateAlertRuleNotificationBindings(
      ORG,
      { notificationChannelIds: [CHANNEL] } as never,
      'organization'
    );

    expect(err).toBeNull();
    expect(selectMock).toHaveBeenCalledTimes(1); // no organizations lookup
    const whereArg = channelsChain.where.mock.calls[0]![0];
    expect(JSON.stringify(whereArg)).not.toContain('nc.partner_id');
  });

  it('partner-scope caller: resolves the org partner and allows partner-wide rails', async () => {
    const orgChain = chain([{ partnerId: PARTNER }]);
    const channelsChain = chain([{ id: CHANNEL }]);
    selectMock.mockReturnValueOnce(orgChain as never).mockReturnValueOnce(channelsChain as never);

    const err = await validateAlertRuleNotificationBindings(
      ORG,
      { notificationChannelIds: [CHANNEL] } as never,
      'partner'
    );

    expect(err).toBeNull();
    expect(selectMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(channelsChain.where.mock.calls[0]![0])).toContain('nc.partner_id');
  });
});
