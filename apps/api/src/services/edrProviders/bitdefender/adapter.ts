import { z } from 'zod';
import {
  EdrProviderRequestError,
  type EdrAdapterContext,
  type EdrDetectionPage,
  type EdrProviderAdapter,
  type EdrTestResult,
  type VendorEdrDetection,
  type VendorEdrEndpointDetail,
  type VendorEdrTenant,
} from '../types';
import { GravityZoneClient, GZ_HOST_ALLOWLIST, type GzIncident, type GzQuarantineItem } from './client';
import { toEndpointDetail, toIncidentDetection, toQuarantineDetection, toVendorEndpoint } from './normalize';

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

// ---- adapter ----------------------------------------------------------------

export const bitdefenderAdapter: EdrProviderAdapter = {
  key: 'bitdefender',
  label: 'Bitdefender GravityZone',
  credentialsSchema,
  credentialFields: [{ name: 'apiKey', label: 'API key', secret: true, required: true }],
  baseUrlPolicy: { required: true, pathPrefix: '/api' },
  hostAllowlist: GZ_HOST_ALLOWLIST,
  capabilities: {
    tenantModel: 'partner',
    perTenantHost: false,
    detectionDelivery: 'poll', // push arrives in W03
    detectionStatusModel: 'delta_with_updates',
    actions: [], // W03
    endpointIdentifiers: ['hostname', 'fqdn', 'mac', 'ip'],
    installer: 'none', // W06
    requestBudget: { perSecond: 10 },
    // incidents: the vendor allows 3 requests / 60 s per key; 2/min leaves headroom.
    operationBudgets: { inventory: { perSecond: 5 }, companies: { perSecond: 5 }, incidents: { perMinute: 2 } },
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
    const tenants = new Map<string, VendorEdrTenant>();
    const seenPartners = new Set<string>([root.id]);
    let level: string[] = [root.id];
    for (let depth = 0; level.length > 0; depth++) {
      const next: string[] = [];
      for (const parentId of level) {
        for (const c of await client.getCompaniesList(parentId, 1)) {
          if (tenants.has(c.id)) continue;
          tenants.set(c.id, {
            vendorTenantId: c.id, name: c.name, parentId, tenantType: 'company', externalCode: null, apiHost: null,
          });
          if (tenants.size >= MAX_COMPANIES) {
            throw new EdrProviderRequestError(`GravityZone tree has at least ${MAX_COMPANIES} companies; refusing to truncate`, {
              code: 'too_many_companies', reauth: false, scope: 'connection',
            });
          }
        }
        for (const sp of await client.getCompaniesList(parentId, 0)) {
          if (seenPartners.has(sp.id)) continue;
          seenPartners.add(sp.id);
          next.push(sp.id);
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
    // Unmanaged network items carry no Bitdefender agent.
    return items.filter((i) => i.details?.isManaged === true).map((i) => toVendorEndpoint(i, tenant.vendorTenantId));
  },

  async countEndpoints(ctx, tenant) {
    return clientFor(ctx).getInventoryTotal(tenant.vendorTenantId);
  },

  async enrichEndpoints(ctx, _tenant, ids): Promise<VendorEdrEndpointDetail[]> {
    const client = clientFor(ctx);
    const out: VendorEdrEndpointDetail[] = [];
    for (const id of ids) {
      try {
        out.push(toEndpointDetail(id, await client.getEndpointDetails(id)));
      } catch (e) {
        // tenant/operation scope (e.g. -32602 for a vanished endpoint): skip, it stays stale and is retried.
        if (isReq(e) && (e.scope === 'tenant' || e.scope === 'operation')) continue;
        throw e;
      }
    }
    return out;
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
        ctx, `gz:incidents:${incFrom.toISOString()}:${toIso}`, () => client.getIncidentsChangedBetween(incFrom, to),
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
