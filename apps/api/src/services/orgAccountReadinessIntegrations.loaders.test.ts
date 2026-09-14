import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

vi.mock('../db', () => ({
  db: { select: vi.fn(), selectDistinct: vi.fn() },
}));

import { db } from '../db';
import {
  accountingConnections,
  accountingEntityMappings,
  dnsFilterIntegrations,
  huntressIntegrations,
  huntressOrgMappings,
  m365Connections,
  organizationExternalLinks,
  pax8CompanyMappings,
  pax8Integrations,
  psaConnections,
  s1Integrations,
  s1OrgMappings,
} from '../db/schema';
import {
  loadAccounting,
  loadDns,
  loadHuntress,
  loadIntegrationReadiness,
  loadM365,
  loadPax8,
  loadPsaAndExternal,
  loadSentinelOne,
} from './orgAccountReadinessIntegrations';

const PARTNER = '00000000-0000-0000-0000-00000000aaaa';
const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

/** Table-keyed row stubs (the orgSummary.test.ts pattern): `db.select().from(table)`
 * looks rows up by the table object, so tests read as "these rows exist". Every
 * chain method is captured per table so a test can compile the real SQL. */
const joins = new Map<unknown, unknown>();
const wheres = new Map<unknown, unknown>();

function chain(table: unknown, rows: unknown[]) {
  const result = Promise.resolve(rows) as Promise<unknown[]> & Record<string, (...args: never[]) => unknown>;
  const self = result as unknown as Record<string, unknown>;
  self.innerJoin = (_other: unknown, condition: unknown) => { joins.set(table, condition); return result; };
  self.where = (condition: unknown) => { wheres.set(table, condition); return result; };
  self.groupBy = () => result;
  self.limit = () => result;
  return result;
}

function setupDb(rowsByTable: Map<unknown, unknown[]>) {
  const impl = () => ({ from: (table: unknown) => chain(table, rowsByTable.get(table) ?? []) }) as never;
  vi.mocked(db.select).mockImplementation(impl);
  vi.mocked(db.selectDistinct).mockImplementation(impl);
}

function compiled(captured: Map<unknown, unknown>, table: unknown) {
  const condition = captured.get(table);
  if (!condition) throw new Error('nothing captured for that table');
  return new PgDialect().sqlToQuery(condition as SQL);
}

beforeEach(() => {
  vi.clearAllMocks();
  joins.clear();
  wheres.clear();
});

describe('loadAccounting', () => {
  it('returns nothing without accounting:read and never touches the database', async () => {
    setupDb(new Map());
    const out = await loadAccounting(PARTNER, [ORG_A], { accounting: false, pax8: true });
    expect(out).toEqual({ connectors: [], rows: [] });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('emits one connector per connection and one row per non-unlinked org mapping', async () => {
    setupDb(new Map<unknown, unknown[]>([
      [accountingConnections, [{ id: 'conn-1', provider: 'quickbooks', status: 'reauth_required' }]],
      [accountingEntityMappings, [
        { orgId: ORG_A, provider: 'quickbooks', linkStatus: 'confirmed', syncStatus: 'synced', lastError: null },
        { orgId: ORG_B, provider: 'quickbooks', linkStatus: 'unlinked', syncStatus: 'pending', lastError: null },
      ]],
    ]));
    const out = await loadAccounting(PARTNER, [ORG_A, ORG_B], { accounting: true, pax8: false });
    expect(out.connectors).toEqual([{ system: 'quickbooks', state: 'reauth_required' }]);
    expect(out.rows).toEqual([{ orgId: ORG_A, integration: { system: 'quickbooks', state: 'linked' } }]);
  });

  it('joins mappings to connections on integration_id AND partner_id, restricted to org mappings of the accepted ids', async () => {
    setupDb(new Map<unknown, unknown[]>([
      [accountingConnections, [{ id: 'conn-1', provider: 'xero', status: 'connected' }]],
      [accountingEntityMappings, []],
    ]));
    await loadAccounting(PARTNER, [ORG_A], { accounting: true, pax8: false });
    const join = compiled(joins, accountingEntityMappings);
    expect(join.sql).toContain('"accounting_connections"."partner_id" = ');
    expect(join.params).toContain(PARTNER);
    const where = compiled(wheres, accountingEntityMappings);
    expect(where.sql).toContain('"accounting_entity_mappings"."breeze_entity_type" = ');
    expect(where.sql).toContain('"accounting_entity_mappings"."breeze_entity_id" in (');
    expect(where.params).toEqual(['org', ORG_A]);
  });

  it('skips the mapping query when the partner has no connection or no org survived', async () => {
    setupDb(new Map<unknown, unknown[]>([[accountingConnections, []]]));
    await loadAccounting(PARTNER, [ORG_A], { accounting: true, pax8: false });
    expect(wheres.has(accountingEntityMappings)).toBe(false);
    setupDb(new Map<unknown, unknown[]>([[accountingConnections, [{ id: 'c', provider: 'quickbooks', status: 'connected' }]]]));
    await loadAccounting(PARTNER, [], { accounting: true, pax8: false });
    expect(wheres.has(accountingEntityMappings)).toBe(false);
  });
});

describe('loadPsaAndExternal', () => {
  it('partner-level connections become connectors; org-level rows, provider-matching links and other links become rows', async () => {
    setupDb(new Map<unknown, unknown[]>([
      [psaConnections, [
        { orgId: null, provider: 'connectwise', enabled: true },
        { orgId: null, provider: 'autotask', enabled: false },
        { orgId: ORG_B, provider: 'jira', enabled: false },
      ]],
      [organizationExternalLinks, [
        { orgId: ORG_A, system: 'connectwise' },
        { orgId: ORG_A, system: 'autotask' },
        { orgId: ORG_A, system: 'datto_rmm' },
        { orgId: ORG_B, system: 'csv' },
      ]],
    ]));
    const out = await loadPsaAndExternal(PARTNER, [ORG_A, ORG_B]);
    expect(out.connectors).toEqual([
      { system: 'psa', state: 'connected', provider: 'connectwise' },
      { system: 'psa', state: 'disabled', provider: 'autotask' },
    ]);
    expect(out.rows).toEqual([
      { orgId: ORG_B, integration: { system: 'psa', state: 'error', reason: 'disabled' } },
      { orgId: ORG_A, integration: { system: 'psa', state: 'linked' } },
      { orgId: ORG_A, integration: { system: 'external', state: 'identity', label: 'datto_rmm' } },
      { orgId: ORG_B, integration: { system: 'external', state: 'identity', label: 'csv' } },
    ]);
  });

  it('scopes psa_connections to the partner axis OR the accepted org ids, and links to the accepted ids', async () => {
    setupDb(new Map<unknown, unknown[]>([[psaConnections, []], [organizationExternalLinks, []]]));
    await loadPsaAndExternal(PARTNER, [ORG_A]);
    const psaWhere = compiled(wheres, psaConnections);
    expect(psaWhere.sql).toContain('"psa_connections"."partner_id" = ');
    expect(psaWhere.sql).toContain('"psa_connections"."org_id" is null');
    expect(psaWhere.sql).toContain('"psa_connections"."org_id" in (');
    expect(psaWhere.params).toEqual([PARTNER, ORG_A]);
    const linkWhere = compiled(wheres, organizationExternalLinks);
    expect(linkWhere.sql).toContain('"organization_external_links"."org_id" in (');
    expect(linkWhere.params).toEqual([ORG_A]);
  });

  it('with no accepted org still reports partner-level connectors and reads no links', async () => {
    setupDb(new Map<unknown, unknown[]>([[psaConnections, [{ orgId: null, provider: 'zendesk', enabled: true }]]]));
    const out = await loadPsaAndExternal(PARTNER, []);
    expect(out.connectors).toEqual([{ system: 'psa', state: 'connected', provider: 'zendesk' }]);
    expect(out.rows).toEqual([]);
    expect(wheres.has(organizationExternalLinks)).toBe(false);
  });

  it('never emits an identity badge for quickbooks or xero — the accounting customer import writes exactly these system values on organization_external_links, and loadAccounting already reports the real mapping (or withholds it under accounting:read); a second "external" badge would duplicate or leak it', async () => {
    setupDb(new Map<unknown, unknown[]>([
      [psaConnections, []],
      [organizationExternalLinks, [
        { orgId: ORG_A, system: 'quickbooks' },
        { orgId: ORG_A, system: 'xero' },
        { orgId: ORG_A, system: 'datto_rmm' },
      ]],
    ]));
    const out = await loadPsaAndExternal(PARTNER, [ORG_A]);
    expect(out.rows).toEqual([{ orgId: ORG_A, integration: { system: 'external', state: 'identity', label: 'datto_rmm' } }]);
  });
});

const NOW = new Date('2026-09-13T12:00:00.000Z');

describe('loadPax8', () => {
  it('returns nothing without billing:manage', async () => {
    setupDb(new Map());
    expect(await loadPax8(PARTNER, [ORG_A], { accounting: true, pax8: false })).toEqual({ connectors: [], rows: [] });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('reads mappings only under the ACTIVE integration and mirrors its sync state', async () => {
    setupDb(new Map<unknown, unknown[]>([
      [pax8Integrations, [
        { id: 'old', isActive: false, lastSyncStatus: 'success' },
        { id: 'live', isActive: true, lastSyncStatus: 'failed' },
      ]],
      [pax8CompanyMappings, [{ orgId: ORG_A }]],
    ]));
    const out = await loadPax8(PARTNER, [ORG_A, ORG_B], { accounting: false, pax8: true });
    expect(out.connectors).toEqual([{ system: 'pax8', state: 'error' }]);
    expect(out.rows).toEqual([{ orgId: ORG_A, integration: { system: 'pax8', state: 'error', reason: 'sync_failed' } }]);
    const where = compiled(wheres, pax8CompanyMappings);
    expect(where.sql).toContain('"pax8_company_mappings"."integration_id" = ');
    expect(where.sql).toContain('"pax8_company_mappings"."partner_id" = ');
    expect(where.sql).toContain('"pax8_company_mappings"."ignored" = ');
    expect(where.sql).toContain('"pax8_company_mappings"."org_id" in (');
    expect(where.params).toEqual(['live', PARTNER, false, ORG_A, ORG_B]);
  });

  it('with only inactive integrations reports disabled and reads no mappings', async () => {
    setupDb(new Map<unknown, unknown[]>([[pax8Integrations, [{ id: 'old', isActive: false, lastSyncStatus: null }]]]));
    const out = await loadPax8(PARTNER, [ORG_A], { accounting: false, pax8: true });
    expect(out).toEqual({ connectors: [{ system: 'pax8', state: 'disabled' }], rows: [] });
    expect(wheres.has(pax8CompanyMappings)).toBe(false);
  });
});

describe('loadM365', () => {
  it('excludes revoked rows in SQL and derives one row per profile', async () => {
    setupDb(new Map<unknown, unknown[]>([[m365Connections, [
      { orgId: ORG_A, status: 'active', expiresAt: null, lastErrorCode: null },
      { orgId: ORG_A, status: 'degraded', expiresAt: null, lastErrorCode: null },
    ]]]));
    const out = await loadM365([ORG_A], NOW);
    expect(out.connectors).toEqual([]);
    expect(out.rows).toEqual([
      { orgId: ORG_A, integration: { system: 'm365', state: 'linked' } },
      { orgId: ORG_A, integration: { system: 'm365', state: 'error', reason: 'degraded' } },
    ]);
    const where = compiled(wheres, m365Connections);
    expect(where.sql).toContain('"m365_connections"."org_id" in (');
    expect(where.sql).toContain('"m365_connections"."revoked_at" is null');
    expect(where.sql).toContain('"m365_connections"."status" <> ');
    expect(where.params).toEqual([ORG_A, 'revoked']);
  });
});

describe('loadDns', () => {
  it('reads active integrations of the accepted orgs', async () => {
    setupDb(new Map<unknown, unknown[]>([[dnsFilterIntegrations, [{ orgId: ORG_A, lastSyncStatus: null }]]]));
    const out = await loadDns([ORG_A]);
    expect(out.rows).toEqual([{ orgId: ORG_A, integration: { system: 'dns_filter', state: 'pending', reason: 'never_synced' } }]);
    const where = compiled(wheres, dnsFilterIntegrations);
    expect(where.sql).toContain('"dns_filter_integrations"."is_active" = ');
    expect(where.params).toEqual([ORG_A, true]);
  });
});

describe('loadHuntress / loadSentinelOne', () => {
  it('Huntress: connector from all rows, mapping state from the joined parent, join carries the partner', async () => {
    setupDb(new Map<unknown, unknown[]>([
      [huntressIntegrations, [{ id: 'h1', isActive: false, lastSyncStatus: 'success' }]],
      [huntressOrgMappings, [{ orgId: ORG_A, isActive: false, lastSyncStatus: 'success' }]],
    ]));
    const out = await loadHuntress(PARTNER, [ORG_A]);
    expect(out.connectors).toEqual([{ system: 'huntress', state: 'disabled' }]);
    expect(out.rows).toEqual([{ orgId: ORG_A, integration: { system: 'huntress', state: 'error', reason: 'connector_error' } }]);
    const join = compiled(joins, huntressOrgMappings);
    expect(join.sql).toContain('"huntress_integrations"."partner_id" = ');
    expect(join.params).toEqual([PARTNER]);
    const where = compiled(wheres, huntressOrgMappings);
    expect(where.sql).toContain('"huntress_org_mappings"."partner_id" = ');
    expect(where.sql).toContain('"huntress_org_mappings"."org_id" in (');
    expect(where.params).toEqual([PARTNER, ORG_A]);
  });

  it('SentinelOne: active parent never synced → pending never_synced; a partial sync is linked', async () => {
    setupDb(new Map<unknown, unknown[]>([
      [s1Integrations, [{ id: 's1', isActive: true, lastSyncStatus: null }]],
      [s1OrgMappings, [
        { orgId: ORG_A, isActive: true, lastSyncStatus: null },
        { orgId: ORG_B, isActive: true, lastSyncStatus: 'partial' },
      ]],
    ]));
    const out = await loadSentinelOne(PARTNER, [ORG_A, ORG_B]);
    expect(out.connectors).toEqual([{ system: 'sentinelone', state: 'connected' }]);
    expect(out.rows).toEqual([
      { orgId: ORG_A, integration: { system: 'sentinelone', state: 'pending', reason: 'never_synced' } },
      { orgId: ORG_B, integration: { system: 'sentinelone', state: 'linked' } },
    ]);
  });

  it('a partner with no Huntress row mentions no connector and reads no mappings', async () => {
    setupDb(new Map<unknown, unknown[]>([[huntressIntegrations, []]]));
    expect(await loadHuntress(PARTNER, [ORG_A])).toEqual({ connectors: [], rows: [] });
    expect(wheres.has(huntressOrgMappings)).toBe(false);
  });
});

describe('loadIntegrationReadiness', () => {
  it('composes every source, aggregates per org and keys every accepted org', async () => {
    setupDb(new Map<unknown, unknown[]>([
      [accountingConnections, [{ id: 'c1', provider: 'quickbooks', status: 'connected' }]],
      [accountingEntityMappings, [{ orgId: ORG_A, provider: 'quickbooks', linkStatus: 'confirmed', syncStatus: 'synced', lastError: null }]],
      [psaConnections, []],
      [organizationExternalLinks, []],
      [pax8Integrations, []],
      [m365Connections, [
        { orgId: ORG_A, status: 'active', expiresAt: null, lastErrorCode: null },
        { orgId: ORG_A, status: 'verifying', expiresAt: null, lastErrorCode: null },
      ]],
      [dnsFilterIntegrations, []],
      [huntressIntegrations, []],
      [s1Integrations, []],
    ]));
    const out = await loadIntegrationReadiness({ partnerId: PARTNER, orgIds: [ORG_A, ORG_B], grants: { accounting: true, pax8: true }, now: NOW });
    expect(out.connectors).toEqual([{ system: 'quickbooks', state: 'connected' }]);
    expect(out.byOrg.get(ORG_A)).toEqual([
      { system: 'quickbooks', state: 'linked' },
      { system: 'm365', state: 'pending', reason: 'consent_pending' },
    ]);
    expect(out.byOrg.get(ORG_B)).toEqual([]);
  });
});
