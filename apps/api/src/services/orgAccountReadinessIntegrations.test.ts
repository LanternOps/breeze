import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  accountingConnectionJoin,
  accountingConnectorState,
  accountingMappingState,
  activeRowConnectorState,
  aggregateIntegrations,
  dnsState,
  m365State,
  parentMappingState,
  pax8MappingState,
  worstState,
  type OrgIntegration,
} from './orgAccountReadinessIntegrations';

const NOW = new Date('2026-09-13T12:00:00.000Z');

describe('worstState', () => {
  it('ranks error > pending > linked > identity and keeps the first of equals', () => {
    const rows: OrgIntegration[] = [
      { system: 'm365', state: 'linked' },
      { system: 'm365', state: 'pending', reason: 'consent_pending' },
      { system: 'm365', state: 'error', reason: 'degraded' },
      { system: 'm365', state: 'error', reason: 'suspended' },
    ];
    expect(worstState(rows)).toEqual({ system: 'm365', state: 'error', reason: 'degraded' });
    expect(worstState(rows.slice(0, 2))).toEqual({ system: 'm365', state: 'pending', reason: 'consent_pending' });
    expect(worstState([])).toBeNull();
  });
});

describe('accountingConnectorState', () => {
  it.each([
    ['connected', 'connected'],
    ['reauth_required', 'reauth_required'],
    ['disconnected', 'disconnected'],
    ['error', 'error'],
    ['something-new', 'error'],
  ])('%s → %s', (status, expected) => {
    expect(accountingConnectorState(status)).toBe(expected);
  });
});

describe('accountingMappingState', () => {
  it('confirmed + synced is linked', () => {
    expect(accountingMappingState({ linkStatus: 'confirmed', syncStatus: 'synced', lastError: null })).toEqual({ state: 'linked' });
  });
  it('confirmed + pending and synced_with_tax_variance are linked', () => {
    expect(accountingMappingState({ linkStatus: 'confirmed', syncStatus: 'pending', lastError: null })).toEqual({ state: 'linked' });
    expect(accountingMappingState({ linkStatus: 'confirmed', syncStatus: 'synced_with_tax_variance', lastError: null })).toEqual({ state: 'linked' });
  });
  it('suggested and create_new are pending suggested_match', () => {
    expect(accountingMappingState({ linkStatus: 'suggested', syncStatus: 'pending', lastError: null })).toEqual({ state: 'pending', reason: 'suggested_match' });
    expect(accountingMappingState({ linkStatus: 'create_new', syncStatus: 'pending', lastError: null })).toEqual({ state: 'pending', reason: 'suggested_match' });
  });
  it('sync error or a last_error is error sync_error', () => {
    expect(accountingMappingState({ linkStatus: 'confirmed', syncStatus: 'error', lastError: null })).toEqual({ state: 'error', reason: 'sync_error' });
    expect(accountingMappingState({ linkStatus: 'confirmed', syncStatus: 'synced', lastError: 'boom' })).toEqual({ state: 'error', reason: 'sync_error' });
  });
  it('unlinked is not a mapping', () => {
    expect(accountingMappingState({ linkStatus: 'unlinked', syncStatus: 'synced', lastError: null })).toBeNull();
  });
});

describe('activeRowConnectorState', () => {
  it('is null with no rows, disabled with only inactive rows', () => {
    expect(activeRowConnectorState([], 'failed')).toBeNull();
    expect(activeRowConnectorState([{ isActive: false, lastSyncStatus: 'success' }], 'failed')).toBe('disabled');
  });
  it('reads the active row: failed value → error, anything else → connected', () => {
    expect(activeRowConnectorState([{ isActive: false, lastSyncStatus: null }, { isActive: true, lastSyncStatus: 'failed' }], 'failed')).toBe('error');
    expect(activeRowConnectorState([{ isActive: true, lastSyncStatus: null }], 'failed')).toBe('connected');
    expect(activeRowConnectorState([{ isActive: true, lastSyncStatus: 'error' }], 'error')).toBe('error');
  });
});

describe('parentMappingState (Huntress / SentinelOne)', () => {
  it.each([
    [{ isActive: false, lastSyncStatus: 'success' }, { state: 'error', reason: 'connector_error' }],
    [{ isActive: true, lastSyncStatus: 'error' }, { state: 'error', reason: 'connector_error' }],
    [{ isActive: true, lastSyncStatus: null }, { state: 'pending', reason: 'never_synced' }],
    [{ isActive: true, lastSyncStatus: 'running' }, { state: 'linked' }],
    [{ isActive: true, lastSyncStatus: 'partial' }, { state: 'linked' }],
    [{ isActive: true, lastSyncStatus: 'success' }, { state: 'linked' }],
  ])('%o → %o', (parent, expected) => {
    expect(parentMappingState(parent)).toEqual(expected);
  });
});

describe('m365State', () => {
  const base = { status: 'active', expiresAt: null, lastErrorCode: null };
  it.each([
    [{ ...base }, { state: 'linked' }],
    [{ ...base, status: 'degraded' }, { state: 'error', reason: 'degraded' }],
    [{ ...base, status: 'suspended' }, { state: 'error', reason: 'suspended' }],
    [{ ...base, lastErrorCode: 'token_refresh_failed' }, { state: 'error', reason: 'error' }],
    [{ ...base, status: 'pending-consent' }, { state: 'pending', reason: 'consent_pending' }],
    [{ ...base, status: 'verifying' }, { state: 'pending', reason: 'consent_pending' }],
    [{ ...base, expiresAt: new Date('2026-09-01T00:00:00.000Z') }, { state: 'pending', reason: 'expired' }],
    [{ ...base, expiresAt: new Date('2027-09-01T00:00:00.000Z') }, { state: 'linked' }],
  ])('%o → %o', (row, expected) => {
    expect(m365State(row, NOW)).toEqual(expected);
  });
  it('error states win over pending ones on the same row', () => {
    expect(m365State({ status: 'pending-consent', expiresAt: null, lastErrorCode: 'x' }, NOW)).toEqual({ state: 'error', reason: 'error' });
  });
});

describe('dnsState', () => {
  it.each([
    [null, { state: 'pending', reason: 'never_synced' }],
    ['error', { state: 'error', reason: 'sync_error' }],
    ['success', { state: 'linked' }],
    ['ok', { state: 'linked' }],
  ])('%s → %o', (lastSyncStatus, expected) => {
    expect(dnsState({ lastSyncStatus })).toEqual(expected);
  });
});

describe('pax8MappingState', () => {
  it('mirrors the connector: error → sync_failed, else linked', () => {
    expect(pax8MappingState('error')).toEqual({ state: 'error', reason: 'sync_failed' });
    expect(pax8MappingState('connected')).toEqual({ state: 'linked' });
  });
});

describe('accountingConnectionJoin', () => {
  it('carries the partner predicate on accounting_connections — the tenancy predicate for a partner-axis table', () => {
    const query = new PgDialect().sqlToQuery(accountingConnectionJoin('partner-1'));
    expect(query.sql).toContain('"accounting_entity_mappings"."integration_id" = "accounting_connections"."id"');
    expect(query.sql).toContain('"accounting_connections"."partner_id" = ');
    expect(query.params).toEqual(['partner-1']);
  });
});

describe('aggregateIntegrations', () => {
  it('collapses several rows for one system into the worst, keeps external rows per label, and orders systems', () => {
    const out = aggregateIntegrations(['org-a', 'org-b'], [
      { orgId: 'org-a', integration: { system: 'external', state: 'identity', label: 'datto_rmm' } },
      { orgId: 'org-a', integration: { system: 'm365', state: 'linked' } },
      { orgId: 'org-a', integration: { system: 'm365', state: 'error', reason: 'degraded' } },
      { orgId: 'org-a', integration: { system: 'quickbooks', state: 'linked' } },
      { orgId: 'org-a', integration: { system: 'external', state: 'identity', label: 'csv' } },
      { orgId: 'org-zzz', integration: { system: 'pax8', state: 'linked' } },
    ]);
    expect(out.get('org-a')).toEqual([
      { system: 'quickbooks', state: 'linked' },
      { system: 'm365', state: 'error', reason: 'degraded' },
      { system: 'external', state: 'identity', label: 'csv' },
      { system: 'external', state: 'identity', label: 'datto_rmm' },
    ]);
    expect(out.get('org-b')).toEqual([]);
    expect(out.has('org-zzz')).toBe(false);
  });
});
