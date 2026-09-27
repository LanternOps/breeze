import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same select-queue harness as notificationDispatcher.routingSites.test.ts:
// each `db.select()` chain resolves to the next queued array.
const { selectQueue, channelRows } = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  channelRows: [] as Array<{ id: string; orgId: string | null; partnerId: string | null; enabled: boolean }>,
}));
vi.mock('../../db', async () => {
  const { notificationChannels } = await import('../../db/schema');
  const makeSelect = () => {
    let isChannelRead = false;
    const chain: any = {
      from: (table: unknown) => { isChannelRead = table === notificationChannels; return chain; },
      where: () => chain, orderBy: () => chain, limit: () => chain,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(isChannelRead ? channelRows : selectQueue.shift() ?? []).then(resolve, reject),
    };
    return chain;
  };
  return { db: { select: vi.fn(() => makeSelect()) } };
});

// Channel metadata uses the ordinary SELECT mock, keyed by table.
import { orderRoutingRows, resolveDelivery, routingRuleMatches } from './resolveDelivery';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const SITE_A = '33333333-3333-4333-8333-333333333333';
const CH_ORG = 'aaaaaaaa-0000-4000-8000-000000000001';
const CH_PARTNER = 'aaaaaaaa-0000-4000-8000-000000000002';
const CH_MON = 'aaaaaaaa-0000-4000-8000-000000000003';
const ESC_MON = 'bbbbbbbb-0000-4000-8000-000000000001';
const ESC_ROW = 'bbbbbbbb-0000-4000-8000-000000000002';
const ESC_LEGACY = 'bbbbbbbb-0000-4000-8000-000000000003';

const orgLookup = () => [{ partnerId: PARTNER }];
const row = (over: Record<string, unknown>) => ({
  id: 'r-' + Math.random().toString(36).slice(2, 8), orgId: ORG, partnerId: null, name: 'row', priority: 10,
  conditions: {}, channelIds: [CH_ORG], enabled: true, escalationPolicyId: null, isDefault: false, ...over,
});
const monitor = (deliveryMode: string, over: Record<string, unknown> = {}) => [{
  kind: 'cpu', deliveryMode, deliveryChannelIds: [CH_MON], escalationPolicyId: ESC_MON, ...over,
}];

describe('routingRuleMatches', () => {
  it('matches an unconditioned row', () => {
    expect(routingRuleMatches({}, { severity: 'high', kind: null, siteId: null })).toBe(true);
  });
  it('filters on severity', () => {
    expect(routingRuleMatches({ severities: ['critical'] }, { severity: 'high', kind: null, siteId: null })).toBe(false);
  });
  it('fails closed on monitorKinds when the alert has no kind', () => {
    expect(routingRuleMatches({ monitorKinds: ['cpu'] }, { severity: 'high', kind: null, siteId: null })).toBe(false);
    expect(routingRuleMatches({ monitorKinds: ['cpu'] }, { severity: 'high', kind: 'cpu', siteId: null })).toBe(true);
  });
  it('fails closed on siteIds when the device site is unknown (unchanged semantics)', () => {
    expect(routingRuleMatches({ siteIds: [SITE_A] }, { severity: 'high', kind: null, siteId: null })).toBe(false);
    expect(routingRuleMatches({ siteIds: [SITE_A] }, { severity: 'high', kind: null, siteId: SITE_A })).toBe(true);
  });
  it('ignores unknown keys (conditionTypes/deviceTags left in old rows)', () => {
    expect(routingRuleMatches({ conditionTypes: ['x'] } as never, { severity: 'high', kind: null, siteId: null })).toBe(true);
  });
});

describe('orderRoutingRows', () => {
  it('orders non-default first, then priority, then org before partner', () => {
    const rows = [
      row({ id: 'd-org', isDefault: true, priority: 1000000 }),
      row({ id: 'p5', orgId: null, partnerId: PARTNER, priority: 5 }),
      row({ id: 'o5', priority: 5 }),
      row({ id: 'o1', priority: 1 }),
      row({ id: 'd-partner', isDefault: true, orgId: null, partnerId: PARTNER, priority: 1000000 }),
    ];
    expect(orderRoutingRows(rows).map((r) => r.id)).toEqual(['o1', 'o5', 'p5', 'd-org', 'd-partner']);
  });
});

describe('resolveDelivery precedence', () => {
  beforeEach(() => {
    selectQueue.length = 0;
    channelRows.splice(0, channelRows.length,
      { id: CH_ORG, orgId: ORG, partnerId: null, enabled: true },
      { id: CH_MON, orgId: ORG, partnerId: null, enabled: true },
      { id: CH_PARTNER, orgId: null, partnerId: PARTNER, enabled: true });
  });

  it('1. monitor none → inbox only, no escalation even when the monitor names one', async () => {
    selectQueue.push(orgLookup(), monitor('none'));
    await expect(resolveDelivery({ orgId: ORG, severity: 'high', monitorId: 'm1' }))
      .resolves.toEqual({ skippedChannelIds: [], channelIds: [], escalationPolicyId: null, source: 'monitor_none' });
  });

  it('2. monitor channels → its channels + its escalation; routing rows never consulted', async () => {
    selectQueue.push(orgLookup(), monitor('channels'));
    const out = await resolveDelivery({ orgId: ORG, severity: 'high', monitorId: 'm1' });
    expect(out).toEqual({ skippedChannelIds: [], channelIds: [CH_MON], escalationPolicyId: ESC_MON, source: 'monitor_channels' });
    expect(selectQueue).toHaveLength(0);
  });

  it.each(['routing_rule', 'default_row', 'none'] as const)(
    'does not inherit legacy escalation in the %s result', async source => {
      selectQueue.push(orgLookup(), source === 'none' ? [] : [row({
        id: 'retirement-row', isDefault: source === 'default_row', channelIds: [CH_ORG], escalationPolicyId: null,
      })]);
      // @ts-expect-error the public legacyOverride input is retired
      const out = await resolveDelivery({ orgId: ORG, severity: 'high', legacyOverride: { escalationPolicyId: ESC_MON } });
      expect(out).toMatchObject({ source, escalationPolicyId: null, skippedChannelIds: [] });
    },
  );
  it.each([{ channelIds: [] }, { channelIds: [CH_PARTNER] }])('ignores stale legacy channel overrides %j', async ({ channelIds }) => {
    selectQueue.push(orgLookup(), [row({ channelIds: [CH_ORG] })]);
    // @ts-expect-error removed from the public API
    const out = await resolveDelivery({ orgId: ORG, severity: 'high', legacyOverride: { channelIds } });
    expect(out.channelIds).toEqual([CH_ORG]);
    expect(out.skippedChannelIds).toEqual([]);
  });

  it.each(['routing_rule', 'default_row', 'none'] as const)(
    'keeps monitor escalation ahead of the %s fallback', async source => {
      selectQueue.push(orgLookup(), monitor('inherit'), source === 'none' ? [] : [row({
        isDefault: source === 'default_row', escalationPolicyId: ESC_ROW,
      })]);
      expect(await resolveDelivery({ orgId: ORG, severity: 'high', monitorId: 'm1' }))
        .toMatchObject({ source, escalationPolicyId: ESC_MON, skippedChannelIds: [] });
    },
  );

  it('4. first matching non-default row wins; org row beats partner row at equal priority; row escalation used', async () => {
    selectQueue.push(orgLookup(), [
      row({ id: 'partner5', orgId: null, partnerId: PARTNER, priority: 5, channelIds: [CH_PARTNER] }),
      row({ id: 'org5', priority: 5, escalationPolicyId: ESC_ROW }),
      row({ id: 'org1-wrong-sev', priority: 1, conditions: { severities: ['critical'] } }),
    ]);
    const out = await resolveDelivery({ orgId: ORG, severity: 'high' });
    expect(out).toEqual({ skippedChannelIds: [], channelIds: [CH_ORG], escalationPolicyId: ESC_ROW, source: 'routing_rule', routingRuleId: 'org5', routingRuleName: 'row' });
  });

  it('4b. monitorKinds row matches only the monitor kind (kind taken from the monitor row when not supplied)', async () => {
    selectQueue.push(orgLookup(), monitor('inherit', { escalationPolicyId: null }), [
      row({ id: 'disk-only', conditions: { monitorKinds: ['disk'] } }),
      row({ id: 'cpu', conditions: { monitorKinds: ['cpu'] }, channelIds: [CH_PARTNER] }),
    ]);
    const out = await resolveDelivery({ orgId: ORG, severity: 'high', monitorId: 'm1' });
    expect(out).toMatchObject({ source: 'routing_rule', routingRuleId: 'cpu', channelIds: [CH_PARTNER] });
  });

  it('5. no match → org default row before partner default row; empty channels mean inbox only', async () => {
    selectQueue.push(orgLookup(), [
      row({ id: 'd-partner', isDefault: true, orgId: null, partnerId: PARTNER, priority: 1000000, channelIds: [CH_PARTNER] }),
      row({ id: 'd-org', isDefault: true, priority: 1000000, channelIds: [], escalationPolicyId: ESC_ROW }),
      row({ id: 'crit', conditions: { severities: ['critical'] } }),
    ]);
    const out = await resolveDelivery({ orgId: ORG, severity: 'low' });
    expect(out).toEqual({ skippedChannelIds: [], channelIds: [], escalationPolicyId: ESC_ROW, source: 'default_row', routingRuleId: 'd-org', routingRuleName: 'row' });
  });

  it('5b. partner default row applies when the org has none', async () => {
    selectQueue.push(orgLookup(), [row({ id: 'd-partner', isDefault: true, orgId: null, partnerId: PARTNER, priority: 1000000, channelIds: [CH_PARTNER] })]);
    await expect(resolveDelivery({ orgId: ORG, severity: 'low' }))
      .resolves.toMatchObject({ channelIds: [CH_PARTNER], source: 'default_row', routingRuleId: 'd-partner' });
  });

  it.each([true, false])('foreign visible=%s has the same unavailable result as missing', async visible => {
    selectQueue.push(orgLookup(), [row({ channelIds: [CH_ORG, CH_PARTNER, CH_MON], escalationPolicyId: ESC_ROW })]);
    channelRows.splice(0, channelRows.length,
      { id: CH_ORG, orgId: ORG, partnerId: null, enabled: false },
      ...(visible ? [{ id: CH_PARTNER, orgId: null, partnerId: SITE_A, enabled: false }] : []));
    expect(await resolveDelivery({ orgId: ORG, severity: 'high' })).toMatchObject({
      channelIds: [], escalationPolicyId: ESC_ROW, source: 'routing_rule',
      skippedChannelIds: [{ id: CH_ORG, reason: 'disabled' }, { id: CH_PARTNER, reason: 'unavailable' }, { id: CH_MON, reason: 'unavailable' }],
    });
  });

  it('rejects sibling-org channels even when their partner matches, and emits no skip for eligible IDs', async () => {
    selectQueue.push(orgLookup(), [row({ channelIds: [CH_ORG, CH_PARTNER, CH_MON] })]);
    channelRows.splice(0, channelRows.length,
      { id: CH_ORG, orgId: SITE_A, partnerId: PARTNER, enabled: true },
      { id: CH_PARTNER, orgId: null, partnerId: PARTNER, enabled: true },
      { id: CH_MON, orgId: ORG, partnerId: null, enabled: true });
    expect(await resolveDelivery({ orgId: ORG, severity: 'high' })).toMatchObject({
      channelIds: [CH_PARTNER, CH_MON], skippedChannelIds: [{ id: CH_ORG, reason: 'unavailable' }],
    });
  });

  it('marks a missing routed channel unavailable and excludes it', async () => {
    selectQueue.push(orgLookup(), [row({ channelIds: [CH_ORG] })]);
    channelRows.splice(0, channelRows.length);
    expect(await resolveDelivery({ orgId: ORG, severity: 'high' })).toMatchObject({
      channelIds: [], skippedChannelIds: [{ id: CH_ORG, reason: 'unavailable' }],
    });
  });

  it('marks a disabled request-org channel disabled and excludes it', async () => {
    selectQueue.push(orgLookup(), [row({ channelIds: [CH_ORG] })]);
    channelRows.splice(0, channelRows.length,
      { id: CH_ORG, orgId: ORG, partnerId: null, enabled: false });
    expect(await resolveDelivery({ orgId: ORG, severity: 'high' })).toMatchObject({
      channelIds: [], skippedChannelIds: [{ id: CH_ORG, reason: 'disabled' }],
    });
  });

  it('checks ownership before enabled state so a disabled foreign-org channel is unavailable, not disabled', async () => {
    selectQueue.push(orgLookup(), [row({ channelIds: [CH_ORG] })]);
    channelRows.splice(0, channelRows.length,
      { id: CH_ORG, orgId: SITE_A, partnerId: PARTNER, enabled: false });
    expect(await resolveDelivery({ orgId: ORG, severity: 'high' })).toMatchObject({
      channelIds: [], skippedChannelIds: [{ id: CH_ORG, reason: 'unavailable' }],
    });
  });

  it('exposes the legacy-kind to CPU route delta for W05c1 equivalence checks (D6)', async () => {
    const routes = [row({ id: 'cpu-route', conditions: { monitorKinds: ['cpu'] }, channelIds: [CH_ORG], escalationPolicyId: ESC_ROW }),
      row({ id: 'default', isDefault: true, channelIds: [CH_PARTNER], escalationPolicyId: ESC_LEGACY })];
    selectQueue.push(orgLookup(), routes, orgLookup(), routes);
    const before = await resolveDelivery({ orgId: ORG, severity: 'high', kind: null });
    const after = await resolveDelivery({ orgId: ORG, severity: 'high', kind: 'cpu' });
    expect(before).toMatchObject({ channelIds: [CH_PARTNER], escalationPolicyId: ESC_LEGACY });
    expect(after).toMatchObject({ channelIds: [CH_ORG], escalationPolicyId: ESC_ROW });
  });

  it('6. nothing configured → none (fresh install)', async () => {
    selectQueue.push([{ partnerId: null }], []);
    await expect(resolveDelivery({ orgId: ORG, severity: 'low' }))
      .resolves.toEqual({ skippedChannelIds: [], channelIds: [], escalationPolicyId: null, source: 'none' });
  });
});
