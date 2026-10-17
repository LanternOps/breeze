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
import { unifiObservation, unifiSource } from './unifi';
import { backupProviderObservation, backupProviderSource } from './backupProvider';
import { edrObservation, edrSource } from './edr';
import { accountingObservation, accountingSource } from './accounting';
import { dnsFilterObservation, dnsFilterSource } from './dnsFilter';
import { m365ConnectionObservation, m365ConnectionSource } from './m365Connection';
import { m365SyncObservation, m365SyncSource } from './m365Sync';
import { ticketMailboxObservation, ticketMailboxSource } from './ticketMailbox';

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
    [unifiSource, 'unifi', 30, ['unifi_integrations'], ['/integrations#unifi']],
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
    [huntressSource, 60], [sentinelOneSource, 60], [pax8Source, 4320], [unifiSource, 90],
  ] as const)('%#: the broken query carries the stale arm (%s minutes)', (source, minutes) => {
    const q = sqlOf(source.brokenQuery(NOW));
    expect(q.sql).toContain(`make_interval(mins => ${minutes})`);
    expect(q.params).toContain(NOW.toISOString());
  });
  it.each([
    ['pax8', pax8Source, true], ['backupProvider', backupProviderSource, true],
    ['huntress', huntressSource, false], ['sentinelOne', sentinelOneSource, false], ['unifi', unifiSource, false],
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

  const edr = { id: ID, partnerId: P, name: '', provider: 'gravityzone', isActive: true, status: 'connected', lastInventorySyncStatus: 'success', lastInventorySyncError: null, lastDetectionSyncStatus: 'error', lastDetectionSyncError: 'detections: 503 upstream', createdAt: OLD };
  it('edr: reports the errored stream text and falls back to the provider label', () => {
    expect(edrObservation(edr, NOW)).toMatchObject({ state: 'broken', detail: 'detections: 503 upstream', fixHref: '/integrations#edr' });
    expect(edrObservation(edr, NOW).displayName).not.toBe('');
  });
});

describe('accounting and mailbox', () => {
  it('accounting: the fix link follows the provider; billing:manage repairs', () => {
    const r = { id: ID, partnerId: P, provider: 'xero', status: 'reauth_required', lastError: 'Xero refresh token expired', createdAt: OLD };
    expect(accountingObservation(r, NOW)).toMatchObject({
      state: 'broken', severity: 'permanent', condition: 'reauth_required', displayName: 'Xero', fixHref: '/integrations#xero',
      viewPermission: { resource: 'accounting', action: 'read' }, repairPermission: { resource: 'billing', action: 'manage' },
    });
    expect(accountingObservation({ ...r, provider: 'quickbooks' }, NOW)).toMatchObject({ displayName: 'QuickBooks', fixHref: '/integrations#quickbooks' });
  });

  const box = { id: ID, partnerId: P, mailboxAddress: 'support@example.com', status: 'error', consecutiveTransientFailures: 0, createdAt: OLD };
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
    expect(dnsFilterObservation({ id: ID, orgId: O, partnerId: P, name: 'Filter', isActive: true, lastSyncStatus: 'error', lastSyncError: 'provider 500', createdAt: OLD }, NOW))
      .toMatchObject({ state: 'broken', orgId: O, partnerId: P, displayName: 'Filter', fixHref: '/dns-security', detail: 'provider 500' });
  });

  it('m365 connection: consent codes are permanent; no detail', () => {
    expect(m365ConnectionObservation({ id: ID, orgId: O, partnerId: P, profile: 'customer-graph-read', displayName: 'Contoso', status: 'degraded', lastErrorCode: 'grant_missing', createdAt: OLD }, NOW))
      .toMatchObject({ state: 'broken', severity: 'permanent', condition: 'grant_missing', orgId: O, detail: null, fixHref: '/integrations#m365' });
  });

  it('m365 sync: one observation per connection, worst domain wins', () => {
    const o = m365SyncObservation({
      connectionId: ID, orgId: O, partnerId: P, connectionStatus: 'active', connectionCreatedAt: OLD,
      domains: [
        { domain: 'users', lastStatus: 'success', lastError: null },
        { domain: 'intune_devices', lastStatus: 'error', lastError: 'graph_call_failed: 503' },
        { domain: 'skus', lastStatus: 'needs_consent', lastError: 'graph_permission_missing: Directory.Read.All' },
      ],
    }, NOW);
    expect(o).toMatchObject({ sourceKind: 'm365_sync', sourceId: ID, state: 'broken', severity: 'permanent', condition: 'needs_consent', orgId: O });
    expect(o.detail).toContain('skus');
  });

  it('m365 sync: unknown while the connection itself is degraded', () => {
    expect(m365SyncObservation({ connectionId: ID, orgId: O, partnerId: P, connectionStatus: 'degraded', connectionCreatedAt: OLD, domains: [{ domain: 'users', lastStatus: 'error', lastError: null }] }, NOW).state).toBe('unknown');
  });
});
