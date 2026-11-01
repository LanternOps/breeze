import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { BreezeEvent } from '../eventBus';
import { formatAlertSubject, type AlertSubjectSource } from '@breeze/shared';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  captureException: vi.fn(),
  listExternalTickets: vi.fn(),
  withSystem: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../../db', () => ({ db: { select: mocks.select }, withSystemDbAccessContext: mocks.withSystem }));
vi.mock('../alertExternalTickets', () => ({ listAlertExternalTickets: mocks.listExternalTickets }));
vi.mock('../sentry', () => ({ captureException: mocks.captureException }));
vi.mock('../alertSubject', () => ({
  enrichAlertSubjects: vi.fn(async (rows: Array<AlertSubjectSource & Record<string, unknown>>, options: { portal?: boolean } = {}) => {
    const { formatAlertSubject } = await import('@breeze/shared');
    return rows.map(row => ({ ...row, ...formatAlertSubject(row, row.ownerKind === 'backup_workload'
      ? { dataSources: ['m365_mail'], customerName: row.orgName } : undefined, options) }));
  }),
}));

import { enrichAlertSubjects } from '../alertSubject';
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
const queries: { from?: unknown; joins: unknown[][]; where?: unknown; order?: unknown[]; selection?: unknown; lock?: string }[] = [];
function rows(first: unknown[] = [row], links: unknown[] = [{ system: 'connectwise', externalId: 'company-7' }]) {
  const results = [first, ...((first[0] as { partnerId?: string } | undefined)?.partnerId ? [links] : [])];
  mocks.select.mockImplementation((selection: unknown) => {
    const query: typeof queries[number] = { joins: [], selection };
    queries.push(query);
    const result = results.shift() ?? [];
    const chain = {
      from: (table: unknown) => { query.from = table; return chain; },
      leftJoin: (...args: unknown[]) => { query.joins.push(args); return chain; },
      where: (predicate: unknown) => { query.where = predicate; return chain; },
      limit: () => chain,
      for: (strength: string) => { query.lock = strength; return chain; },
      orderBy: (...args: unknown[]) => { query.order = args; return chain; },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
    };
    return chain;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listExternalTickets.mockResolvedValue([]);
  queries.length = 0;
  vi.stubEnv('DASHBOARD_URL', 'https://app.example.com/');
  vi.stubEnv('PUBLIC_APP_URL', '');
  __resetAlertUrlWarningForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  rows();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('alert webhook enrichment', () => {
  it('uses the portal subject only on the org projection and the partner subject only on the partner projection', async () => {
    const enrich = vi.mocked(enrichAlertSubjects);
    enrich.mockImplementationOnce(async rows => rows.map(row => ({
      ...row, ...formatAlertSubject({ ...row, deviceName: 'Org-visible subject' }),
    })));
    enrich.mockImplementationOnce(async rows => rows.map(row => ({
      ...row, ...formatAlertSubject({ ...row, deviceName: 'Partner-visible subject' }),
    })));

    const { org, partner } = await buildAlertWebhookProjections(event());

    expect(enrich).toHaveBeenCalledTimes(2);
    expect(enrich.mock.calls.filter(([, options]) => options?.portal === true)).toHaveLength(1);
    expect(enrich).toHaveBeenNthCalledWith(1, [expect.objectContaining({ orgId: ORG })], { portal: true });
    expect(enrich.mock.calls.filter(call => call.length === 1)).toHaveLength(1);
    expect(enrich).toHaveBeenNthCalledWith(2, [expect.objectContaining({ orgId: ORG })]);
    expect(org).toMatchObject({ ownerLabel: 'Org-visible subject', subjectName: 'Org-visible subject' });
    expect(partner).toMatchObject({ ownerLabel: 'Partner-visible subject', subjectName: 'Partner-visible subject' });
  });

  it('adds a workload owner without moving existing producer keys out of details', async () => {
    const ref = '77777777-7777-4777-8777-777777777777';
    const owner = { kind: 'backup_workload', ref };
    const ownerKey = `backup_workload:${ref}`;
    rows([{ ...row, deviceId: null, deviceHostname: null, siteId: null, siteName: null,
      ownerKind: 'backup_workload', ownerRef: ref }]);
    const { org, partner } = await buildAlertWebhookProjections(event('alert.triggered', {
      deviceId: null, owner, ownerKey,
      ownerLabel: 'Microsoft 365 mail backup',
      subjectName: 'Microsoft 365 mail backup · Example customer',
    }));
    for (const projection of [org, partner]) {
      expect(projection).toMatchObject({
        deviceId: null, owner, ownerKind: 'backup_workload',
        ownerLabel: 'Microsoft 365 mail backup',
        subjectName: 'Microsoft 365 mail backup · Example customer',
        enrichmentIncomplete: false,
      });
      expect(projection.details).toMatchObject({ owner, ownerKey });
      expect(projection.subjectName).not.toContain('null');
    }
  });

  it('recovers a workload owner from the row on resolved events with no owner payload', async () => {
    const ref = '77777777-7777-4777-8777-777777777777';
    rows([{ ...row, deviceId: null, deviceHostname: null, siteId: null, siteName: null,
      ownerKind: 'backup_workload', ownerRef: ref }]);
    const { org } = await buildAlertWebhookProjections(event('alert.resolved', { deviceId: null }));
    expect(org).toMatchObject({ deviceId: null, owner: { kind: 'backup_workload', ref }, ownerKind: 'backup_workload' });
    const selection = queries[0]!.selection as Record<string, unknown>;
    const dialect = new PgDialect();
    expect(dialect.sqlToQuery(sql`${selection.ownerKind}`).sql).toBe('"alerts"."owner_kind"');
    expect(dialect.sqlToQuery(sql`${selection.ownerRef}`).sql).toBe('"alerts"."owner_ref"');
  });

  it('enriches a workload from its payload owner before the alert row is visible', async () => {
    const ref = '77777777-7777-4777-8777-777777777777';
    const owner = { kind: 'backup_workload', ref };
    rows([{ ...row, alertId: null, ownerKind: null, ownerRef: null, deviceId: null,
      deviceHostname: null, siteId: null, siteName: null }]);
    const { org } = await buildAlertWebhookProjections(event('alert.triggered', { deviceId: null, owner }));
    expect(org).toMatchObject({ owner, ownerKind: 'backup_workload', ownerLabel: 'Microsoft 365 mail backup',
      subjectName: 'Microsoft 365 mail backup · Example customer', enrichmentIncomplete: true });
  });

  it.each([
    ['alert.triggered', 'active'], ['alert.acknowledged', 'acknowledged'],
    ['alert.resolved', 'resolved'], ['alert.suppressed', 'suppressed'],
  ] as const)('derives %s status from the event, never the row', async (type, status) => {
    expect((await buildAlertWebhookProjections(event(type))).org.status).toBe(status);
  });

  // #10565: an escalation fires only while the alert is active; its step
  // fields are not v2 top-level keys, so they travel in `details`.
  it('projects alert.escalated as active with its step fields in details', async () => {
    const step = { escalationPolicyId: 'policy-1', escalationStep: 12, policyStep: 2, repeat: 1 };
    const { org } = await buildAlertWebhookProjections(event('alert.escalated', step));
    expect(org.status).toBe('active');
    expect(org.details).toMatchObject(step);
  });

  it('keeps partner integration data out of the org projection and freezes both four-key shapes', async () => {
    const orgMapping = { source: 'psa', partnerServicePrincipalId: null, externalId: 'org-99', externalUrl: null, externalNumber: null, state: 'open', createdAt: NOW, updatedAt: NOW };
    const partnerRef = { source: 'partner_api', partnerServicePrincipalId: SITE, externalId: '42', externalUrl: 'https://psa.example/42', externalNumber: 'INC-42', state: null, createdAt: NOW, updatedAt: NOW };
    const partnerMapping = { ...orgMapping, externalId: 'partner-99' };
    mocks.listExternalTickets.mockImplementation(async (_alert, viewer) => viewer === null
      ? [orgMapping] : [partnerRef, partnerMapping, orgMapping]);
    const { org, partner } = await buildAlertWebhookProjections(event());
    expect(mocks.listExternalTickets).toHaveBeenCalledWith(ALERT, null, { orgId: ORG });
    expect(mocks.listExternalTickets).toHaveBeenCalledWith(ALERT, PARTNER, { orgId: ORG });
    expect(org.externalTickets).toEqual([
      { source: 'psa', externalId: 'org-99', externalUrl: null, externalNumber: null },
    ]);
    expect(partner.externalTickets).toEqual([
      { source: 'partner_api', externalId: '42', externalUrl: 'https://psa.example/42', externalNumber: 'INC-42' },
      { source: 'psa', externalId: 'partner-99', externalUrl: null, externalNumber: null },
      { source: 'psa', externalId: 'org-99', externalUrl: null, externalNumber: null },
    ]);
    expect(Object.isFrozen(org.externalTickets[0])).toBe(true);
    expect(Object.isFrozen(partner.externalTickets[0])).toBe(true);
    expect(partner.externalTickets).not.toBe(org.externalTickets);
  });

  it.each(['alert.acknowledged', 'alert.resolved'] as const)('uses non-blocking MVCC reads for %s enrichment', async (type) => {
    const { org } = await buildAlertWebhookProjections(event(type));
    expect(org.enrichmentIncomplete).toBe(false);
    expect(queries.every(query => query.lock === undefined), 'enrichment must not lock the publisher’s alert row').toBe(true);
    expect(mocks.select).toHaveBeenCalledTimes(2); // Org/alert snapshot and org links only.
    expect(mocks.listExternalTickets).toHaveBeenCalledWith(ALERT, PARTNER, { orgId: ORG });
  });

  it('does not leak refs when the alert moved org after the initial enrichment read', async () => {
    // Initial join saw the event org; subsequent reference reads see a ref
    // restamped to another org. Enrichment must constrain those reads itself.
    const foreign = { orgId: SITE, source: 'partner_api', externalId: 'org-B-secret', externalUrl: null, externalNumber: null };
    mocks.listExternalTickets.mockImplementation(async (_alert, _partner, opts?: { orgId?: string }) =>
      opts?.orgId && opts.orgId !== foreign.orgId ? [] : [foreign]);
    const { org } = await buildAlertWebhookProjections(event());
    expect(org.externalTickets).toEqual([]);
    expect(mocks.listExternalTickets).toHaveBeenCalledWith(ALERT, PARTNER, { orgId: ORG });
  });

  it('does not read refs for an alert absent from its event organization', async () => {
    rows([{ ...row, alertId: null }]);
    expect((await buildAlertWebhookProjections(event())).org.externalTickets).toEqual([]);
    expect(mocks.listExternalTickets).not.toHaveBeenCalled();
  });

  it('prefers payload values and timestamps over a stale row', async () => {
    const { org } = await buildAlertWebhookProjections(event('alert.resolved', {
      title: 'Payload title', severity: 'critical', triggeredAt: NOW, resolvedAt: NOW,
    }));
    expect(org).toMatchObject({ title: 'Payload title', severity: 'critical', triggeredAt: NOW, resolvedAt: NOW, status: 'resolved', enrichmentIncomplete: false });
  });

  it('prefers principal ids from the payload and keeps them out of details', async () => {
    rows([{ ...row, acknowledgedByPrincipalId: PARTNER, resolvedByPrincipalId: PARTNER }]);
    const { org, partner } = await buildAlertWebhookProjections(event('alert.resolved', {
      acknowledgedByPrincipalId: SITE, resolvedByPrincipalId: DEVICE,
    }));
    for (const projection of [org, partner]) {
      expect(projection).toMatchObject({ acknowledgedByPrincipalId: SITE, resolvedByPrincipalId: DEVICE });
      expect(projection.details).not.toHaveProperty('acknowledgedByPrincipalId');
      expect(projection.details).not.toHaveProperty('resolvedByPrincipalId');
    }
  });

  it('falls back to principal ids on the row', async () => {
    rows([{ ...row, acknowledgedByPrincipalId: PARTNER, resolvedByPrincipalId: SITE }]);
    const { org } = await buildAlertWebhookProjections(event('alert.resolved', {
      acknowledgedByPrincipalId: 42, resolvedByPrincipalId: null,
    }));
    expect(org).toMatchObject({ acknowledgedByPrincipalId: PARTNER, resolvedByPrincipalId: SITE });
    const selection = queries[0]!.selection as Record<string, unknown>;
    const dialect = new PgDialect();
    expect(dialect.sqlToQuery(sql`${selection.acknowledgedByPrincipalId}`).sql).toBe('"alerts"."acknowledged_by_principal_id"');
    expect(dialect.sqlToQuery(sql`${selection.resolvedByPrincipalId}`).sql).toBe('"alerts"."resolved_by_principal_id"');
  });

  it('leaves principal ids null when neither payload nor row supplies them', async () => {
    const { org } = await buildAlertWebhookProjections(event());
    expect(org).toMatchObject({ acknowledgedByPrincipalId: null, resolvedByPrincipalId: null });
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

  it.each(['org', 'partner'] as const)('preserves main enrichment when the %s external-ticket read fails', async (viewer) => {
    const error = new Error('external tickets unavailable');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    if (viewer === 'partner') {
      mocks.listExternalTickets.mockResolvedValueOnce([
        { source: 'psa', externalId: 'org-ticket', externalUrl: null, externalNumber: null },
      ]);
    }
    mocks.listExternalTickets.mockRejectedValueOnce(error);
    const { org, partner } = await buildAlertWebhookProjections(event());
    for (const projection of [org, partner]) {
      expect(projection).toMatchObject({
        orgName: row.orgName, deviceHostname: row.deviceHostname,
        siteName: row.siteName, title: row.title, enrichmentIncomplete: true,
        externalTickets: [],
      });
    }
    expect(partner.orgExternalIds).toEqual([{ system: 'connectwise', externalId: 'company-7' }]);
    expect(mocks.captureException).toHaveBeenCalledExactlyOnceWith(error, undefined,
      expect.objectContaining({ errorId: 'WEBHOOK_ALERT_EXTERNAL_TICKETS_FAILED', eventId: 'event-1', orgId: ORG, eventType: 'alert.triggered' }),
      { fingerprint: ['webhook-alert-external-tickets-failed'] });
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('WEBHOOK_ALERT_EXTERNAL_TICKETS_FAILED'));
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
