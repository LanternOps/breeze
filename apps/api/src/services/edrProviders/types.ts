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

/**
 * One normalized response action addressed to the vendor (W03). The target
 * carries VENDOR ids only, resolved by `dispatchEdrAction` from rows the caller
 * was authorized to read.
 */
export type EdrActionRequest =
  | { action: 'isolate' | 'unisolate' | 'scan' | 'update_agent'; target: { kind: 'endpoint'; vendorEndpointId: string } }
  | { action: 'kill_process'; target: { kind: 'process'; vendorEndpointId: string; pid: number } }
  | {
      action: 'rollback' | 'resolve_detection' | 'mark_false_positive';
      target: { kind: 'detection'; vendorDetectionId: string; vendorKind: EdrVendorKind };
    }
  | { action: 'quarantine_restore' | 'quarantine_delete'; target: { kind: 'quarantine_item'; vendorItemId: string } };

/**
 * `succeeded` = the vendor accepted (and, for a synchronous call, applied) it;
 * `submitted` = the vendor queued a task to poll; `failed` = a TERMINAL vendor
 * verdict, only ever returned by `getActionStatus` (a refused `performAction`
 * throws `EdrProviderRequestError` instead).
 */
export type EdrActionResult =
  | { status: 'succeeded' }
  | { status: 'submitted'; vendorActionId: string }
  | { status: 'failed'; code: string; message: string };

export type EdrActionSupport = { ok: true } | { ok: false; reason: string };

/** Everything `supportsAction` may look at — already-loaded row facts, no I/O. */
export interface EdrActionTargetFacts {
  vendorEndpointId: string | null;
  osPlatform: EdrOsPlatform | null;
  isolationState: EdrIsolationState | null;
  online: boolean | null;
  /** Unexpired licence denials recorded on the tenant. */
  tenantUnsupportedActions: readonly EdrActionKey[];
  /** `edr_connections.capabilities_snapshot` (incl. `note:` entries from the last test). */
  connectionCapabilityNotes: readonly string[];
}

/** Did a sent-but-unconfirmed request take effect? */
export type EdrReconcileVerdict = 'applied' | 'not_applied' | 'unknown';

export interface EdrCredentialField { name: string; label: string; secret: boolean; required: boolean }

/** An inbound vendor push as the webhook route saw it: raw body text, header values. */
export interface RawWebhookRequest { headers: Record<string, string | undefined>; body: string }
/** A push is a HINT: which tenant (and optionally which detection) has news. Opaque vendor ids only. */
export interface EdrWebhookHint { vendorTenantId?: string; vendorDetectionId?: string }
export type EdrWebhookVerdict = { ok: true; hints: EdrWebhookHint[] } | { ok: false; error: string };

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
  /**
   * W03. Sends ONE action to the vendor. Must not retry a write that may have
   * reached the vendor: an ambiguous outcome throws `code: 'outcome_unknown'`.
   * `traceId` is the `edr_actions` row id, sent as the vendor request id for
   * TRACEABILITY ONLY: GravityZone does not dedupe on it, so it is not an
   * idempotency key and no caller may rely on it to make a re-send safe.
   * Called ONLY by `dispatchEdrAction` (edrActions.chokepoint.contract.test.ts).
   */
  performAction?(
    ctx: EdrAdapterContext,
    tenant: VendorEdrTenantRef,
    req: EdrActionRequest,
    traceId: string,
  ): Promise<Exclude<EdrActionResult, { status: 'failed' }>>;
  /** W03. Pure: can this action be attempted on this target? Rules are adapter-specific. */
  supportsAction?(facts: EdrActionTargetFacts, action: EdrActionKey): EdrActionSupport;
  /** W03. Poll a `submitted` vendor task; `submitted` = still pending. */
  getActionStatus?(
    ctx: EdrAdapterContext,
    tenant: VendorEdrTenantRef,
    vendorActionId: string,
  ): Promise<EdrActionResult | { status: 'submitted' }>;
  /** W03. Crash/ambiguity reconciliation. Read-only vendor calls ONLY — never re-sends. */
  reconcileAction?(ctx: EdrAdapterContext, tenant: VendorEdrTenantRef, req: EdrActionRequest): Promise<EdrReconcileVerdict>;
  /**
   * W03 PR-B. PURE secret check + hint extraction for an inbound vendor push.
   * Returns ONLY opaque vendor ids (never vendor content); a push can only
   * schedule a read sync. Called only by `routes/webhooks/edr.ts`.
   */
  verifyWebhook?(req: RawWebhookRequest, secret: string): EdrWebhookVerdict;
  /**
   * W03 PR-B. Register Breeze's webhook URL + shared secret with the vendor
   * console. A console has ONE push destination: when it already points
   * somewhere else (a SIEM, say) this throws `code: 'push_conflict'` unless
   * `replaceExisting` is set.
   */
  registerPush?(
    ctx: EdrAdapterContext,
    o: { url: string; secret: string; vendorTenantIds: string[]; replaceExisting?: boolean },
  ): Promise<void>;
  /**
   * W03 PR-B. Turn vendor push off, but only while it still points at `url`
   * (Breeze's webhook): never disables a destination someone else configured.
   */
  unregisterPush?(ctx: EdrAdapterContext, o: { url: string | null }): Promise<{ changed: boolean }>;
  /** W03 PR-B. Ask the vendor to send one test event to the registered URL. */
  sendTestPush?(ctx: EdrAdapterContext): Promise<void>;
  // Declared now, implemented later (types only — no framework code calls them):
  getDetections?(...a: unknown[]): Promise<VendorEdrDetection[]>;
  getInstaller?(...a: unknown[]): Promise<unknown>;
}
