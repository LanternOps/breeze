/**
 * Typed client for the EDR provider framework routes (#8164 W01b / #8166 W02).
 *
 * Queries throw `HttpError` on a non-ok response — never an empty list, because
 * "no EDR data" and "we could not ask" are different facts. Mutations all go
 * through `runAction` (toast + ActionError on a failure, including a 200
 * `{success:false}`); callers pass their own translated `errorFallback`.
 */
import type {
  EdrConnectionStatus,
  EdrCoverage,
  EdrDetectionDto,
  EdrDetectionStatus,
  EdrEndpointHealth,
  EdrIsolationState,
  EdrMappingSource,
  EdrSeverity,
  EdrStatusProviderSummary,
  EdrStatusSummary,
  EdrSyncStatus,
} from '@breeze/shared';
import { fetchWithAuth } from '../stores/auth';
import { throwIfNotOk } from './httpError';
import { runAction, type RunActionOptions } from './runAction';

export type { EdrCoverage, EdrDetectionDto, EdrStatusProviderSummary, EdrStatusSummary };

// ---------------------------------------------------------------- shapes

export interface EdrCredentialField {
  name: string;
  label: string;
  secret: boolean;
  required: boolean;
}

export interface EdrProviderDescriptor {
  key: string;
  label: string;
  credentialFields: EdrCredentialField[];
  baseUrlPolicy: { required: boolean; pathPrefix?: string } | null;
  capabilities: {
    tenantModel?: 'partner' | 'single';
    defaultIntervals?: { detectionsMinutes: number; inventoryMinutes: number };
    actions?: string[];
    [key: string]: unknown;
  };
}

/** `EDR_CONNECTION_PUBLIC_SELECT` (apps/api/src/routes/edr/access.ts). */
export interface EdrConnection {
  id: string;
  partnerId: string;
  provider: string;
  name: string;
  baseUrl: string | null;
  region: string | null;
  vendorRootId: string | null;
  vendorRootName: string | null;
  vendorRootType: string | null;
  isActive: boolean;
  status: EdrConnectionStatus;
  detectionIntervalMinutes: number | null;
  inventoryIntervalMinutes: number | null;
  effectiveDetectionIntervalMinutes: number | null;
  effectiveInventoryIntervalMinutes: number | null;
  lastInventorySyncAt: string | null;
  lastInventorySyncStatus: EdrSyncStatus | null;
  lastInventorySyncError: string | null;
  lastDetectionSyncAt: string | null;
  lastDetectionSyncStatus: EdrSyncStatus | null;
  lastDetectionSyncError: string | null;
  lastSyncTenants: number | null;
  lastSyncUnmappedTenants: number | null;
  lastSyncFailedTenants: number | null;
  lastSyncEndpoints: number | null;
  lastSyncLinkedEndpoints: number | null;
  lastSyncAmbiguousEndpoints: number | null;
  lastSyncOpenDetections: number | null;
  capabilitiesSnapshot: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  hasCredentials: boolean;
  hasWebhookSecret: boolean;
}

/** `EDR_TENANT_PUBLIC_SELECT` + `orgName` (GET /edr/connections/:id/tenants). */
export interface EdrTenant {
  id: string;
  connectionId: string;
  vendorTenantId: string;
  vendorTenantName: string | null;
  vendorParentId: string | null;
  vendorTenantType: string | null;
  vendorExternalCode: string | null;
  apiHost: string | null;
  orgId: string | null;
  orgName: string | null;
  mappingSource: EdrMappingSource | null;
  endpointCount: number | null;
  openDetectionCount: number | null;
  lastSeenAt: string | null;
  vendorMissingSince: string | null;
  lastInventorySyncAt: string | null;
  lastInventorySyncStatus: EdrSyncStatus | null;
  lastInventorySyncError: string | null;
  lastDetectionSyncAt: string | null;
  lastDetectionSyncStatus: EdrSyncStatus | null;
  lastDetectionSyncError: string | null;
  hasInstallerSecret: boolean;
}

/** Name-match suggestion: shown as a badge, NEVER applied automatically (spec §4.5). */
export interface EdrTenantSuggestion {
  tenantId: string;
  orgId: string;
}

export interface EdrTenantList {
  rows: EdrTenant[];
  suggestions: EdrTenantSuggestion[];
  summary: { tenants: number; unmappedTenants: number; unmappedEndpointCount: number };
}

export interface EdrEndpoint {
  id: string;
  orgId: string;
  connectionId: string;
  tenantId: string;
  tenantName: string | null;
  provider: string;
  vendorEndpointId: string;
  hostname: string | null;
  fqdn: string | null;
  osPlatform: string | null;
  osName: string | null;
  agentVersion: string | null;
  health: EdrEndpointHealth;
  online: boolean | null;
  isolationState: EdrIsolationState;
  lastSeenAt: string | null;
  breezeDeviceId: string | null;
  deviceMatchSource: string | null;
}

export type EdrEndpointState = 'unlinked' | 'ambiguous' | 'linked' | 'all';

export interface EdrEndpointQuery {
  connectionId?: string;
  orgId?: string;
  deviceId?: string;
  state?: EdrEndpointState;
}

export interface EdrDetectionQuery {
  orgId?: string;
  deviceId?: string;
  severity?: EdrSeverity[];
  status?: 'open' | 'all' | EdrDetectionStatus;
  provider?: string;
  limit?: number;
  offset?: number;
}

export interface EdrDetectionPage {
  rows: EdrDetectionDto[];
  total: number;
  limit: number;
  offset: number;
  coverage: EdrCoverage;
}

export interface EdrConnectionCreateBody {
  provider: string;
  name: string;
  baseUrl?: string;
  credentials: Record<string, string>;
  detectionIntervalMinutes?: number;
  inventoryIntervalMinutes?: number;
}

export interface EdrConnectionPatchBody {
  name?: string;
  isActive?: boolean;
  detectionIntervalMinutes?: number | null;
  inventoryIntervalMinutes?: number | null;
  credentials?: Record<string, string>;
  baseUrl?: string;
}

export interface EdrConnectionTestResult {
  success: boolean;
  message?: string;
  error?: string;
  reauth?: boolean;
  rootName?: string;
  tenantCount?: number;
}

/** Body of the 409 `CONFIRM_COUNTS` a bare DELETE answers with. */
export interface EdrDeleteConfirmCounts {
  detections: number;
  endpoints: number;
  tenants?: number;
}

/** The runAction knobs a caller supplies (translated copy, quiet paths). */
export type EdrActionOptions<T = unknown> = Pick<
  RunActionOptions<T>,
  'errorFallback' | 'successMessage' | 'suppressErrorToast' | 'friendly'
>;

const EMPTY_COVERAGE: EdrCoverage = { orgsWithEdr: 0, partial: false, notes: [] };

// ---------------------------------------------------------------- helpers

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

async function getJson(path: string): Promise<Record<string, unknown>> {
  const res = await fetchWithAuth(path);
  throwIfNotOk(res);
  const body = await res.json();
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function mutate<T>(path: string, method: string, opts: EdrActionOptions<T>, body?: unknown): Promise<T> {
  return runAction<T>({
    ...opts,
    request: () =>
      fetchWithAuth(path, {
        method,
        ...(body !== undefined
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
          : {}),
      }),
  });
}

// ---------------------------------------------------------------- queries

export async function fetchEdrProviders(): Promise<EdrProviderDescriptor[]> {
  return asArray<EdrProviderDescriptor>((await getJson('/edr/providers')).data);
}

export async function fetchEdrConnections(): Promise<EdrConnection[]> {
  return asArray<EdrConnection>((await getJson('/edr/connections')).data);
}

export async function fetchEdrTenants(connectionId: string): Promise<EdrTenantList> {
  const body = await getJson(`/edr/connections/${connectionId}/tenants`);
  const rows = asArray<EdrTenant>(body.data);
  const summary = (body.summary ?? {}) as Partial<EdrTenantList['summary']>;
  return {
    rows,
    suggestions: asArray<EdrTenantSuggestion>(body.suggestions),
    summary: {
      tenants: Number(summary.tenants ?? rows.length),
      unmappedTenants: Number(summary.unmappedTenants ?? 0),
      unmappedEndpointCount: Number(summary.unmappedEndpointCount ?? 0),
    },
  };
}

export async function fetchEdrEndpoints(q: EdrEndpointQuery = {}): Promise<EdrEndpoint[]> {
  const body = await getJson(
    `/edr/endpoints${qs({ connectionId: q.connectionId, orgId: q.orgId, deviceId: q.deviceId, state: q.state })}`,
  );
  return asArray<EdrEndpoint>(body.data);
}

export async function fetchEdrDetections(q: EdrDetectionQuery): Promise<EdrDetectionPage> {
  const body = await getJson(
    `/edr/detections${qs({
      orgId: q.orgId,
      deviceId: q.deviceId,
      severity: q.severity && q.severity.length > 0 ? q.severity.join(',') : undefined,
      status: q.status,
      provider: q.provider,
      limit: q.limit,
      offset: q.offset,
    })}`,
  );
  const rows = asArray<EdrDetectionDto>(body.data);
  const pagination = (body.pagination ?? {}) as { limit?: number; offset?: number; total?: number };
  return {
    rows,
    total: Number(pagination.total ?? rows.length),
    limit: Number(pagination.limit ?? q.limit ?? rows.length),
    offset: Number(pagination.offset ?? q.offset ?? 0),
    // A missing coverage block is NOT "complete": treat it as partial so an
    // empty list never reads as an all-clear.
    coverage: (body.coverage as EdrCoverage | undefined) ?? { ...EMPTY_COVERAGE, partial: true },
  };
}

export async function fetchEdrStatus(q: { orgId?: string } = {}): Promise<EdrStatusSummary> {
  const body = await getJson(`/edr/status${qs({ orgId: q.orgId })}`);
  const data = (body.data ?? {}) as Partial<EdrStatusSummary>;
  return {
    providers: asArray<EdrStatusProviderSummary>(data.providers),
    coverage: data.coverage ?? { ...EMPTY_COVERAGE, partial: true },
  };
}

// ---------------------------------------------------------------- mutations

export function createEdrConnection(body: EdrConnectionCreateBody, opts: EdrActionOptions) {
  return mutate<{ data: EdrConnection; syncWarning?: string }>('/edr/connections', 'POST', opts, body);
}

export function patchEdrConnection(id: string, body: EdrConnectionPatchBody, opts: EdrActionOptions) {
  return mutate<{ data: EdrConnection }>(`/edr/connections/${id}`, 'PATCH', opts, body);
}

export function testEdrConnection(id: string, opts: EdrActionOptions<EdrConnectionTestResult>) {
  return mutate<EdrConnectionTestResult>(`/edr/connections/${id}/test`, 'POST', opts);
}

export function syncEdrConnection(id: string, opts: EdrActionOptions) {
  return mutate<{ success: boolean; syncJobIds?: string[] }>(`/edr/connections/${id}/sync`, 'POST', opts);
}

/**
 * Hard delete (D13). The API refuses a bare DELETE with a 409 `CONFIRM_COUNTS`
 * carrying the detection/endpoint counts; the caller shows them, then repeats
 * the call with `counts` to confirm.
 */
export function deleteEdrConnection(id: string, counts: EdrDeleteConfirmCounts | null, opts: EdrActionOptions) {
  const suffix = counts ? qs({ confirm: `${counts.detections}:${counts.endpoints}` }) : '';
  return mutate<{ success: boolean }>(`/edr/connections/${id}${suffix}`, 'DELETE', opts);
}

// ---------------------------------------------------------------- labels

/**
 * Display labels for EDR-framework provider keys, mirroring
 * `apps/api/src/services/edrProviders/providerKeys.ts` (`EDR_PROVIDER_LABELS`).
 * Surfaces that receive only a key (the incidents feed `source`) use this;
 * surfaces that receive `providerLabel`/`label` from the API prefer that.
 * Vendor product names are not translated.
 */
export const EDR_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  bitdefender: 'Bitdefender GravityZone',
};

/** The known label for a provider key, or null so callers render a translated generic fallback. */
export function edrProviderLabel(key: string | null | undefined): string | null {
  if (!key) return null;
  return Object.prototype.hasOwnProperty.call(EDR_PROVIDER_LABELS, key) ? (EDR_PROVIDER_LABELS[key] ?? null) : null;
}

/** `orgId: null` = deliberately leave unmapped. The key is always sent (`{}` is invalid). */
export function mapEdrTenant(tenantId: string, orgId: string | null, opts: EdrActionOptions) {
  return mutate<{ data: unknown }>(`/edr/tenants/${tenantId}/mapping`, 'PUT', opts, { orgId });
}

/** `deviceId: null` = unlink. The key is always sent (`{}` is invalid). */
export function linkEdrEndpoint(endpointId: string, deviceId: string | null, opts: EdrActionOptions) {
  return mutate<{ data: unknown }>(`/edr/endpoints/${endpointId}/link`, 'PUT', opts, { deviceId });
}
