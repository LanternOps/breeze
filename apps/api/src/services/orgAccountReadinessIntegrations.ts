/**
 * Organizations account board — W03 integrations (spec
 * docs/superpowers/specs/web-ui/2026-09-13-organizations-account-board-design.md,
 * "Integrations cell").
 *
 * Connector state (partner-level, once per response) and org mapping state are
 * modelled separately. Everything on the wire is a CODE; the web translates.
 * The pure functions below are the whole state contract and are unit-tested
 * without a database; the loaders (further down) only fetch rows and feed them
 * through these functions.
 */
import { and, eq, inArray, isNull, ne, or, type SQL } from 'drizzle-orm';
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

export type ConnectorSystem = 'quickbooks' | 'xero' | 'psa' | 'pax8' | 'huntress' | 'sentinelone';
export type ConnectorState = 'connected' | 'reauth_required' | 'disconnected' | 'error' | 'disabled';
export interface Connector {
  system: ConnectorSystem;
  state: ConnectorState;
  /** PSA provider id (`connectwise`, `autotask`, …) — PSA only. */
  provider?: string;
}

export type IntegrationSystem = ConnectorSystem | 'm365' | 'dns_filter' | 'external';
export type IntegrationState = 'linked' | 'pending' | 'error' | 'identity';
export type IntegrationReason =
  | 'suggested_match'
  | 'sync_error'
  | 'consent_pending'
  | 'expired'
  | 'degraded'
  | 'suspended'
  | 'error'
  | 'never_synced'
  | 'sync_failed'
  | 'disabled'
  | 'connector_error';
export interface OrgIntegration {
  system: IntegrationSystem;
  state: IntegrationState;
  reason?: IntegrationReason;
  /** `external` rows only: the raw `organization_external_links.system` value. */
  label?: string;
}

/** Sub-grants that gate individual connectors (spec: accounting needs accounting:read, Pax8 needs billing:manage). */
export interface IntegrationGrants {
  accounting: boolean;
  pax8: boolean;
}

export interface IntegrationReadiness {
  connectors: Connector[];
  /** Every accepted org id is a key; an org with nothing linked maps to `[]`. */
  byOrg: Map<string, OrgIntegration[]>;
}

/** A mapping state without its system — what each per-source derivation returns. */
export type MappingState = Omit<OrgIntegration, 'system'>;

const STATE_RANK: Record<IntegrationState, number> = { identity: 0, linked: 1, pending: 2, error: 3 };

/** Worst state wins (error > pending > linked > identity); among equals the first row is kept. */
export function worstState(rows: readonly OrgIntegration[]): OrgIntegration | null {
  let worst: OrgIntegration | null = null;
  for (const row of rows) {
    if (worst === null || STATE_RANK[row.state] > STATE_RANK[worst.state]) worst = row;
  }
  return worst;
}

export function accountingConnectorState(status: string): ConnectorState {
  switch (status) {
    case 'connected':
      return 'connected';
    case 'reauth_required':
      return 'reauth_required';
    case 'disconnected':
      return 'disconnected';
    default:
      return 'error';
  }
}

export interface AccountingMappingRow {
  linkStatus: string;
  syncStatus: string;
  lastError: string | null;
}

/** `null` = not a mapping at all (`unlinked`); the web then treats the system as "not linked". */
export function accountingMappingState(row: AccountingMappingRow): MappingState | null {
  if (row.linkStatus === 'unlinked') return null;
  if (row.linkStatus === 'suggested' || row.linkStatus === 'create_new') {
    return { state: 'pending', reason: 'suggested_match' };
  }
  if (row.syncStatus === 'error' || row.lastError !== null) return { state: 'error', reason: 'sync_error' };
  return { state: 'linked' };
}

export interface ParentIntegrationRow {
  isActive: boolean;
  lastSyncStatus: string | null;
}

/** Huntress / SentinelOne: the parent integration decides the org mapping's state. */
export function parentMappingState(parent: ParentIntegrationRow): MappingState {
  if (!parent.isActive || parent.lastSyncStatus === 'error') return { state: 'error', reason: 'connector_error' };
  if (parent.lastSyncStatus === null) return { state: 'pending', reason: 'never_synced' };
  return { state: 'linked' };
}

/**
 * Pax8 / Huntress / SentinelOne connector state from every row the partner has.
 * `null` = the partner has no row, so the system is never mentioned.
 * `failedValue` is what the sync worker writes on failure: 'failed' for Pax8
 * (pax8SyncService.ts), 'error' for Huntress/S1 (huntressSync.ts, s1Sync.ts).
 */
export function activeRowConnectorState(
  rows: readonly ParentIntegrationRow[],
  failedValue: string,
): ConnectorState | null {
  if (rows.length === 0) return null;
  const active = rows.find((row) => row.isActive);
  if (!active) return 'disabled';
  return active.lastSyncStatus === failedValue ? 'error' : 'connected';
}

export interface M365Row {
  status: string;
  expiresAt: Date | null;
  lastErrorCode: string | null;
}

export function m365State(row: M365Row, now: Date): MappingState {
  if (row.status === 'degraded') return { state: 'error', reason: 'degraded' };
  if (row.status === 'suspended') return { state: 'error', reason: 'suspended' };
  if (row.lastErrorCode !== null) return { state: 'error', reason: 'error' };
  if (row.status === 'pending-consent' || row.status === 'verifying') return { state: 'pending', reason: 'consent_pending' };
  if (row.expiresAt !== null && row.expiresAt.getTime() < now.getTime()) return { state: 'pending', reason: 'expired' };
  return { state: 'linked' };
}

export interface DnsRow {
  lastSyncStatus: string | null;
}

/** dnsSyncJob writes 'success' / 'error'; NULL means the integration never ran. */
export function dnsState(row: DnsRow): MappingState {
  if (row.lastSyncStatus === null) return { state: 'pending', reason: 'never_synced' };
  if (row.lastSyncStatus === 'error') return { state: 'error', reason: 'sync_error' };
  return { state: 'linked' };
}

export function pax8MappingState(connector: ConnectorState): MappingState {
  return connector === 'error' ? { state: 'error', reason: 'sync_failed' } : { state: 'linked' };
}

/**
 * The accounting join IS the tenancy predicate: accounting_entity_mappings is
 * partner-axis RLS and has no org_id, so the mapping → connection join must
 * carry the partner explicitly (spec, Integrations table row 1).
 */
export function accountingConnectionJoin(partnerId: string): SQL {
  return and(
    eq(accountingEntityMappings.integrationId, accountingConnections.id),
    eq(accountingConnections.partnerId, partnerId),
  ) as SQL;
}

const SYSTEM_ORDER: Record<IntegrationSystem, number> = {
  quickbooks: 0,
  xero: 1,
  psa: 2,
  pax8: 3,
  m365: 4,
  dns_filter: 5,
  huntress: 6,
  sentinelone: 7,
  external: 8,
};

export interface OrgIntegrationRow {
  orgId: string;
  integration: OrgIntegration;
}

/** Group per (org, system) — external rows per (org, label) — collapse each group to its worst state, order systems. */
export function aggregateIntegrations(
  orgIds: readonly string[],
  rows: readonly OrgIntegrationRow[],
): Map<string, OrgIntegration[]> {
  const groups = new Map<string, Map<string, OrgIntegration[]>>();
  for (const id of orgIds) groups.set(id, new Map());
  for (const { orgId, integration } of rows) {
    const orgGroups = groups.get(orgId);
    if (!orgGroups) continue;
    const key = integration.system === 'external' ? `external:${integration.label ?? ''}` : integration.system;
    const bucket = orgGroups.get(key);
    if (bucket) bucket.push(integration);
    else orgGroups.set(key, [integration]);
  }
  const out = new Map<string, OrgIntegration[]>();
  for (const [orgId, orgGroups] of groups) {
    const collapsed: OrgIntegration[] = [];
    for (const bucket of orgGroups.values()) {
      const worst = worstState(bucket);
      if (worst) collapsed.push(worst);
    }
    collapsed.sort(
      (a, b) =>
        SYSTEM_ORDER[a.system] - SYSTEM_ORDER[b.system] || (a.label ?? '').localeCompare(b.label ?? ''),
    );
    out.set(orgId, collapsed);
  }
  return out;
}

export interface SourceResult {
  connectors: Connector[];
  rows: OrgIntegrationRow[];
}

const EMPTY: SourceResult = { connectors: [], rows: [] };

function accountingSystem(provider: string): 'quickbooks' | 'xero' {
  return provider === 'xero' ? 'xero' : 'quickbooks';
}

/**
 * `organization_external_links.system` values that belong to the accounting
 * vocabulary (written by the QuickBooks/Xero customer import — see
 * services/accounting/quickbooksCustomerImport.ts's `externalSystem: PROVIDER`,
 * read back by accountingMappingService.ts). loadAccounting already reports
 * the real mapping for these under accounting:read (or withholds it entirely
 * without that grant); an "external identity" fallback must never also claim
 * them, or a QuickBooks-linked org gets the same system rendered twice — once
 * real, once as a meaningless identity badge — and a caller without
 * accounting:read would see the identity badge as a substitute leak of a
 * fact the grant was meant to withhold.
 */
const ACCOUNTING_EXTERNAL_LINK_SYSTEMS = new Set(['quickbooks', 'xero']);

/**
 * QuickBooks / Xero. Gated on accounting:read (spec: "accounting additionally
 * accounting:read"): without it neither the connector nor any org badge exists.
 */
export async function loadAccounting(
  partnerId: string,
  orgIds: readonly string[],
  grants: IntegrationGrants,
): Promise<SourceResult> {
  if (!grants.accounting) return EMPTY;
  const connections = await db
    .select({
      id: accountingConnections.id,
      provider: accountingConnections.provider,
      status: accountingConnections.status,
    })
    .from(accountingConnections)
    .where(eq(accountingConnections.partnerId, partnerId));
  const connectors: Connector[] = connections.map((c) => ({
    system: accountingSystem(c.provider),
    state: accountingConnectorState(c.status),
  }));
  if (connections.length === 0 || orgIds.length === 0) return { connectors, rows: [] };

  const mappings = await db
    .select({
      orgId: accountingEntityMappings.breezeEntityId,
      provider: accountingConnections.provider,
      linkStatus: accountingEntityMappings.linkStatus,
      syncStatus: accountingEntityMappings.syncStatus,
      lastError: accountingEntityMappings.lastError,
    })
    .from(accountingEntityMappings)
    .innerJoin(accountingConnections, accountingConnectionJoin(partnerId))
    .where(
      and(
        eq(accountingEntityMappings.breezeEntityType, 'org'),
        inArray(accountingEntityMappings.breezeEntityId, [...orgIds]),
      ),
    );
  const rows: OrgIntegrationRow[] = [];
  for (const m of mappings) {
    const state = accountingMappingState(m);
    if (state) rows.push({ orgId: m.orgId, integration: { system: accountingSystem(m.provider), ...state } });
  }
  return { connectors, rows };
}

/**
 * PSA (partner-level connections + org-level connections + provider-matching
 * external links) and external identity (every other external link, except
 * ACCOUNTING_EXTERNAL_LINK_SYSTEMS — those belong to loadAccounting). One
 * psa_connections query — partner axis OR accepted org ids — and one
 * organization_external_links query; the split happens here.
 */
export async function loadPsaAndExternal(
  partnerId: string,
  orgIds: readonly string[],
): Promise<SourceResult> {
  const partnerLevel = and(eq(psaConnections.partnerId, partnerId), isNull(psaConnections.orgId)) as SQL;
  const connections = await db
    .select({ orgId: psaConnections.orgId, provider: psaConnections.provider, enabled: psaConnections.enabled })
    .from(psaConnections)
    .where(orgIds.length === 0 ? partnerLevel : (or(partnerLevel, inArray(psaConnections.orgId, [...orgIds])) as SQL));

  const connectors: Connector[] = [];
  const psaProviders = new Set<string>();
  const enabledProviders = new Set<string>();
  const rows: OrgIntegrationRow[] = [];
  for (const c of connections) {
    if (c.orgId === null) {
      connectors.push({ system: 'psa', state: c.enabled ? 'connected' : 'disabled', provider: c.provider });
      psaProviders.add(c.provider);
      if (c.enabled) enabledProviders.add(c.provider);
    } else {
      rows.push({
        orgId: c.orgId,
        integration: c.enabled ? { system: 'psa', state: 'linked' } : { system: 'psa', state: 'error', reason: 'disabled' },
      });
    }
  }
  if (orgIds.length === 0) return { connectors, rows };

  const links = await db
    .select({ orgId: organizationExternalLinks.orgId, system: organizationExternalLinks.system })
    .from(organizationExternalLinks)
    .where(inArray(organizationExternalLinks.orgId, [...orgIds]));
  const identity: OrgIntegrationRow[] = [];
  for (const link of links) {
    if (enabledProviders.has(link.system)) {
      rows.push({ orgId: link.orgId, integration: { system: 'psa', state: 'linked' } });
    } else if (!psaProviders.has(link.system) && !ACCOUNTING_EXTERNAL_LINK_SYSTEMS.has(link.system)) {
      identity.push({ orgId: link.orgId, integration: { system: 'external', state: 'identity', label: link.system } });
    }
    // A link for a partner-level provider that is DISABLED is consumed by the
    // PSA check (its repair is the connector, reported once in the band) and
    // is deliberately neither a PSA row nor an identity badge.
  }
  return { connectors, rows: [...rows, ...identity] };
}

/** Pax8. Gated on billing:manage — the grant every Pax8 read route requires (routes/pax8.ts). */
export async function loadPax8(
  partnerId: string,
  orgIds: readonly string[],
  grants: IntegrationGrants,
): Promise<SourceResult> {
  if (!grants.pax8) return EMPTY;
  const integrations = await db
    .select({ id: pax8Integrations.id, isActive: pax8Integrations.isActive, lastSyncStatus: pax8Integrations.lastSyncStatus })
    .from(pax8Integrations)
    .where(eq(pax8Integrations.partnerId, partnerId));
  const state = activeRowConnectorState(integrations, 'failed');
  if (state === null) return EMPTY;
  const connectors: Connector[] = [{ system: 'pax8', state }];
  const active = integrations.find((row) => row.isActive);
  if (!active || orgIds.length === 0) return { connectors, rows: [] };

  const mappings = await db
    .select({ orgId: pax8CompanyMappings.orgId })
    .from(pax8CompanyMappings)
    .where(
      and(
        eq(pax8CompanyMappings.integrationId, active.id),
        eq(pax8CompanyMappings.partnerId, partnerId),
        eq(pax8CompanyMappings.ignored, false),
        inArray(pax8CompanyMappings.orgId, [...orgIds]),
      ),
    );
  const mappingState = pax8MappingState(state);
  const rows: OrgIntegrationRow[] = [];
  for (const m of mappings) {
    if (m.orgId !== null) rows.push({ orgId: m.orgId, integration: { system: 'pax8', ...mappingState } });
  }
  return { connectors, rows };
}

/** Microsoft 365: one row per (org, profile); revoked rows are excluded in SQL. No partner connector exists. */
export async function loadM365(orgIds: readonly string[], now: Date): Promise<SourceResult> {
  if (orgIds.length === 0) return EMPTY;
  const connections = await db
    .select({
      orgId: m365Connections.orgId,
      status: m365Connections.status,
      expiresAt: m365Connections.expiresAt,
      lastErrorCode: m365Connections.lastErrorCode,
    })
    .from(m365Connections)
    .where(
      and(
        inArray(m365Connections.orgId, [...orgIds]),
        isNull(m365Connections.revokedAt),
        ne(m365Connections.status, 'revoked'),
      ),
    );
  const rows: OrgIntegrationRow[] = [];
  for (const c of connections) {
    if (c.orgId !== null) rows.push({ orgId: c.orgId, integration: { system: 'm365', ...m365State(c, now) } });
  }
  return { connectors: [], rows };
}

/** DNS filter: active integrations of the accepted orgs. No partner connector exists. */
export async function loadDns(orgIds: readonly string[]): Promise<SourceResult> {
  if (orgIds.length === 0) return EMPTY;
  const integrations = await db
    .select({ orgId: dnsFilterIntegrations.orgId, lastSyncStatus: dnsFilterIntegrations.lastSyncStatus })
    .from(dnsFilterIntegrations)
    .where(and(inArray(dnsFilterIntegrations.orgId, [...orgIds]), eq(dnsFilterIntegrations.isActive, true)));
  return {
    connectors: [],
    rows: integrations.map((row) => ({ orgId: row.orgId, integration: { system: 'dns_filter', ...dnsState(row) } })),
  };
}

export async function loadHuntress(partnerId: string, orgIds: readonly string[]): Promise<SourceResult> {
  const integrations = await db
    .select({ id: huntressIntegrations.id, isActive: huntressIntegrations.isActive, lastSyncStatus: huntressIntegrations.lastSyncStatus })
    .from(huntressIntegrations)
    .where(eq(huntressIntegrations.partnerId, partnerId));
  const state = activeRowConnectorState(integrations, 'error');
  if (state === null) return EMPTY;
  const connectors: Connector[] = [{ system: 'huntress', state }];
  if (orgIds.length === 0) return { connectors, rows: [] };

  const mappings = await db
    .select({
      orgId: huntressOrgMappings.orgId,
      isActive: huntressIntegrations.isActive,
      lastSyncStatus: huntressIntegrations.lastSyncStatus,
    })
    .from(huntressOrgMappings)
    .innerJoin(
      huntressIntegrations,
      and(eq(huntressOrgMappings.integrationId, huntressIntegrations.id), eq(huntressIntegrations.partnerId, partnerId)),
    )
    .where(and(eq(huntressOrgMappings.partnerId, partnerId), inArray(huntressOrgMappings.orgId, [...orgIds])));
  const rows: OrgIntegrationRow[] = [];
  for (const m of mappings) {
    if (m.orgId !== null) rows.push({ orgId: m.orgId, integration: { system: 'huntress', ...parentMappingState(m) } });
  }
  return { connectors, rows };
}

export async function loadSentinelOne(partnerId: string, orgIds: readonly string[]): Promise<SourceResult> {
  const integrations = await db
    .select({ id: s1Integrations.id, isActive: s1Integrations.isActive, lastSyncStatus: s1Integrations.lastSyncStatus })
    .from(s1Integrations)
    .where(eq(s1Integrations.partnerId, partnerId));
  const state = activeRowConnectorState(integrations, 'error');
  if (state === null) return EMPTY;
  const connectors: Connector[] = [{ system: 'sentinelone', state }];
  if (orgIds.length === 0) return { connectors, rows: [] };

  const mappings = await db
    .select({
      orgId: s1OrgMappings.orgId,
      isActive: s1Integrations.isActive,
      lastSyncStatus: s1Integrations.lastSyncStatus,
    })
    .from(s1OrgMappings)
    .innerJoin(
      s1Integrations,
      and(eq(s1OrgMappings.integrationId, s1Integrations.id), eq(s1Integrations.partnerId, partnerId)),
    )
    .where(and(eq(s1OrgMappings.partnerId, partnerId), inArray(s1OrgMappings.orgId, [...orgIds])));
  const rows: OrgIntegrationRow[] = [];
  for (const m of mappings) {
    if (m.orgId !== null) rows.push({ orgId: m.orgId, integration: { system: 'sentinelone', ...parentMappingState(m) } });
  }
  return { connectors, rows };
}

/**
 * Entry point. Runs inside the caller's request transaction (single
 * connection): Promise.all is orchestration only, not parallelism. Never
 * escape the context to get parallelism (spec, implementation rules).
 */
export async function loadIntegrationReadiness(input: {
  partnerId: string;
  orgIds: readonly string[];
  grants: IntegrationGrants;
  now: Date;
}): Promise<IntegrationReadiness> {
  const { partnerId, orgIds, grants, now } = input;
  const sources = await Promise.all([
    loadAccounting(partnerId, orgIds, grants),
    loadPsaAndExternal(partnerId, orgIds),
    loadPax8(partnerId, orgIds, grants),
    loadM365(orgIds, now),
    loadDns(orgIds),
    loadHuntress(partnerId, orgIds),
    loadSentinelOne(partnerId, orgIds),
  ]);
  const connectors = sources.flatMap((s) => s.connectors);
  const rows = sources.flatMap((s) => s.rows);
  return { connectors, byOrg: aggregateIntegrations(orgIds, rows) };
}
