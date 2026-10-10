import type { z } from 'zod';
import type {
  EdrActionKey, EdrDetectionStatus, EdrEndpointHealth, EdrEndpointType, EdrIsolationState,
  EdrOsPlatform, EdrSeverity, EdrVendorKind,
} from '@breeze/shared';
import type { EdrProviderKey } from './registry';

export type EdrErrorScope = 'connection' | 'tenant' | 'operation';

export class EdrProviderRequestError extends Error {
  readonly code: string;
  readonly reauth: boolean;
  readonly scope: EdrErrorScope;
  readonly retryAfterMs?: number;
  constructor(
    message: string,
    o: { code: string; reauth: boolean; scope: EdrErrorScope; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, o.cause !== undefined ? { cause: o.cause } : undefined);
    this.name = 'EdrProviderRequestError';
    this.code = o.code;
    this.reauth = o.reauth;
    this.scope = o.scope;
    this.retryAfterMs = o.retryAfterMs;
  }
}

/** Operation classes with their own narrower vendor budget (`operationBudgets`). */
export type EdrOperationClass = 'inventory' | 'companies' | 'incidents' | (string & {});

export interface EdrCapabilities {
  tenantModel: 'partner' | 'single';
  perTenantHost: boolean;
  detectionDelivery: 'poll' | 'poll_and_push';
  /** How status changes on already-seen detections arrive (spec 4.3 cursor contract). */
  detectionStatusModel: 'delta_with_updates' | 'reread_open_on_inventory';
  actions: readonly EdrActionKey[];
  endpointIdentifiers: readonly ('hostname' | 'fqdn' | 'mac' | 'serial' | 'ip')[];
  installer: 'none' | 'static_url_with_token' | 'api_generated_link';
  requestBudget: { perSecond?: number; perMinute?: number; perHour?: number; perDay?: number };
  /** Narrower per-operation-class limits (GravityZone inventory/companies 5/s, incidents 10/min). */
  operationBudgets?: Readonly<Record<string, { perSecond?: number; perMinute?: number }>>;
  defaultIntervals: { detectionsMinutes: number; inventoryMinutes: number };
  maxActionTargets: number;
  firstSyncLookbackDays: number;
  tenantFetchConcurrency: number;
}

export interface VendorEdrTenant {
  vendorTenantId: string; name: string; parentId: string | null;
  tenantType: string | null; externalCode: string | null; apiHost: string | null;
}
export type VendorEdrTenantRef = Pick<VendorEdrTenant, 'vendorTenantId' | 'apiHost'>;

export interface VendorEdrEndpoint {
  vendorEndpointId: string; vendorTenantId: string; hostname: string | null;
  fqdn: string | null; serialNumber: string | null; macAddresses: string[]; ipAddresses: string[];
  osPlatform: EdrOsPlatform; osName: string | null; endpointType: EdrEndpointType; agentVersion: string | null;
  health: EdrEndpointHealth; online: boolean | null; isolationState: EdrIsolationState;
  tamperProtection: boolean | null; policyName: string | null; lastSeenAt: Date | null;
  raw: Record<string, unknown>;
}
export type VendorEdrEndpointDetail = Partial<Pick<VendorEdrEndpoint,
  'health' | 'online' | 'lastSeenAt' | 'agentVersion' | 'osName' | 'serialNumber'>> & { vendorEndpointId: string };

export interface VendorEdrDetection {
  vendorDetectionId: string; vendorKind: EdrVendorKind; vendorTenantId: string;
  vendorEndpointId: string | null; severity: EdrSeverity; vendorSeverity: string | null;
  status: EdrDetectionStatus; vendorStatus: string | null; title: string | null;
  category: string | null; threatName: string | null; filePath: string | null;
  processName: string | null; mitreTechniques: string[]; detectedAt: Date | null;
  resolvedAt: Date | null; lastVendorUpdateAt: Date | null; details: Record<string, unknown>;
}
export interface EdrDetectionPage {
  detections: VendorEdrDetection[];
  cursor: string | null;
  /** Operation-scope degradations that did not fail the tenant (e.g. "incidents: API not enabled on key"). */
  warnings: string[];
}

export type EdrTestResult =
  | { ok: true; rootId: string; rootName: string; rootType: string; tenantCount: number; capabilityNotes: string[] }
  | { ok: false; error: string; reauth: boolean };

export type GuardedFetch = (
  url: string,
  init: { method: 'GET' | 'POST' | 'PATCH'; headers: Record<string, string>; body?: string; timeoutMs?: number },
) => Promise<{ status: number; headers: Headers; text(): Promise<string> }>;

export interface EdrRateLimiter { acquire(operationClass?: string): Promise<void> }

export interface EdrAdapterContext {
  creds: unknown; baseUrl: string | null; region: string | null;
  fetch: GuardedFetch; limiter: EdrRateLimiter;
  /** Per-sync-run memo so a connection-wide vendor call (GravityZone quarantine) is made once per run. */
  runCache: Map<string, Promise<unknown>>;
}

export interface EdrCredentialField { name: string; label: string; secret: boolean; required: boolean }

export interface EdrProviderAdapter {
  readonly key: EdrProviderKey;
  readonly label: string;
  readonly credentialsSchema: z.ZodTypeAny;
  readonly credentialFields: readonly EdrCredentialField[];
  /** Validates an operator-supplied base URL; null = adapter has a fixed host. */
  readonly baseUrlPolicy: { required: boolean; pathPrefix?: string } | null;
  readonly capabilities: EdrCapabilities;
  readonly hostAllowlist: readonly string[];
  testConnection(ctx: EdrAdapterContext): Promise<EdrTestResult>;
  listTenants(ctx: EdrAdapterContext, root: { id: string; type: string | null }): Promise<VendorEdrTenant[]>;
  listEndpoints(ctx: EdrAdapterContext, tenant: VendorEdrTenantRef): Promise<VendorEdrEndpoint[]>;
  countEndpoints?(ctx: EdrAdapterContext, tenant: VendorEdrTenantRef): Promise<number>;
  enrichEndpoints?(ctx: EdrAdapterContext, tenant: VendorEdrTenantRef, vendorEndpointIds: string[]): Promise<VendorEdrEndpointDetail[]>;
  listDetections(ctx: EdrAdapterContext, tenant: VendorEdrTenantRef, cursor: string | null, now: Date): Promise<EdrDetectionPage>;
  // Declared now, implemented from W03 (types only in W01 — no framework code calls them):
  performAction?(...a: unknown[]): Promise<unknown>;
  supportsAction?(...a: unknown[]): boolean;
  getActionStatus?(...a: unknown[]): Promise<unknown>;
  getDetections?(...a: unknown[]): Promise<VendorEdrDetection[]>;
  verifyWebhook?(...a: unknown[]): unknown;
  getInstaller?(...a: unknown[]): Promise<unknown>;
}
