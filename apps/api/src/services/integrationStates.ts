/**
 * Pure integration state functions, shared by the organizations account board
 * (orgAccountReadinessIntegrations.ts, which re-exports the board half) and the
 * connection health sources (services/connectionHealth/sources/*), so the board
 * badge and the health incident read one truth. No database access here.
 */
export type ConnectorSystem = 'quickbooks' | 'xero' | 'psa' | 'pax8' | 'huntress' | 'sentinelone' | 'edr';
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
  /** `edr` rows only: the Breeze display label of the single mapped provider; omitted when several map the org. */
  provider?: string;
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
    case 'pending_tenant': // a half-finished connect is not a working connection
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

// ---------------------------------------------------------------------------
// Connection health verdicts (connection health spec 2026-10-15 §3; the W2
// plan's Sources table is the contract). One verdict per connection row. The
// board functions above decide the board badge; these reuse them where the
// meaning is the same, so a connection the board shows in error is the one the
// health source reports broken.
// ---------------------------------------------------------------------------

export type HealthVerdict =
  | { state: 'healthy' | 'unknown' | 'retired' }
  | { state: 'broken'; severity: 'permanent' | 'transient'; condition: string };

const HEALTHY: HealthVerdict = { state: 'healthy' };
const UNKNOWN: HealthVerdict = { state: 'unknown' };
const RETIRED: HealthVerdict = { state: 'retired' };
const transient = (condition: string): HealthVerdict => ({ state: 'broken', severity: 'transient', condition });
const permanent = (condition: string): HealthVerdict => ({ state: 'broken', severity: 'permanent', condition });

/** A sync status that proves the last run reached the vendor. */
const SYNC_OK: ReadonlySet<string> = new Set(['success', 'partial']);
const SUCCESS_ONLY: ReadonlySet<string> = new Set(['success']);

export interface ActiveSyncRow {
  isActive: boolean;
  lastSyncStatus: string | null;
}

/**
 * Huntress / SentinelOne / Pax8: the board's activeRowConnectorState decides
 * disabled and error; only an explicit success proves health, so `running`
 * (Huntress and Pax8 clear the error when a sync starts) and never-synced are
 * unknown, never a recovery.
 */
function activeSyncHealth(row: ActiveSyncRow, failedValue: string, okValues: ReadonlySet<string>): HealthVerdict {
  const connector = activeRowConnectorState([row], failedValue);
  if (connector === 'disabled') return RETIRED;
  if (connector === 'error') return transient('sync_failed');
  return row.lastSyncStatus !== null && okValues.has(row.lastSyncStatus) ? HEALTHY : UNKNOWN;
}

export const huntressHealth = (row: ActiveSyncRow): HealthVerdict => activeSyncHealth(row, 'error', SUCCESS_ONLY);
export const sentinelOneHealth = (row: ActiveSyncRow): HealthVerdict => activeSyncHealth(row, 'error', SYNC_OK);
export const pax8Health = (row: ActiveSyncRow): HealthVerdict => activeSyncHealth(row, 'failed', SUCCESS_ONLY);

/** UniFi: `status` carries reauth; the worker writes `failed` to last_sync_status. Disconnect deletes the row. */
export function unifiHealth(row: { isActive: boolean; status: string; lastSyncStatus: string | null }): HealthVerdict {
  if (!row.isActive) return RETIRED;
  if (row.status === 'reauth_required') return permanent('reauth_required');
  if (row.status === 'error' || row.lastSyncStatus === 'failed') return transient('sync_failed');
  if (row.status !== 'connected') return UNKNOWN;
  return row.lastSyncStatus !== null && SYNC_OK.has(row.lastSyncStatus) ? HEALTHY : UNKNOWN;
}

/**
 * Backup provider. A retry sets last_sync_status = 'running' and clears the
 * error (jobs/backupProviderSync.ts), so running is unknown, not recovery.
 * `partial` is written only when alert evaluation fails after a successful
 * vendor sync, so the connection itself is healthy.
 */
export function backupProviderHealth(row: { isActive: boolean; status: string; lastSyncStatus: string | null }): HealthVerdict {
  if (!row.isActive) return RETIRED;
  if (row.status === 'reauth_required') return permanent('reauth_required');
  if (row.status === 'error' || row.lastSyncStatus === 'error') return transient('sync_failed');
  return row.lastSyncStatus !== null && SYNC_OK.has(row.lastSyncStatus) ? HEALTHY : UNKNOWN;
}

/** EDR: connection-level reauth, else either stream's last run. A stream start clears only its own error. */
export function edrHealth(row: {
  isActive: boolean;
  status: string;
  lastInventorySyncStatus: string | null;
  lastDetectionSyncStatus: string | null;
}): HealthVerdict {
  if (!row.isActive) return RETIRED;
  if (row.status === 'reauth_required') return permanent('reauth_required');
  const streams = [row.lastInventorySyncStatus, row.lastDetectionSyncStatus];
  if (row.status === 'error' || streams.includes('error')) return transient('sync_failed');
  if (streams.includes('running')) return UNKNOWN;
  return streams.some((s) => s !== null && SYNC_OK.has(s)) ? HEALTHY : UNKNOWN;
}

/**
 * Accounting, via the board's accountingConnectorState. `pending_tenant` is a
 * connect in progress (abandoned rows are deleted), so it is unknown here even
 * though the board shows it as not connected.
 */
export function accountingHealth(row: { status: string }): HealthVerdict {
  if (row.status === 'pending_tenant') return UNKNOWN;
  switch (accountingConnectorState(row.status)) {
    case 'connected':
      return HEALTHY;
    case 'reauth_required':
      return permanent('reauth_required');
    case 'disconnected':
      return permanent('disconnected');
    default:
      return transient('error');
  }
}

/** DNS filter, via the board's dnsState. No UI path deactivates a row today; the schema allows it. */
export function dnsFilterHealth(row: { isActive: boolean; lastSyncStatus: string | null }): HealthVerdict {
  if (!row.isActive) return RETIRED;
  const s = dnsState(row);
  if (s.state === 'error') return transient('sync_failed');
  return s.state === 'linked' ? HEALTHY : UNKNOWN;
}

/** Degraded codes that need the customer to (re)consent; any other degraded code is transient. */
const M365_CONSENT_CODES: ReadonlySet<string> = new Set([
  'grant_missing',
  'grant_unexpected',
  'manifest_stale',
  'application_token_invalid',
  'tenant_mismatch',
]);

/**
 * M365 connection (org axis). `revoked` is written only by a deliberate
 * disconnect, so it is retired. Consent in progress is unknown. An `active`
 * row stays healthy even with an error code: the codes written without a status
 * change (executor_unavailable) describe Breeze infrastructure, not the tenant.
 */
export function m365ConnectionHealth(row: { status: string; lastErrorCode: string | null }): HealthVerdict {
  switch (row.status) {
    case 'active':
      return HEALTHY;
    case 'revoked':
      return RETIRED;
    case 'suspended':
      return permanent('suspended');
    case 'degraded':
      if (row.lastErrorCode && M365_CONSENT_CODES.has(row.lastErrorCode)) return permanent(row.lastErrorCode);
      return transient(row.lastErrorCode ?? 'degraded');
    default:
      return UNKNOWN;
  }
}

/**
 * M365 tenant sync, one verdict per connection over its domain rows. While the
 * parent connection is not active its own incident covers the tenant, so the
 * sync reports unknown instead of opening a second incident. No rows = the
 * connection was disconnected (lifecycle deletes them).
 */
export function m365SyncHealth(connectionStatus: string | null, domainStatuses: readonly (string | null)[]): HealthVerdict {
  if (domainStatuses.length === 0) return RETIRED;
  if (connectionStatus !== 'active') return UNKNOWN;
  if (domainStatuses.includes('needs_consent')) return permanent('needs_consent');
  if (domainStatuses.includes('error')) return transient('sync_failed');
  return domainStatuses.some((s) => s !== null && SYNC_OK.has(s)) ? HEALTHY : UNKNOWN;
}

/** Spec §3: a mailbox is broken after this many transient poll failures in a row. */
export const MAILBOX_TRANSIENT_FAILURE_THRESHOLD = 5;

/** Ticket mailbox. `disabled` is the deliberate disconnect (the row is kept). */
export function ticketMailboxHealth(row: { status: string; consecutiveTransientFailures: number }): HealthVerdict {
  switch (row.status) {
    case 'reauth_required':
      return permanent('reauth_required');
    case 'error':
      return transient('mailbox_error');
    case 'disabled':
      return RETIRED;
    case 'connected':
      return row.consecutiveTransientFailures >= MAILBOX_TRANSIENT_FAILURE_THRESHOLD ? transient('poll_failing') : HEALTHY;
    default:
      return UNKNOWN;
  }
}
