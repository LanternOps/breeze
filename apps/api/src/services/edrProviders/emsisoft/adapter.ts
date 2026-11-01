import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  EdrProviderRequestError,
  type EdrAdapterContext,
  type EdrDetectionPage,
  type EdrDetectionRef,
  type EdrDetectionStatusUpdate,
  type EdrProviderAdapter,
  type EdrTestResult,
  type VendorEdrEndpointDetail,
  type VendorEdrTenant,
} from '../types';
import { EMSISOFT_HOST_ALLOWLIST, EmsisoftClient, type EmsiDevice } from './client';
import { deviceNameKey, toEndpointDetail, toIncidentDetections, toStatusUpdate, toVendorEndpoint } from './normalize';

const credentialsSchema = z.object({ apiKey: z.string().trim().min(16).max(512) }).strict(); // [U] align min with a real key

const DAY_MS = 86_400_000;
const FIRST_SYNC_LOOKBACK_DAYS = 30;

const isReq = (e: unknown): e is EdrProviderRequestError => e instanceof EdrProviderRequestError;

/** One client per sync run (memoized in `ctx.runCache`), so `/account` success is remembered across calls. */
function clientFor(ctx: EdrAdapterContext): Promise<EmsisoftClient> {
  const cached = ctx.runCache.get('emsi:client');
  if (cached) return cached as Promise<EmsisoftClient>;
  const parsed = credentialsSchema.safeParse(ctx.creds);
  if (!parsed.success) {
    // Never echo the submitted value: only that it is malformed.
    return Promise.reject(new EdrProviderRequestError('Emsisoft credentials are invalid', { code: 'config', reauth: false, scope: 'connection' }));
  }
  let logged = false;
  const client = new EmsisoftClient({
    creds: parsed.data,
    fetch: ctx.fetch,
    limiter: ctx.limiter,
    // The vendor documents no rate limits: log what it actually sends, once per run, so the lab can size the budget.
    onRateHeaders: (h) => {
      if (logged) return;
      logged = true;
      console.info('[edr:emsisoft] observed rate-limit headers', Object.keys(h).length > 0 ? h : { none: true });
    },
  });
  const p = Promise.resolve(client);
  ctx.runCache.set('emsi:client', p);
  return p;
}

function memo<T>(ctx: EdrAdapterContext, key: string, load: () => Promise<T>): Promise<T> {
  let p = ctx.runCache.get(key) as Promise<T> | undefined;
  if (!p) {
    p = load();
    ctx.runCache.set(key, p);
  }
  return p;
}

/** name key -> device guid, or null when 2+ devices of THIS workspace share the key. */
function buildDeviceIndex(devices: EmsiDevice[]): Map<string, string | null> {
  const index = new Map<string, string | null>();
  for (const d of devices) {
    const key = deviceNameKey(d.name);
    if (key === null) continue;
    index.set(key, index.has(key) ? null : d.guid);
  }
  return index;
}

const sha256Hex = (v: string): string => createHash('sha256').update(v).digest('hex');

export const emsisoftAdapter: EdrProviderAdapter = {
  key: 'emsisoft',
  label: 'Emsisoft',
  credentialsSchema,
  credentialFields: [{ name: 'apiKey', label: 'API key', secret: true, required: true }],
  baseUrlPolicy: null,
  hostAllowlist: EMSISOFT_HOST_ALLOWLIST,
  capabilities: {
    tenantModel: 'partner', // Open Decision 1 (Gate B: (a)); the A11 lab can switch to a single-workspace model
    perTenantHost: false,
    detectionDelivery: 'poll', // the vendor has no webhooks
    detectionStatusModel: 'reread_open_on_inventory', // Open Decision 2 (Gate B: (c)): no change cursor, no closed state
    actions: [], // PR-B
    endpointIdentifiers: ['hostname', 'fqdn'], // no mac / serial -> strict matching; ip is never an identifier
    installer: 'none', // W06
    requestBudget: { perSecond: 2, perMinute: 60 }, // undocumented vendor limit: conservative, revisit after A11
    defaultIntervals: { detectionsMinutes: 15, inventoryMinutes: 60 },
    maxActionTargets: 1,
    firstSyncLookbackDays: FIRST_SYNC_LOOKBACK_DAYS,
    tenantFetchConcurrency: 1,
    // Columns only the per-device detail call fills; the device list never overwrites them.
    detailOwnedFields: ['fqdn', 'ipAddresses', 'osPlatform', 'osName', 'endpointType', 'online', 'health', 'agentVersion'],
    // inventory: device pages (~2) + up to DETAIL_ENRICH_PER_RUN (50) details + re-read (<= 20)
    // detection: incident pages (~1) + device-name pages for attribution (~2)
    estimatedCalls: { perTenantDetection: 3, perTenantInventory: 72, perConnectionOverhead: 2 },
    rereadOpenPerRun: 20,
  },

  async testConnection(ctx): Promise<EdrTestResult> {
    try {
      const client = await clientFor(ctx);
      const account = await client.getAccount(); // a 401 here (and only here) is a dead key -> reauth
      const partners = account.partners ?? [];

      let rootId: string;
      let rootName: string;
      let rootType: string;
      if (partners.length > 1) {
        // vendorRootMismatch needs ONE stable root, or a later test would look like a different account.
        return {
          ok: false, reauth: false,
          error: 'This API key belongs to a user in several Emsisoft partner accounts; create the key as a user of one partner',
        };
      } else if (partners.length === 1) {
        rootType = 'partner';
        rootId = partners[0]!.guid;
        rootName = partners[0]!.id || 'Emsisoft partner';
      } else {
        const email = account.email?.trim().toLowerCase();
        if (!email) return { ok: false, reauth: false, error: 'Emsisoft did not return an account identity for this key' };
        // The email is hashed and never stored, logged or returned.
        rootType = 'workspace_user';
        rootId = `user:${sha256Hex(email).slice(0, 32)}`;
        rootName = 'Emsisoft workspace user';
      }

      let workspaces;
      try {
        workspaces = await client.listWorkspacesAll();
      } catch (e) {
        if (isReq(e) && e.code === 'forbidden' && !e.reauth) {
          return { ok: false, reauth: false, error: "The key's user cannot list workspaces" };
        }
        throw e;
      }

      const notes: string[] = [];
      if (workspaces.length > 0) {
        try {
          await client.probeWorkspaceDevices(workspaces[0]!.guid);
        } catch (e) {
          if (isReq(e) && e.code === 'forbidden' && !e.reauth) {
            notes.push('workspaces: device access denied for at least one workspace (licence-manager role?)');
          } else if (isReq(e) && e.scope === 'connection') {
            throw e;
          } else if (isReq(e)) {
            // Not a connection failure, but do not report a clean bill of health either.
            notes.push(`workspaces: device probe failed (${e.code})`);
          } else {
            throw e;
          }
        }
      }
      return { ok: true, rootId, rootName, rootType, tenantCount: workspaces.length, capabilityNotes: notes };
    } catch (e) {
      if (isReq(e)) return { ok: false, error: e.message, reauth: e.reauth };
      throw e;
    }
  },

  async listTenants(ctx): Promise<VendorEdrTenant[]> {
    const workspaces = await (await clientFor(ctx)).listWorkspacesAll();
    // No Emsisoft field can carry an external code, so mapping is name-suggestion only. An expired workspace is still a tenant.
    return workspaces.map((w) => ({
      vendorTenantId: w.guid, name: (w.name ?? '').trim() || w.guid, parentId: null, tenantType: 'workspace', externalCode: null, apiHost: null,
    }));
  },

  async listEndpoints(ctx, tenant) {
    const devices = await (await clientFor(ctx)).listDevicesAll(tenant.vendorTenantId);
    return devices.map((d) => toVendorEndpoint(d, tenant.vendorTenantId));
  },

  async countEndpoints(ctx, tenant) {
    return (await (await clientFor(ctx)).listDevicesAll(tenant.vendorTenantId)).length;
  },

  async enrichEndpoints(ctx, _tenant, ids): Promise<VendorEdrEndpointDetail[]> {
    const client = await clientFor(ctx);
    const out: VendorEdrEndpointDetail[] = [];
    const skipped = new Map<string, number>();
    const warnSkipped = () => {
      if (skipped.size > 0) console.warn('[edr:emsisoft] device enrichment skipped devices', Object.fromEntries(skipped));
    };
    for (const id of ids) {
      try {
        out.push(toEndpointDetail(id, await client.getDeviceDetails(id)));
      } catch (e) {
        if (!isReq(e) || e.scope !== 'operation') throw e; // connection / tenant failures fail the run / tenant
        // A vanished or unaddressable device: skip it, it stays stale and is retried. Counted by code so a
        // vendor-wide change (every lookup suddenly 400) is visible instead of silent.
        if (e.code === 'not_found' || e.code === 'invalid_params' || e.code === 'invalid_vendor_id') {
          skipped.set(e.code, (skipped.get(e.code) ?? 0) + 1);
          continue;
        }
        // forbidden / vendor_error: systemic for this tenant. Stop and keep what we have. Code only, never the body.
        warnSkipped();
        console.warn(`[edr:emsisoft] device enrichment stopped early (${e.code})`);
        return out;
      }
    }
    warnSkipped();
    return out;
  },

  async listDetections(ctx, tenant, _cursor, now): Promise<EdrDetectionPage> {
    const client = await clientFor(ctx);
    const ws = tenant.vendorTenantId;
    // Discovery window: the cursor is NOT read. Status changes on older rows arrive through the
    // inventory re-read (`rereadDetectionStatus`); this run only discovers incidents in the last 30 days.
    const from = new Date(now.getTime() - FIRST_SYNC_LOOKBACK_DAYS * DAY_MS);
    // forbidden here THROWS (tenant failure, D10 keep-and-mark-stale): a workspace has one detection
    // source, and an empty success would read as "no threats".
    const incidents = await client.listIncidentsAll(ws, from, now);

    let deviceIndex: Map<string, string | null> = new Map();
    if (incidents.some((i) => (i.involvedDevices ?? []).some((n) => deviceNameKey(n) !== null))) {
      // Same-workspace list, memoized for this run only (runCache is per job run).
      deviceIndex = await memo(ctx, `emsi:devices:${ws}`, async () => buildDeviceIndex(await client.listDevicesAll(ws)));
    }

    return {
      detections: incidents.flatMap((i) => toIncidentDetections(i, ws, deviceIndex)),
      cursor: JSON.stringify({ v: 1, windowEnd: now.toISOString() }),
      warnings: [],
    };
  },

  async rereadDetectionStatus(ctx, tenant, refs): Promise<EdrDetectionStatusUpdate[]> {
    const client = await clientFor(ctx);
    const ws = tenant.vendorTenantId;

    // Siblings (one incident across N devices) share a groupKey; a verdict is per incident, so one read serves the group.
    const groups = new Map<string, EdrDetectionRef[]>();
    for (const r of refs) {
      const key = r.groupKey ?? `row:${r.vendorKind}:${r.vendorDetectionId}`;
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }

    const byRef = new Map<string, Awaited<ReturnType<EmsisoftClient['getIncident']>>>();
    const out: EdrDetectionStatusUpdate[] = [];
    const skipped = new Map<string, number>();
    for (const group of groups.values()) {
      const vendorRef = group.find((r) => r.vendorRef)?.vendorRef ?? null;
      if (vendorRef === null) continue; // nothing to ask the vendor: the framework rotates it
      let detail;
      try {
        if (byRef.has(vendorRef)) detail = byRef.get(vendorRef);
        else {
          detail = await client.getIncident(ws, vendorRef);
          byRef.set(vendorRef, detail);
        }
      } catch (e) {
        // connection / tenant scope fails the run / the tenant; an operation-scope error only drops this group,
        // so one dead or purged incident never blocks a tenant's inventory or the rotation.
        if (!isReq(e) || e.scope !== 'operation') throw e;
        // Counted by code: if EVERY group starts failing (vendor route change) the re-read is dead and must be visible.
        skipped.set(e.code, (skipped.get(e.code) ?? 0) + 1);
        continue;
      }
      if (!detail) continue; // the vendor no longer knows it: never auto-closed
      for (const r of group) out.push(toStatusUpdate(r, detail));
    }
    if (skipped.size > 0) console.warn('[edr:emsisoft] status re-read skipped incident groups', Object.fromEntries(skipped));
    return out;
  },
};
