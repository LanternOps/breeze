import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { BreezeEvent } from '../eventBus';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  captureException: vi.fn(),
  withSystem: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../../db', () => ({ db: { select: mocks.select }, withSystemDbAccessContext: mocks.withSystem }));
vi.mock('../sentry', () => ({ captureException: mocks.captureException }));

import { buildAlertWebhookProjections, alertWebhookUrl, __resetAlertUrlWarningForTests } from './alertEnrichment';

const ALERT = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';
const PARTNER = '44444444-4444-4444-8444-444444444444';
const SITE = '55555555-5555-4555-8555-555555555555';
const NOW = '2027-01-12T12:00:00.000Z';
const row = {
  alertId: ALERT, ruleId: null, monitorId: null, deviceId: DEVICE, episodeId: null,
  status: 'suppressed', severity: 'high', title: 'Row title', message: 'Row message',
  triggeredAt: new Date('2027-01-01T01:00:00.000Z'), acknowledgedAt: null, resolvedAt: null,
  deviceHostname: 'server-1', siteId: SITE, siteName: 'Main office', orgName: 'Example customer',
  partnerId: PARTNER, subjectKey: null, resolutionNote: null, resolvedBy: null,
  resolutionReason: null, acknowledgedBy: null, suppressedUntil: null,
};

function event(type: BreezeEvent['type'] = 'alert.triggered', payload: Record<string, unknown> = {}): BreezeEvent {
  return { id: 'event-1', type, orgId: ORG, source: 'test', priority: 'normal', metadata: { timestamp: NOW }, payload: { alertId: ALERT, deviceId: DEVICE, ...payload } };
}
const queries: { from?: unknown; joins: unknown[][]; where?: unknown; order?: unknown[]; selection?: unknown }[] = [];
function rows(first: unknown[] = [row], links: unknown[] = [{ system: 'connectwise', externalId: 'company-7' }]) {
  const results = [first, links];
  mocks.select.mockImplementation((selection: unknown) => {
    const query: typeof queries[number] = { joins: [], selection };
    queries.push(query);
    const result = results.shift() ?? [];
    const chain = {
      from: (table: unknown) => { query.from = table; return chain; },
      leftJoin: (...args: unknown[]) => { query.joins.push(args); return chain; },
      where: (predicate: unknown) => { query.where = predicate; return chain; },
      limit: () => chain,
      orderBy: (...args: unknown[]) => { query.order = args; return chain; },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
    };
    return chain;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  queries.length = 0;
  vi.stubEnv('DASHBOARD_URL', 'https://app.example.com/');
  vi.stubEnv('PUBLIC_APP_URL', '');
  __resetAlertUrlWarningForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  rows();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('alert webhook enrichment', () => {
  it.each([
    ['alert.triggered', 'active'], ['alert.acknowledged', 'acknowledged'],
    ['alert.resolved', 'resolved'], ['alert.suppressed', 'suppressed'],
  ] as const)('derives %s status from the event, never the row', async (type, status) => {
    expect((await buildAlertWebhookProjections(event(type))).org.status).toBe(status);
  });

  it('prefers payload values and timestamps over a stale row', async () => {
    const { org } = await buildAlertWebhookProjections(event('alert.resolved', {
      title: 'Payload title', severity: 'critical', triggeredAt: NOW, resolvedAt: NOW,
    }));
    expect(org).toMatchObject({ title: 'Payload title', severity: 'critical', triggeredAt: NOW, resolvedAt: NOW, status: 'resolved', enrichmentIncomplete: false });
  });

  it('falls back on wrong payload types and invalid timestamps', async () => {
    const { org } = await buildAlertWebhookProjections(event('alert.triggered', {
      title: 13, severity: 'urgent', triggeredAt: 'yesterday', resolvedAt: true, responsesOwner: 'yes',
    }));
    expect(org).toMatchObject({ title: row.title, severity: 'high', triggeredAt: row.triggeredAt.toISOString(), resolvedAt: null, responsesOwner: null });
  });

  it('keeps device enrichment when the alert is not yet visible', async () => {
    rows([{ ...row, alertId: null, title: null, severity: null, triggeredAt: null }]);
    const { org } = await buildAlertWebhookProjections(event('alert.triggered', { title: 'New alert' }));
    expect(org).toMatchObject({ alertId: ALERT, title: 'New alert', deviceHostname: 'server-1', siteId: SITE, siteName: 'Main office', enrichmentIncomplete: true });
  });

  it('allows absent device and site rows', async () => {
    rows([{ ...row, deviceHostname: null, siteId: null, siteName: null }]);
    expect((await buildAlertWebhookProjections(event())).org).toMatchObject({ deviceHostname: null, siteId: null, siteName: null, enrichmentIncomplete: false });
  });

  it('uses the alert topology site before the device site', async () => {
    rows([{ ...row, siteId: '66666666-6666-4666-8666-666666666666', siteName: 'Topology site' }]);
    const { org } = await buildAlertWebhookProjections(event());
    expect(org.siteId).toBe('66666666-6666-4666-8666-666666666666');
    const selection = queries[0]!.selection as Record<string, unknown>;
    expect(new PgDialect().sqlToQuery(sql`${selection.siteId}`).sql).toBe('COALESCE("alerts"."topology_site_id", "devices"."site_id")');
    const join = new PgDialect().sqlToQuery(queries[0]!.joins[2]![1] as never);
    expect(join.sql).toContain('COALESCE("alerts"."topology_site_id", "devices"."site_id")');
    expect(join.sql).toContain('"sites"."org_id" = "organizations"."id"');
  });

  it('scopes every join to the org and both axes of external links', async () => {
    await buildAlertWebhookProjections(event());
    const dialect = new PgDialect();
    const render = (value: unknown) => dialect.sqlToQuery(value as never);
    expect(render(queries[0]!.where)).toMatchObject({ sql: '"organizations"."id" = $1', params: [ORG] });
    expect(render(queries[0]!.joins[0]![1]).sql).toContain('"alerts"."org_id" = "organizations"."id"');
    expect(render(queries[0]!.joins[1]![1]).sql).toContain('"devices"."org_id" = "organizations"."id"');
    expect(render(queries[0]!.joins[1]![1]).params).toContain(DEVICE);
    expect(render(queries[1]!.where).params).toEqual([ORG, PARTNER]);
    expect(queries[1]!.order).toHaveLength(2);
    expect(mocks.withSystem).toHaveBeenCalled();
  });

  it('never passes invalid payload UUIDs to UUID joins', async () => {
    await buildAlertWebhookProjections(event('alert.triggered', { alertId: 'bad-alert', deviceId: 'bad-device' }));
    for (const join of queries[0]!.joins) {
      const { params } = new PgDialect().sqlToQuery(join[1] as never);
      expect(params).not.toContain('bad-alert');
      expect(params).not.toContain('bad-device');
    }
  });

  it('warns once and produces relative URLs without a configured base', async () => {
    vi.stubEnv('DASHBOARD_URL', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await buildAlertWebhookProjections(event())).org.alertUrl).toBe(`/alerts/${ALERT}`);
    rows();
    expect((await buildAlertWebhookProjections(event())).org.alertUrl).toBe(`/alerts/${ALERT}`);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(alertWebhookUrl('')).toBe('/alerts');
  });

  it('uses DASHBOARD_URL then PUBLIC_APP_URL and trims trailing slashes', () => {
    expect(alertWebhookUrl(ALERT)).toBe(`https://app.example.com/alerts/${ALERT}`);
    vi.stubEnv('DASHBOARD_URL', '');
    vi.stubEnv('PUBLIC_APP_URL', 'https://public.example.com///');
    expect(alertWebhookUrl(ALERT)).toBe(`https://public.example.com/alerts/${ALERT}`);
  });

  it('degrades a failed read to payload-only projections with one diagnostic', async () => {
    const error = Object.assign(new Error('database unavailable'), { code: '08006' });
    mocks.select.mockImplementation(() => { throw error; });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { org, partner } = await buildAlertWebhookProjections(event('alert.triggered', { title: 'Payload title' }));
    expect(org).toMatchObject({ alertId: ALERT, deviceId: DEVICE, title: 'Payload title', severity: null, deviceHostname: null, siteId: null, siteName: null, orgName: null, enrichmentIncomplete: true });
    expect(partner.orgExternalIds).toEqual([]);
    expect(mocks.captureException).toHaveBeenCalledExactlyOnceWith(error, undefined, expect.objectContaining({ errorId: 'WEBHOOK_ALERT_ENRICHMENT_FAILED', eventId: 'event-1', orgId: ORG, eventType: 'alert.triggered' }), { fingerprint: ['webhook-alert-enrichment-failed'] });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/^\[WebhookAlertEnrichment\] enrichment-failed \{/);
    expect(JSON.parse(String(log.mock.calls[0]![0]).split('enrichment-failed ')[1]!)).toMatchObject({ error: 'database unavailable', code: '08006' });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each([
    { reason: 'alert_id_invalid', alertId: 'not-a-uuid', found: [{ ...row, alertId: null }] },
    { reason: 'org_not_found', alertId: ALERT, found: [] },
    { reason: 'alert_not_visible', alertId: ALERT, found: [{ ...row, alertId: null }] },
  ])('warns once without Sentry when enrichment is incomplete: $reason', async ({ reason, alertId, found }) => {
    rows(found);
    const { org, partner } = await buildAlertWebhookProjections(event('alert.triggered', { alertId }));
    expect(org.enrichmentIncomplete).toBe(true);
    expect(partner.enrichmentIncomplete).toBe(true);
    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(`[WebhookAlertEnrichment] enrichment-incomplete ${JSON.stringify({
      errorId: 'WEBHOOK_ALERT_ENRICHMENT_INCOMPLETE', eventId: 'event-1', orgId: ORG, eventType: 'alert.triggered', reason,
    })}`);
  });

  it.each([undefined, null, 'invalid', 42, []].map((payload) => ({ payload })))('tolerates a missing or non-object payload ($payload)', async ({ payload }) => {
    rows([{ ...row, alertId: null, deviceId: null, title: null, severity: null, triggeredAt: null }]);
    const malformed = { ...event(), payload } as unknown as BreezeEvent;
    await expect(buildAlertWebhookProjections(malformed)).resolves.toMatchObject({
      org: { alertId: null, deviceId: null, title: null, enrichmentIncomplete: true, details: {}, alertUrl: 'https://app.example.com/alerts' },
    });
    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('"reason":"alert_id_invalid"'));
  });

  it('discards all enrichment if the external-link read fails', async () => {
    const firstSelect = mocks.select.getMockImplementation()!;
    mocks.select.mockImplementationOnce(firstSelect).mockImplementationOnce(() => { throw new Error('links failed'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { org, partner } = await buildAlertWebhookProjections(event());
    expect(org.orgName).toBeNull();
    expect(org.enrichmentIncomplete).toBe(true);
    expect(partner.orgExternalIds).toEqual([]);
  });

  it('keeps partner links out of the org projection', async () => {
    const { org, partner } = await buildAlertWebhookProjections(event());
    expect(org).not.toHaveProperty('orgExternalIds');
    expect(partner.orgExternalIds).toEqual([{ system: 'connectwise', externalId: 'company-7' }]);
    expect(Object.isFrozen(partner.orgExternalIds[0])).toBe(true);
  });

  it('skips external links for an organization without a partner', async () => {
    rows([{ ...row, partnerId: null }]);
    expect((await buildAlertWebhookProjections(event())).partner.orgExternalIds).toEqual([]);
    expect(mocks.select).toHaveBeenCalledTimes(1);
  });

  it.each(['org', 'partner'] as const)('deep freezes %s independently without freezing the source payload', async (side) => {
    const nested = { evidence: ['sample'] };
    const projections = await buildAlertWebhookProjections(event('alert.triggered', { vendorDetails: nested }));
    const selected = projections[side];
    const other = projections[side === 'org' ? 'partner' : 'org'];
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected.details)).toBe(true);
    expect(Object.isFrozen(selected.details.vendorDetails)).toBe(true);
    expect(Object.isFrozen(selected.externalTickets)).toBe(true);
    expect(selected.details).not.toBe(other.details);
    expect(selected.details.vendorDetails).not.toBe(other.details.vendorDetails);
    expect(selected.externalTickets).not.toBe(other.externalTickets);
    expect(() => selected.externalTickets.push({ source: 'x', externalId: 'y', externalUrl: null, externalNumber: null })).toThrow();
    expect(() => { (selected.details.vendorDetails as typeof nested).evidence.push('changed'); }).toThrow();
    expect(other.details.vendorDetails).toEqual(nested);
    nested.evidence.push('source still writable');
    expect(other.details.vendorDetails).toEqual({ evidence: ['sample'] });
  });
});
