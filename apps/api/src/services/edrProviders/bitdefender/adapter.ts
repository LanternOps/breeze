import { z } from 'zod';
import type { EdrActionKey } from '@breeze/shared';
import {
  EdrProviderRequestError,
  type EdrActionRequest,
  type EdrActionResult,
  type EdrActionSupport,
  type EdrActionTargetFacts,
  type EdrAdapterContext,
  type EdrDetectionPage,
  type EdrInstallerBuildError,
  type EdrInstallerFetchResult,
  type EdrInstallerPlatform,
  type EdrInstallerSpec,
  type EdrProviderAdapter,
  type EdrReconcileVerdict,
  type EdrTestResult,
  type VendorEdrDetection,
  type VendorEdrEndpointDetail,
  type VendorEdrTenant,
} from '../types';
import { validateVendorUrl } from '../guardedFetch';
import {
  GravityZoneClient,
  GZ_HOST_ALLOWLIST,
  GZ_INSTALLER_HOST_ALLOWLIST,
  type GzIncident,
  type GzQuarantineItem,
} from './client';
import { toEndpointDetail, toIncidentDetection, toQuarantineDetection, toVendorEndpoint } from './normalize';
import { verifyGravityZoneWebhook } from './push';

const credentialsSchema = z.object({ apiKey: z.string().trim().min(16).max(512) }).strict();

const OVERLAP_MS = 5 * 60_000;
const MAX_SUBPARTNER_DEPTH = 5;
const MAX_COMPANIES = 5_000;
const DAY_MS = 86_400_000;

function clientFor(ctx: EdrAdapterContext): GravityZoneClient {
  if (!ctx.baseUrl) throw new EdrProviderRequestError('GravityZone Access URL is not configured', { code: 'config', reauth: false, scope: 'connection' });
  const creds = credentialsSchema.parse(ctx.creds);
  return new GravityZoneClient({ accessUrl: ctx.baseUrl, creds, fetch: ctx.fetch, limiter: ctx.limiter });
}

const isReq = (e: unknown): e is EdrProviderRequestError => e instanceof EdrProviderRequestError;
const isDegradation = (e: unknown): e is EdrProviderRequestError =>
  isReq(e) && (e.code === 'api_not_enabled' || e.code === 'licence');

/** The `capabilities_snapshot` entry for `testConnection`'s capability note (`note:` prefix added by capabilitySnapshot). */
const INCIDENTS_API_OFF_NOTE = 'note:incidents: API not enabled on key';

function unsupportedAction(req: EdrActionRequest): EdrProviderRequestError {
  return new EdrProviderRequestError(`GravityZone does not support ${req.action} on a ${req.target.kind} target`, {
    code: 'unsupported_action', reauth: false, scope: 'operation',
  });
}

// ---- cursor ---------------------------------------------------------------

interface GzCursor { v: 1; incidentsChangedAfter?: string; quarantineAfter?: string }

function parseCursor(raw: string | null): GzCursor {
  if (!raw) return { v: 1 };
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (!p || typeof p !== 'object' || p.v !== 1) return { v: 1 };
    const valid = (x: unknown) => (typeof x === 'string' && !Number.isNaN(Date.parse(x)) ? x : undefined);
    return { v: 1, incidentsChangedAfter: valid(p.incidentsChangedAfter), quarantineAfter: valid(p.quarantineAfter) };
  } catch {
    return { v: 1 };
  }
}

/** Window start: cursor minus the overlap, but never earlier than the first-sync lookback. */
function windowFrom(cursorValue: string | undefined, now: Date, lookbackDays: number): Date {
  const floor = now.getTime() - lookbackDays * DAY_MS;
  if (!cursorValue) return new Date(floor);
  return new Date(Math.max(Date.parse(cursorValue) - OVERLAP_MS, floor));
}

function memo<T>(ctx: EdrAdapterContext, key: string, load: () => Promise<T>): Promise<T> {
  let p = ctx.runCache.get(key) as Promise<T> | undefined;
  if (!p) {
    p = load();
    ctx.runCache.set(key, p);
  }
  return p;
}

// ---- installer --------------------------------------------------------------

/** Sealed on the tenant row by the sync job and read back at dispatch. */
const installerDataSchema = z.object({
  v: z.literal(1),
  packageName: z.string().max(255).nullable(),
  windowsUrl: z.string().min(1).max(2048),
}).strict();

/** [U] until the owner lab (W06.3). */
const GZ_SILENT_INSTALL_ARGS = '/bdparams /silent';
/** The longest name NTFS accepts for one path component. */
const MAX_INSTALLER_FILE_NAME = 255;

/**
 * The downloader reads its configuration from its own file name [U], so the
 * agent must save it under exactly that name. The name comes from a URL, so it
 * must stay one path component whatever the percent-encoding decodes to.
 */
function installerFileName(url: string): string | null {
  let name: string;
  try {
    name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
  } catch {
    return null;
  }
  if (!name.toLowerCase().endsWith('.exe') || name.length > MAX_INSTALLER_FILE_NAME) return null;
  // eslint-disable-next-line no-control-regex
  return /[/\\\x00-\x1f]/.test(name) ? null : name;
}

function buildGravityZoneInstaller(data: unknown, platform: EdrInstallerPlatform): EdrInstallerSpec | EdrInstallerBuildError {
  // Windows only: macOS needs MDM-granted permissions and the Linux link is a shell installer.
  if (platform !== 'windows') return { error: 'platform_unsupported' };
  const parsed = installerDataSchema.safeParse(data);
  if (!parsed.success) return { error: 'material_invalid' };
  const downloadUrl = parsed.data.windowsUrl;
  // A `{{` would be read as a deploy-time template variable by the dispatch fan-out.
  if (downloadUrl.includes('{{')) return { error: 'material_invalid' };
  const fileName = installerFileName(downloadUrl);
  if (!fileName) return { error: 'material_invalid' };
  return { downloadUrl, fileName, fileType: 'exe', silentInstallArgs: GZ_SILENT_INSTALL_ARGS, checksum: null };
}

// ---- adapter ----------------------------------------------------------------

export const bitdefenderAdapter: EdrProviderAdapter = {
  key: 'bitdefender',
  label: 'Bitdefender GravityZone',
  credentialsSchema,
  credentialFields: [{ name: 'apiKey', label: 'API key', secret: true, required: true }],
  baseUrlPolicy: { required: true, pathPrefix: '/api' },
  hostAllowlist: GZ_HOST_ALLOWLIST,
  installerHostAllowlist: GZ_INSTALLER_HOST_ALLOWLIST,
  capabilities: {
    tenantModel: 'partner',
    perTenantHost: false,
    // Push events are hints that schedule the normal poll (W03 PR-B); polling stays authoritative.
    detectionDelivery: 'poll_and_push',
    detectionStatusModel: 'delta_with_updates',
    actions: ['isolate', 'unisolate', 'scan'],
    endpointIdentifiers: ['hostname', 'fqdn', 'mac', 'ip'],
    installer: 'api_generated_link',
    requestBudget: { perSecond: 10 },
    // incidents: the vendor allows 3 requests / 60 s per key; 2/min leaves headroom.
    operationBudgets: { inventory: { perSecond: 5 }, companies: { perSecond: 5 }, incidents: { perMinute: 2 },
      // Vendor scan/quarantine task cap: 30 / min.
      actions: { perMinute: 30 },
      // Vendor push-settings API: 5 requests / min.
      push: { perMinute: 5 },
      // Our own ceiling, not a published vendor limit: installer links refresh daily at most.
      packages: { perMinute: 10 },
    },
    defaultIntervals: { detectionsMinutes: 10, inventoryMinutes: 60 },
    maxActionTargets: 1000,
    firstSyncLookbackDays: 30,
    tenantFetchConcurrency: 2,
  },

  async testConnection(ctx): Promise<EdrTestResult> {
    const client = clientFor(ctx);
    const notes: string[] = [];
    const keyFail = 'The API key must have the Network and Companies APIs enabled';
    try {
      let enabled: Set<string> | null = null;
      try {
        const details = await client.getApiKeyDetails();
        enabled = new Set((details.enabledApis ?? []).map((a) => String(a).toLowerCase()));
      } catch (e) {
        // `general` itself denied: fall back to probing below. A dead key is still a hard failure.
        if (!isReq(e) || e.reauth || !isDegradation(e)) throw e;
      }

      if (enabled) {
        if (!enabled.has('network') || !enabled.has('companies')) return { ok: false, error: keyFail, reauth: true };
        if (!enabled.has('incidents')) notes.push('incidents: API not enabled on key');
        if (!enabled.has('quarantine')) notes.push('quarantine: API not enabled on key');
        if (!enabled.has('packages')) notes.push('packages: API not enabled on key');
      }

      let root: { id: string; name: string; type: number };
      try {
        root = await client.getOwnCompany();
      } catch (e) {
        if (isDegradation(e)) return { ok: false, error: keyFail, reauth: true };
        throw e;
      }

      if (!enabled) {
        const day = new Date(Date.now() - DAY_MS);
        const probes: Array<[string, () => Promise<unknown>]> = [
          ['incidents', () => client.call('incidents', '1.2', 'getIncidentsList', {
            page: 1, perPage: 10, filters: { changeStartDate: day.toISOString(), changeEndDate: new Date().toISOString() },
          }, { operationClass: 'incidents' })],
          ['quarantine', () => client.call('quarantine/computers', '1.1', 'getQuarantineItemsList', {
            page: 1, perPage: 1, filters: { startDate: day.toISOString(), endDate: new Date().toISOString() },
          })],
        ];
        for (const [name, run] of probes) {
          try {
            await run();
          } catch (e) {
            if (!isReq(e) || e.reauth) throw e;
            if (e.code === 'api_not_enabled') notes.push(`${name}: API not enabled on key`);
            else if (e.code === 'licence') notes.push(`${name}: licence not available`);
            // Other probe failures are not connection failures.
          }
        }
      }

      const rootType = root.type === 0 ? 'partner' : 'company';
      const tenantCount = rootType === 'partner'
        ? (await bitdefenderAdapter.listTenants(ctx, { id: root.id, type: rootType })).length
        : 1;
      return { ok: true, rootId: root.id, rootName: root.name, rootType, tenantCount, capabilityNotes: notes };
    } catch (e) {
      if (isReq(e)) return { ok: false, error: e.message, reauth: e.reauth };
      throw e;
    }
  },

  async listTenants(ctx, root): Promise<VendorEdrTenant[]> {
    const client = clientFor(ctx);
    if (root.type !== 'partner') {
      const own = await client.getOwnCompany();
      return [{
        vendorTenantId: root.id, name: own.name, parentId: null, tenantType: 'company', externalCode: null, apiHost: null,
      }];
    }
    // Partner companies (the root and every sub-partner) are tenants too: endpoints can be
    // enrolled directly in a partner company (the MSP's own machines — the lab endpoint on
    // 2026-10-08 was). listEndpoints keeps only items whose companyId is the tenant itself,
    // so a partner tenant never picks up its customers' endpoints.
    const tenants = new Map<string, VendorEdrTenant>();
    const add = (t: VendorEdrTenant) => {
      if (tenants.has(t.vendorTenantId)) return false;
      tenants.set(t.vendorTenantId, t);
      if (tenants.size >= MAX_COMPANIES) {
        throw new EdrProviderRequestError(`GravityZone tree has at least ${MAX_COMPANIES} companies; refusing to truncate`, {
          code: 'too_many_companies', reauth: false, scope: 'connection',
        });
      }
      return true;
    };
    const own = await client.getOwnCompany();
    add({ vendorTenantId: root.id, name: own.name, parentId: null, tenantType: 'partner', externalCode: null, apiHost: null });
    let level: string[] = [root.id];
    for (let depth = 0; level.length > 0; depth++) {
      const next: string[] = [];
      for (const parentId of level) {
        for (const c of await client.getCompaniesList(parentId, 1)) {
          add({ vendorTenantId: c.id, name: c.name, parentId, tenantType: 'company', externalCode: null, apiHost: null });
        }
        for (const sp of await client.getCompaniesList(parentId, 0)) {
          if (add({ vendorTenantId: sp.id, name: sp.name, parentId, tenantType: 'partner', externalCode: null, apiHost: null })) {
            next.push(sp.id);
          }
        }
      }
      if (next.length > 0 && depth + 1 > MAX_SUBPARTNER_DEPTH) {
        throw new EdrProviderRequestError(`GravityZone sub-partner nesting exceeds ${MAX_SUBPARTNER_DEPTH} levels; refusing to truncate`, {
          code: 'too_deep', reauth: false, scope: 'connection',
        });
      }
      level = next;
    }
    return [...tenants.values()];
  },

  async listEndpoints(ctx, tenant) {
    const items = await clientFor(ctx).getInventoryAll(tenant.vendorTenantId);
    // The inventory call is recursive, so for a PARTNER company it also returns every descendant
    // company's endpoints. Keep only the tenant's own items. A MANAGED item with no companyId
    // cannot be attributed, and dropping it would let persist delete its stored row as "gone",
    // so it fails the tenant instead. Unmanaged network items carry no Bitdefender agent.
    if (items.some((i) => i.details?.isManaged === true && !i.companyId)) {
      throw new EdrProviderRequestError('GravityZone returned a managed endpoint without a companyId; refusing a partial list', {
        code: 'malformed_response', reauth: false, scope: 'tenant',
      });
    }
    return items
      .filter((i) => i.companyId === tenant.vendorTenantId && i.details?.isManaged === true)
      .map((i) => toVendorEndpoint(i, tenant.vendorTenantId));
  },

  // The count shown for an unmapped tenant (D5) is what mapping it would store. The page-1
  // `total` is not: it counts unmanaged items and, for a partner company, its descendants'.
  async countEndpoints(ctx, tenant) {
    return (await bitdefenderAdapter.listEndpoints(ctx, tenant)).length;
  },

  async enrichEndpoints(ctx, _tenant, ids): Promise<VendorEdrEndpointDetail[]> {
    const client = clientFor(ctx);
    const out: VendorEdrEndpointDetail[] = [];
    for (const id of ids) {
      try {
        out.push(toEndpointDetail(id, await client.getEndpointDetails(id)));
      } catch (e) {
        if (!isReq(e) || e.scope === 'connection') throw e;
        // A vanished endpoint: skip it, it stays stale and is retried.
        if (e.code === 'invalid_params' || e.code === 'not_found') continue;
        // Anything else is systemic for this tenant: stop, keep what we have. Code only, never the body.
        console.warn(`[edr:bitdefender] endpoint enrichment stopped early (${e.code})`);
        return out;
      }
    }
    return out;
  },

  async fetchInstallerMaterial(ctx, tenant): Promise<EdrInstallerFetchResult> {
    let links;
    try {
      links = await clientFor(ctx).listInstallationLinks(tenant.vendorTenantId);
    } catch (e) {
      if (!isReq(e)) throw e;
      if (e.code === 'api_not_enabled') return { ok: false, code: 'packages_api_disabled' };
      if (e.code === 'malformed_response') return { ok: false, code: 'malformed_response' };
      throw e;
    }
    if (links.length === 0) return { ok: false, code: 'no_package' };
    // Decision 6: which package to install is the MSP's call, made in the console. Never guess.
    if (links.length > 1) return { ok: false, code: 'multiple_packages' };
    const link = links[0];
    if (!link || typeof link !== 'object' || Array.isArray(link)) return { ok: false, code: 'malformed_response' };
    // Installing another company's link would enrol the device under the wrong customer, so the
    // entry must name this company. [U] the lab (W06.3) confirms the vendor always returns it.
    if (link.companyId !== tenant.vendorTenantId) return { ok: false, code: 'malformed_response' };
    if (typeof link.installLinkWindows !== 'string' || !link.installLinkWindows) {
      return { ok: false, code: 'malformed_response' };
    }
    if (!validateVendorUrl(link.installLinkWindows, GZ_INSTALLER_HOST_ALLOWLIST).ok) {
      return { ok: false, code: 'url_rejected' };
    }
    const data = {
      v: 1 as const,
      packageName: typeof link.packageName === 'string' ? link.packageName : null,
      windowsUrl: link.installLinkWindows,
    };
    // Report a link dispatch could not use now, on the tenant row, rather than at install time.
    if ('error' in buildGravityZoneInstaller(data, 'windows')) return { ok: false, code: 'malformed_response' };
    return { ok: true, data, expiresAt: null };
  },

  buildInstaller(data, platform) {
    return buildGravityZoneInstaller(data, platform);
  },

  supportsAction(facts: EdrActionTargetFacts, action: EdrActionKey): EdrActionSupport {
    // Rules are evaluated in order; the first failing rule supplies the reason.
    if (!bitdefenderAdapter.capabilities.actions.includes(action)) {
      return { ok: false, reason: 'Not supported by Bitdefender GravityZone' };
    }
    if (facts.vendorEndpointId === null) return { ok: false, reason: 'Endpoint not linked to this vendor' };
    const isolation = action === 'isolate' || action === 'unisolate';
    if (isolation && facts.connectionCapabilityNotes.includes(INCIDENTS_API_OFF_NOTE)) {
      return { ok: false, reason: 'The API key lacks the Incidents API (needed for isolation)' };
    }
    if (facts.tenantUnsupportedActions.includes(action)) {
      return { ok: false, reason: "This company's GravityZone licence does not include this action" };
    }
    if (action === 'isolate' && facts.isolationState === 'isolated') return { ok: false, reason: 'Already isolated' };
    if (action === 'unisolate' && facts.isolationState === 'not_isolated') return { ok: false, reason: 'Not isolated' };
    return { ok: true };
  },

  async performAction(ctx, _tenant, req, traceId): Promise<Exclude<EdrActionResult, { status: 'failed' }>> {
    if (req.target.kind !== 'endpoint' || (req.action !== 'isolate' && req.action !== 'unisolate' && req.action !== 'scan')) {
      throw unsupportedAction(req);
    }
    const client = clientFor(ctx);
    const id = req.target.vendorEndpointId;
    const r = req.action === 'isolate' ? await client.createIsolateEndpointTask(id, traceId)
      : req.action === 'unisolate' ? await client.createRestoreEndpointFromIsolationTask(id, traceId)
        : await client.createScanTask(id, traceId);
    // Only a scan has a pollable task (getScanTasksList). For isolate/restore any
    // accepted answer — boolean or task id ([U]) — means "the vendor took it";
    // completion is observed via inventory isIsolated and reconcileAction.
    if (req.action !== 'scan' || r.kind === 'accepted') return { status: 'succeeded' };
    return { status: 'submitted', vendorActionId: r.taskId };
  },

  async getActionStatus(ctx, _tenant, vendorActionId) {
    switch (await clientFor(ctx).getScanTaskStatus(vendorActionId)) {
      case 'finished': return { status: 'succeeded' };
      case 'failed': return { status: 'failed', code: 'vendor_task_failed', message: 'Scan task failed' };
      default: return { status: 'submitted' };
    }
  },

  async reconcileAction(ctx, _tenant, req): Promise<EdrReconcileVerdict> {
    // Read-only: never a write method. A scan's effect is not observable.
    if (req.target.kind !== 'endpoint' || (req.action !== 'isolate' && req.action !== 'unisolate')) return 'unknown';
    const isolated = (await clientFor(ctx).getEndpointDetails(req.target.vendorEndpointId)).isIsolated;
    if (typeof isolated !== 'boolean') return 'unknown';
    return isolated === (req.action === 'isolate') ? 'applied' : 'not_applied';
  },

  verifyWebhook: verifyGravityZoneWebhook,

  async registerPush(ctx, o): Promise<void> {
    const client = clientFor(ctx);
    // The console has one push destination; setPushEventSettings replaces it.
    // Never silently take over a feed an MSP already sends elsewhere.
    const current = await client.getPushEventSettings();
    if (!o.replaceExisting && current.enabled && current.url && current.url !== o.url) {
      throw new EdrProviderRequestError('GravityZone push events already go to another destination', {
        code: 'push_conflict', reauth: false, scope: 'connection',
      });
    }
    await client.setPushEventSettings({
      enabled: true, url: o.url, authorization: o.secret, companyIds: o.vendorTenantIds,
    });
  },

  async unregisterPush(ctx, o): Promise<{ changed: boolean }> {
    const client = clientFor(ctx);
    const current = await client.getPushEventSettings();
    // Only switch off a destination that is still ours; an unreadable URL is not proof.
    if (!current.enabled || !o.url || current.url !== o.url) return { changed: false };
    await client.setPushEventSettings({ enabled: false });
    return { changed: true };
  },

  async sendTestPush(ctx): Promise<void> {
    await clientFor(ctx).sendTestPushEvent();
  },

  async listDetections(ctx, tenant, cursorRaw, now): Promise<EdrDetectionPage> {
    const client = clientFor(ctx);
    const caps = bitdefenderAdapter.capabilities;
    const cursor = parseCursor(cursorRaw);
    const to = now;
    const toIso = to.toISOString();
    const warnings: string[] = [];
    const detections: VendorEdrDetection[] = [];
    // Cursor values are the run window END so every tenant in a run shares one memoized fetch.
    const next: GzCursor = { v: 1, incidentsChangedAfter: cursor.incidentsChangedAfter, quarantineAfter: cursor.quarantineAfter };

    const incFrom = windowFrom(cursor.incidentsChangedAfter, now, caps.firstSyncLookbackDays);
    try {
      const all = await memo<GzIncident[]>(
        ctx, `gz:incidents:${incFrom.toISOString()}:${toIso}`, async () => {
          const fetched = await client.getIncidentsChangedBetween(incFrom, to);
          const orphaned = fetched.filter((i) => !i.company?.id).length;
          // Once per memoized fetch (not per tenant). Code-only: no incident content.
          if (orphaned > 0) console.warn(`[edr:bitdefender] ${orphaned} incident(s) carried no company id and were not attributed`);
          return fetched;
        },
      );
      for (const i of all) {
        if (i.company?.id === tenant.vendorTenantId) detections.push(toIncidentDetection(i, tenant.vendorTenantId));
      }
      next.incidentsChangedAfter = toIso;
    } catch (e) {
      if (!isDegradation(e)) throw e;
      warnings.push(e.code === 'licence' ? 'incidents: licence not available' : 'incidents: API not enabled on key');
    }

    const qFrom = windowFrom(cursor.quarantineAfter, now, caps.firstSyncLookbackDays);
    try {
      const all = await memo<GzQuarantineItem[]>(
        ctx, `gz:quarantine:${qFrom.toISOString()}:${toIso}`, () => client.getQuarantineBetween(qFrom, to),
      );
      for (const q of all) {
        if (q.companyId === tenant.vendorTenantId) detections.push(toQuarantineDetection(q, tenant.vendorTenantId));
      }
      next.quarantineAfter = toIso;
    } catch (e) {
      if (!isDegradation(e)) throw e;
      warnings.push(e.code === 'licence' ? 'quarantine: licence not available' : 'quarantine: API not enabled on key');
    }

    return { detections, cursor: JSON.stringify(next), warnings };
  },
};
