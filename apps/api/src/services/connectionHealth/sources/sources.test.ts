import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// The mappers are pure; the queries run against a real DB in
// __tests__/integration/connectionHealthSources.integration.test.ts.
// A session-less query builder: brokenQuery() builds (and is inspected) without a connection.
vi.mock('../../../db', async () => {
  const { QueryBuilder } = await import('drizzle-orm/pg-core');
  return { db: new QueryBuilder() };
});

import { huntressObservation, huntressSource } from './huntress';
import { sentinelOneObservation, sentinelOneSource } from './sentinelOne';
import { pax8Observation, pax8Source } from './pax8';
import { unifiKeyObservation, unifiObservation, unifiSource } from './unifi';
import { unifiKeyHealth } from '../../integrationStates';
import { planTransitions } from '../transitions';
import { backupProviderObservation, backupProviderSource } from './backupProvider';
import { edrObservation, edrSource } from './edr';
import { accountingObservation, accountingSource } from './accounting';
import { dnsFilterObservation, dnsFilterSource } from './dnsFilter';
import { m365ConnectionObservation, m365ConnectionSource } from './m365Connection';
import { m365SyncObservation, m365SyncSource } from './m365Sync';
import { ticketMailboxObservation, ticketMailboxSource } from './ticketMailbox';
import { tdSynnexSftpObservation, tdSynnexSftpSource } from './tdSynnexSftp';

const NOW = new Date('2026-10-16T12:00:00Z');
const OLD = new Date('2026-09-01T00:00:00Z');
const YOUNG = new Date(NOW.getTime() - 30 * 60_000);
const ID = '11111111-1111-4111-8111-111111111111';
const P = '22222222-2222-4222-8222-222222222222';
const O = '33333333-3333-4333-8333-333333333333';
const ORGS = { viewPermission: { resource: 'organizations', action: 'read' }, repairPermission: { resource: 'organizations', action: 'write' } };

describe('W2 source registrations', () => {
  it.each([
    [huntressSource, 'huntress', 15, ['huntress_integrations'], ['/integrations#huntress']],
    [sentinelOneSource, 'sentinelone', 15, ['s1_integrations'], ['/integrations#sentinelone']],
    [pax8Source, 'pax8', 60, ['pax8_integrations'], ['/integrations#pax8']],
    [unifiSource, 'unifi', 30, ['unifi_integrations', 'unifi_integration_keys'], ['/integrations#unifi']],
    [backupProviderSource, 'backup_provider', 15, ['backup_provider_connections'], ['/integrations#backup']],
    [edrSource, 'edr', 15, ['edr_connections'], ['/integrations#edr']],
    [accountingSource, 'accounting', 15, ['accounting_connections'], ['/integrations#quickbooks', '/integrations#xero']],
    [dnsFilterSource, 'dns_filter', 15, ['dns_filter_integrations'], ['/dns-security']],
    [m365ConnectionSource, 'm365_connection', 15, ['m365_connections'], ['/integrations#m365']],
    [m365SyncSource, 'm365_sync', 60, ['m365_sync_state'], ['/integrations#m365']],
    [ticketMailboxSource, 'ticket_mailbox', 15, ['ticket_mailbox_connections'], ['/settings/ticketing#email']],
  ] as const)('%#: %s', (source, kind, interval, tables, hrefs) => {
    expect(source).toMatchObject({ kind, intervalMinutes: interval, tables, fixHrefs: hrefs });
    expect(source.intervalMinutes % 15).toBe(0);
  });
});

describe('partner sync sources', () => {
  const row = { id: ID, partnerId: P, isActive: true, lastSyncStatus: 'error', lastSyncError: 'scheduled: Huntress API request failed (401): token=abcdefgh1234', createdAt: OLD, stale: false };

  it('huntress: a failed sync is a partner-wide transient incident with a sanitized detail', () => {
    expect(huntressObservation(row, NOW)).toEqual({
      sourceKind: 'huntress', sourceId: ID, partnerId: P, orgId: null, ownerUserId: null,
      state: 'broken', severity: 'transient', condition: 'sync_failed',
      detail: 'scheduled: Huntress API request failed (401): token=[REDACTED]',
      displayName: 'Huntress', fixHref: '/integrations#huntress', ownerFixHref: null, ...ORGS, observedAt: NOW,
    });
  });
  it('huntress: running is unknown, inactive retired, a young failing integration unknown', () => {
    expect(huntressObservation({ ...row, lastSyncStatus: 'running' }, NOW).state).toBe('unknown');
    expect(huntressObservation({ ...row, isActive: false }, NOW).state).toBe('retired');
    expect(huntressObservation({ ...row, createdAt: YOUNG }, NOW).state).toBe('unknown');
  });
  it('sentinelone and pax8 use their own vocabularies', () => {
    expect(sentinelOneObservation({ ...row, lastSyncStatus: 'partial' }, NOW)).toMatchObject({ state: 'healthy', displayName: 'SentinelOne', fixHref: '/integrations#sentinelone' });
    expect(pax8Observation({ ...row, lastSyncStatus: 'failed' }, NOW)).toMatchObject({ state: 'broken', displayName: 'Pax8', fixHref: '/integrations#pax8' });
    expect(pax8Observation({ ...row, lastSyncStatus: 'error' }, NOW).state).toBe('unknown');
  });
});

describe('sync staleness (W4)', () => {
  const ok = { id: ID, partnerId: P, isActive: true, lastSyncStatus: 'success', lastSyncError: 'an old error from last week', createdAt: OLD, stale: true };
  it('a stale partner sync is a transient sync_stale incident with no detail (old error text would mislead)', () => {
    expect(huntressObservation(ok, NOW)).toMatchObject({ state: 'broken', severity: 'transient', condition: 'sync_stale', detail: null });
    expect(sentinelOneObservation(ok, NOW).condition).toBe('sync_stale');
    expect(pax8Observation(ok, NOW).condition).toBe('sync_stale');
  });
  it('a stuck running sync is stale; a recorded failure still wins', () => {
    expect(huntressObservation({ ...ok, lastSyncStatus: 'running' }, NOW).condition).toBe('sync_stale');
    expect(huntressObservation({ ...ok, lastSyncStatus: 'error' }, NOW)).toMatchObject({ condition: 'sync_failed', detail: 'an old error from last week' });
  });
  it('unifi and backup report stale connections', () => {
    expect(unifiObservation({ ...ok, status: 'connected' }, NOW).condition).toBe('sync_stale');
    expect(backupProviderObservation({ ...ok, name: 'Main', provider: 'cove', status: 'connected' }, NOW).condition).toBe('sync_stale');
  });

  const sqlOf = (q: unknown) => new PgDialect().sqlToQuery((q as { getSQL(): SQL }).getSQL());
  it.each([
    [huntressSource, 60], [sentinelOneSource, 60], [pax8Source, 4320], [unifiSource, 90], [ticketMailboxSource, 60],
  ] as const)('%#: the broken query carries the stale arm (%s minutes)', (source, minutes) => {
    const q = sqlOf(source.brokenQuery(NOW));
    expect(q.sql).toContain(`make_interval(mins => ${minutes})`);
    expect(q.params).toContain(NOW.toISOString());
  });
  it.each([
    ['pax8', pax8Source, true], ['backupProvider', backupProviderSource, true],
    ['huntress', huntressSource, false], ['sentinelOne', sentinelOneSource, false], ['unifi', unifiSource, false],
    ['edr', edrSource, true], ['accounting', accountingSource, true], ['ticketMailbox', ticketMailboxSource, true],
  ] as const)('%s: stale arm casts the NOW param to the column type (timestamptz=%s)', (_n, source, tz) => {
    const text = sqlOf(source.brokenQuery(NOW)).sql;
    if (tz) {
      expect(text).toContain('::timestamptz - make_interval');
    } else {
      expect(text).toContain('::timestamp - make_interval');
      expect(text).not.toContain('::timestamptz');
    }
  });
  it('backup: the stale threshold follows each row\'s own interval', () => {
    expect(sqlOf(backupProviderSource.brokenQuery(NOW)).sql).toMatch(/make_interval\(mins => GREATEST\(3 \* "backup_provider_connections"\."sync_interval_minutes", 60\)\)/);
  });

  // #9127 PR A.
  it('edr: each stream is stale past three of its own effective intervals, 60 minutes when unplanned', () => {
    const text = sqlOf(edrSource.brokenQuery(NOW)).sql;
    expect(text).toContain('COALESCE("edr_connections"."last_inventory_sync_at", "edr_connections"."created_at")');
    expect(text).toContain('make_interval(mins => GREATEST(3 * COALESCE("edr_connections"."effective_inventory_interval_minutes", 60), 60))');
    expect(text).toContain('COALESCE("edr_connections"."last_detection_sync_at", "edr_connections"."created_at")');
    expect(text).toContain('make_interval(mins => GREATEST(3 * COALESCE("edr_connections"."effective_detection_interval_minutes", 60), 60))');
    expect(text).toContain(`"edr_connections"."status" = 'connected'`);
  });
  it('accounting: only reconciled, connected connections with a payment switch on; daily-budget providers get 72 hours', () => {
    const text = sqlOf(accountingSource.brokenQuery(NOW)).sql;
    expect(text).toContain(`"accounting_connections"."provider" IN ('quickbooks', 'xero')`);
    expect(text).toContain('("accounting_connections"."pull_payments" OR "accounting_connections"."push_payments")');
    expect(text).toContain(`make_interval(mins => CASE WHEN "accounting_connections"."provider" IN ('xero') THEN 4320 ELSE 60 END)`);
    expect(text).toContain('COALESCE("accounting_connections"."last_reconcile_at", "accounting_connections"."created_at")');
  });
  it('edr, accounting and mailbox: a stale connection is sync_stale with no stale error text', () => {
    const edrRow = { id: ID, partnerId: P, name: 'GZ', provider: 'gravityzone', isActive: true, status: 'connected', lastInventorySyncStatus: 'success', lastInventorySyncError: 'an old error', lastDetectionSyncStatus: 'success', lastDetectionSyncError: null, createdAt: OLD, stale: true };
    expect(edrObservation(edrRow, NOW)).toMatchObject({ state: 'broken', severity: 'transient', condition: 'sync_stale', detail: null });
    expect(edrObservation({ ...edrRow, lastDetectionSyncStatus: 'running' }, NOW).condition).toBe('sync_stale');
    const acct = { id: ID, partnerId: P, provider: 'quickbooks', status: 'connected', lastError: null, createdAt: OLD, stale: true };
    expect(accountingObservation(acct, NOW)).toMatchObject({ state: 'broken', severity: 'transient', condition: 'sync_stale', detail: null });
    expect(ticketMailboxObservation({ id: ID, partnerId: P, mailboxAddress: 'support@example.com', status: 'connected', consecutiveTransientFailures: 0, createdAt: OLD, stale: true }, NOW))
      .toMatchObject({ state: 'broken', severity: 'transient', condition: 'sync_stale', detail: null });
  });
  it('accounting: a stale connection reports its current reconcile-run error, and no other text', () => {
    const acct = { id: ID, partnerId: P, provider: 'quickbooks', status: 'connected', createdAt: OLD, stale: true };
    expect(accountingObservation({ ...acct, lastError: 'Payment pull: 2 of 9 items failed' }, NOW).detail).toBe('Payment pull: 2 of 9 items failed');
    expect(accountingObservation({ ...acct, lastError: 'QuickBooks refresh token expired' }, NOW).detail).toBeNull();
  });
});

describe('vendor sources', () => {
  it('unifi: reauth is permanent', () => {
    expect(unifiObservation({ id: ID, partnerId: P, isActive: true, status: 'reauth_required', lastSyncStatus: 'failed', lastSyncError: 'No API key on connection', createdAt: YOUNG, stale: false }, NOW))
      .toMatchObject({ state: 'broken', severity: 'permanent', condition: 'reauth_required', displayName: 'UniFi', detail: 'No API key on connection', orgId: null });
  });

  const backup = { id: ID, partnerId: P, name: 'Main\u0000 backup', provider: 'cove', isActive: true, status: 'connected', lastSyncStatus: 'error', lastSyncError: 'fetch https://api.example.com/x?key=1 failed', createdAt: OLD, stale: false };
  it('backup: uses the cleaned connection name and backup permissions', () => {
    expect(backupProviderObservation(backup, NOW)).toMatchObject({
      state: 'broken', severity: 'transient', displayName: 'Main backup', detail: 'fetch https://api.example.com failed',
      viewPermission: { resource: 'backup', action: 'read' }, repairPermission: { resource: 'backup', action: 'write' },
      fixHref: '/integrations#backup',
    });
  });
  it('backup: a retry in progress is unknown, never a recovery', () => {
    expect(backupProviderObservation({ ...backup, lastSyncStatus: 'running', lastSyncError: null }, NOW).state).toBe('unknown');
  });

  const edr = { id: ID, partnerId: P, name: '', provider: 'gravityzone', isActive: true, status: 'connected', lastInventorySyncStatus: 'success', lastInventorySyncError: null, lastDetectionSyncStatus: 'error', lastDetectionSyncError: 'detections: 503 upstream', createdAt: OLD, stale: false };
  it('edr: reports the errored stream text and falls back to the provider label', () => {
    expect(edrObservation(edr, NOW)).toMatchObject({ state: 'broken', detail: 'detections: 503 upstream', fixHref: '/integrations#edr' });
    expect(edrObservation(edr, NOW).displayName).not.toBe('');
  });
});

describe('accounting and mailbox', () => {
  it('accounting: the fix link follows the provider; billing:manage repairs', () => {
    const r = { id: ID, partnerId: P, provider: 'xero', status: 'reauth_required', lastError: 'Xero refresh token expired', createdAt: OLD, stale: false };
    expect(accountingObservation(r, NOW)).toMatchObject({
      state: 'broken', severity: 'permanent', condition: 'reauth_required', displayName: 'Xero', fixHref: '/integrations#xero',
      viewPermission: { resource: 'accounting', action: 'read' }, repairPermission: { resource: 'billing', action: 'manage' },
    });
    expect(accountingObservation({ ...r, provider: 'quickbooks' }, NOW)).toMatchObject({ displayName: 'QuickBooks', fixHref: '/integrations#quickbooks' });
  });

  const box = { id: ID, partnerId: P, mailboxAddress: 'support@example.com', status: 'error', consecutiveTransientFailures: 0, createdAt: OLD, stale: false };
  it('mailbox: never surfaces raw upstream text and links to the mailbox card', () => {
    expect(ticketMailboxObservation(box, NOW)).toMatchObject({
      state: 'broken', condition: 'mailbox_error', detail: null, orgId: null, fixHref: '/settings/ticketing#email',
      displayName: 'Ticket mailbox support@example.com',
    });
    expect(ticketMailboxObservation({ ...box, status: 'connected', consecutiveTransientFailures: 7 }, NOW).condition).toBe('poll_failing');
  });
});

describe('org sources', () => {
  it('dns: an org incident carrying the org and its partner', () => {
    expect(dnsFilterObservation({ id: ID, orgId: O, partnerId: P, name: 'Filter', isActive: true, lastSyncStatus: 'error', lastSyncError: 'provider 500', createdAt: OLD, stale: false }, NOW))
      .toMatchObject({ state: 'broken', orgId: O, partnerId: P, displayName: 'Filter', fixHref: '/dns-security', detail: 'provider 500' });
  });

  it('dns: a stale sync is sync_stale with no stale error text', () => {
    expect(dnsFilterObservation({ id: ID, orgId: O, partnerId: P, name: 'Filter', isActive: true, lastSyncStatus: 'success', lastSyncError: 'old failure', createdAt: OLD, stale: true }, NOW))
      .toMatchObject({ state: 'broken', severity: 'transient', condition: 'sync_stale', detail: null, orgId: O });
  });

  it('m365 connection: consent codes are permanent; no detail', () => {
    expect(m365ConnectionObservation({ id: ID, orgId: O, partnerId: P, profile: 'customer-graph-read', displayName: 'Contoso', status: 'degraded', lastErrorCode: 'grant_missing', createdAt: OLD }, NOW))
      .toMatchObject({ state: 'broken', severity: 'permanent', condition: 'grant_missing', orgId: O, detail: null, fixHref: '/integrations#m365' });
  });

  it('m365 sync: one observation per connection, worst domain wins', () => {
    const o = m365SyncObservation({
      connectionId: ID, orgId: O, partnerId: P, connectionStatus: 'active', connectionCreatedAt: OLD,
      domains: [
        { domain: 'users', lastStatus: 'success', lastError: null, stale: false },
        { domain: 'intune_devices', lastStatus: 'error', lastError: 'graph_call_failed: 503', stale: false },
        { domain: 'skus', lastStatus: 'needs_consent', lastError: 'graph_permission_missing: Directory.Read.All', stale: false },
      ],
    }, NOW);
    expect(o).toMatchObject({ sourceKind: 'm365_sync', sourceId: ID, state: 'broken', severity: 'permanent', condition: 'needs_consent', orgId: O });
    expect(o.detail).toContain('skus');
  });

  it('m365 sync: a stalled domain is sync_stale and names only stalled domains, sorted', () => {
    const row = { connectionId: ID, orgId: O, partnerId: P, connectionStatus: 'active', connectionCreatedAt: OLD, domains: [
      { domain: 'users', lastStatus: 'success', lastError: null, stale: true },
      { domain: 'skus', lastStatus: 'success', lastError: null, stale: true },
      { domain: 'ca_policies', lastStatus: 'success', lastError: null, stale: false },
    ] };
    expect(m365SyncObservation(row, NOW)).toMatchObject({ state: 'broken', severity: 'transient', condition: 'sync_stale', detail: 'Stalled: skus, users' });
    expect(m365SyncObservation(row, NOW, false).state).toBe('retired');
  });

  it('m365 sync: unknown while the connection itself is degraded', () => {
    expect(m365SyncObservation({ connectionId: ID, orgId: O, partnerId: P, connectionStatus: 'degraded', connectionCreatedAt: OLD, domains: [{ domain: 'users', lastStatus: 'error', lastError: null, stale: false }] }, NOW).state).toBe('unknown');
  });
});

// #9127 PR C: the nightly TD SYNNEX price file.
describe('td_synnex_sftp', () => {
  const CATALOG = { viewPermission: { resource: 'catalog', action: 'read' }, repairPermission: { resource: 'catalog', action: 'write' } };
  const row = { id: ID, partnerId: P, enabled: true, lastSyncStatus: 'error', lastSyncError: 'download failed: password=hunter2secret', createdAt: OLD, stale: false };
  const sqlOf = (q: unknown) => new PgDialect().sqlToQuery((q as { getSQL(): SQL }).getSQL());

  it('registers one partner-axis source, hourly, with the distributor sub-tab fix link', () => {
    expect(tdSynnexSftpSource).toMatchObject({
      kind: 'td_synnex_sftp', intervalMinutes: 60, tables: ['td_synnex_sftp_integrations'], fixHrefs: ['/integrations#tdsynnex-sftp'],
    });
  });

  it('a failed nightly run is a partner-wide transient sync_failed with a sanitized detail and catalog permissions', () => {
    expect(tdSynnexSftpObservation(row, NOW)).toEqual({
      sourceKind: 'td_synnex_sftp', sourceId: ID, partnerId: P, orgId: null, ownerUserId: null,
      state: 'broken', severity: 'transient', condition: 'sync_failed',
      detail: 'download failed: password=[REDACTED]',
      displayName: 'TD SYNNEX price file', fixHref: '/integrations#tdsynnex-sftp', ownerFixHref: null, ...CATALOG, observedAt: NOW,
    });
  });

  it('stale is sync_stale with no detail (the last error may be old); disabled is retired; ok is healthy', () => {
    expect(tdSynnexSftpObservation({ ...row, lastSyncStatus: 'ok', stale: true }, NOW)).toMatchObject({ state: 'broken', condition: 'sync_stale', detail: null });
    expect(tdSynnexSftpObservation({ ...row, lastSyncStatus: 'running', stale: true }, NOW).condition).toBe('sync_stale');
    expect(tdSynnexSftpObservation({ ...row, enabled: false }, NOW).state).toBe('retired');
    expect(tdSynnexSftpObservation({ ...row, lastSyncStatus: 'ok' }, NOW).state).toBe('healthy');
  });

  it('failed and stale is sync_failed and keeps the sanitized error text', () => {
    expect(tdSynnexSftpObservation({ ...row, stale: true }, NOW)).toMatchObject({ condition: 'sync_failed', detail: 'download failed: password=[REDACTED]' });
  });

  it('the broken query reads enabled rows that failed or whose last attempt or config change is past three nights', () => {
    const q = sqlOf(tdSynnexSftpSource.brokenQuery(NOW));
    expect(q.sql).toContain('"td_synnex_sftp_integrations"."enabled" AND');
    expect(q.sql).toContain(`"td_synnex_sftp_integrations"."last_sync_status" = 'error'`);
    expect(q.sql).toContain('COALESCE(GREATEST("td_synnex_sftp_integrations"."last_sync_at", "td_synnex_sftp_integrations"."updated_at"), "td_synnex_sftp_integrations"."created_at")');
    expect(q.sql).toContain('::timestamp - make_interval(mins => 4320)');
    expect(q.sql).not.toContain('::timestamptz');
    expect(q.params).toContain(NOW.toISOString());
  });
});

describe('unifi per-key health (#11808 W3)', () => {
  const KEY_A = '44444444-4444-4444-8444-444444444444';
  const KEY_B = '55555555-5555-4555-8555-555555555555';
  const keyRow = (over: Record<string, unknown> = {}) => ({
    id: KEY_A, partnerId: P, label: 'Macera', integrationActive: true, isEnabled: true,
    status: 'connected', lastSyncStatus: 'success' as string | null, lastSyncError: null as string | null, createdAt: OLD, ...over,
  });

  it.each([
    [{ integrationActive: false, isEnabled: true, status: 'connected', lastSyncStatus: 'success' }, { state: 'retired' }],
    [{ integrationActive: true, isEnabled: false, status: 'reauth_required', lastSyncStatus: 'failed' }, { state: 'retired' }],
    [{ integrationActive: true, isEnabled: true, status: 'reauth_required', lastSyncStatus: 'failed' }, { state: 'broken', severity: 'permanent', condition: 'reauth_required' }],
    [{ integrationActive: true, isEnabled: true, status: 'error', lastSyncStatus: 'failed' }, { state: 'broken', severity: 'transient', condition: 'sync_failed' }],
    [{ integrationActive: true, isEnabled: true, status: 'pending', lastSyncStatus: 'failed' }, { state: 'broken', severity: 'transient', condition: 'sync_failed' }],
    [{ integrationActive: true, isEnabled: true, status: 'connected', lastSyncStatus: 'success' }, { state: 'healthy' }],
    [{ integrationActive: true, isEnabled: true, status: 'connected', lastSyncStatus: 'skipped' }, { state: 'unknown' }],
    [{ integrationActive: true, isEnabled: true, status: 'pending', lastSyncStatus: null }, { state: 'unknown' }],
  ] as const)('unifiKeyHealth %#', (row, verdict) => {
    expect(unifiKeyHealth(row)).toEqual(verdict);
  });

  it('one failing key of two is broken while the integration stays healthy', () => {
    const integration = unifiObservation({
      id: ID, partnerId: P, isActive: true, status: 'connected', lastSyncStatus: 'partial',
      lastSyncError: '1 of 2 keys failed: "Macera" (key rejected)', createdAt: OLD, stale: false,
    }, NOW);
    expect(integration).toMatchObject({ sourceId: ID, state: 'healthy', displayName: 'UniFi' });
    const failing = unifiKeyObservation(keyRow({ status: 'reauth_required', lastSyncStatus: 'failed', lastSyncError: 'UniFi API error 401' }), NOW);
    expect(failing).toMatchObject({
      sourceKind: 'unifi', sourceId: KEY_A, partnerId: P, orgId: null, state: 'broken', severity: 'permanent',
      condition: 'reauth_required', displayName: 'UniFi: Macera', detail: 'UniFi API error 401', fixHref: '/integrations#unifi',
      ...ORGS,
    });
    expect(unifiKeyObservation(keyRow({ id: KEY_B, label: 'Fabric' }), NOW)).toMatchObject({ sourceId: KEY_B, state: 'healthy', detail: null });
  });

  it('a disabled key retires', () => {
    expect(unifiKeyObservation(keyRow({ isEnabled: false, status: 'error', lastSyncStatus: 'failed' }), NOW).state).toBe('retired');
  });

  it("a deleted key's tracked incident resolves", () => {
    // A deleted key's row is absent, so observe() reports nothing for its id
    // (connectionHealthSources.integration.test.ts pins that on a real DB);
    // the reconciler retires a tracked id with no observation.
    const actions = planTransitions({
      observations: [],
      tracked: [{ id: 'incident-1', sourceId: KEY_A, severity: 'permanent', openedAt: OLD, resolvedAt: null, healthyStreak: 0 }],
      now: NOW,
      seed: false,
    });
    expect(actions).toEqual([{ type: 'resolve', incidentId: 'incident-1', resolution: 'retired' }]);
  });

  it('the integration observation keeps its source id', () => {
    expect(unifiObservation({ id: ID, partnerId: P, isActive: true, status: 'error', lastSyncStatus: 'failed', lastSyncError: 'x', createdAt: OLD, stale: false }, NOW))
      .toMatchObject({ sourceId: ID, displayName: 'UniFi', state: 'broken' });
  });

  it('the broken query covers the integrations and their enabled failing keys', () => {
    const q = new PgDialect().sqlToQuery((unifiSource.brokenQuery(NOW) as { getSQL(): SQL }).getSQL()).sql;
    expect(q).toContain('"unifi_integrations"');
    expect(q).toContain('"unifi_integration_keys"');
    expect(q).toContain('union all');
    expect(q).toContain('"unifi_integration_keys"."is_enabled"');
  });
});
