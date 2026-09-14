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
import { and, eq, type SQL } from 'drizzle-orm';
import { accountingConnections, accountingEntityMappings } from '../db/schema';

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
