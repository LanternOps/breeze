/**
 * `get_unifi_status` and `trigger_unifi_sync` (full-control W09, #6779): the AI
 * twin of the READ routes and `POST /unifi/sync` in routes/unifi/index.ts.
 *
 * Out of scope on purpose (triage row #157 "partial"): connect, connect-self-hosted,
 * test, disconnect, mappings and collectors writes — they take or replace a vendor
 * API key and stay `vendor_console_admin`.
 *
 * Partner-wide state. The whole router is gated on `canManagePartnerWidePolicies`
 * (full partner scope) and BOTH reads and writes need `billing:manage`
 * (TOOL_PERMISSIONS mirrors that, not a "reasonable" permission). An agent / helper /
 * MCP-key context has no `partnerOrgAccess` and fails closed, so both tools are
 * `AGENT_HUMAN_ONLY`. The sync route carries `requireMfa()` (QW4).
 *
 * Projection: never a `raw` vendor payload, an encrypted key or a collector device id.
 * `hosts` is the one read that leaves the process (a read-only call to the vendor
 * cloud with the partner's stored key); a vendor error body is summarised, not relayed.
 */
import { desc, eq } from 'drizzle-orm';
import { db, runOutsideDbContext } from '../db';
import { sites, unifiClients, unifiDeviceTelemetry, unifiSiteMappings, unifiSyncRuns } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { canManagePartnerWidePolicies } from './partnerWideAccess';
import { siteAllowlistOf } from './aiToolsSiteScope';
import { createUnifiClient, UnifiApiError } from './unifi/unifiClient';
import { getConnection, getDecryptedApiKey } from './unifi/unifiConnectionService';
import { listCollectors } from './unifi/unifiCollectorService';
import { listControllerSitesForIntegration } from './unifi/unifiControllerSiteService';
import { enqueueUnifiSync } from '../jobs/unifiWorker';
import { UNIFI_STATUS_ACTIONS } from './aiToolSchemasNetworkMonitoring';
import { bounded, clip, jsonError, json, mfaDenied, requireFields, thrown } from './aiToolsNetworkMonitoringShared';

type Action = (typeof UNIFI_STATUS_ACTIONS)[number];

const ROW_CAP = 500;
const PARTNER_GATE = 'Full partner scope is required to manage the shared UniFi integration';

/** The route's `resolvePartnerId`: partner scope uses its own partner; system scope must name one; org scope has none. */
function resolvePartnerId(auth: AuthContext, requested?: string): { partnerId: string } | { error: string } {
  if (auth.scope === 'partner') {
    if (!auth.partnerId) return { error: 'Partner context required' };
    if (requested && requested !== auth.partnerId) return { error: 'Access to this partner denied' };
    return { partnerId: auth.partnerId };
  }
  if (auth.scope === 'organization') return { error: 'UniFi network integrations are managed at partner scope' };
  if (!requested) return { error: 'partnerId is required for system scope' };
  return { partnerId: requested };
}

const partnerInput = {
  partnerId: { type: 'string', description: 'Partner UUID (system callers only; a partner token uses its own)' },
} as const;

export function registerUnifiTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('get_unifi_status', {
    tier: 1,
    domain: 'network',
    searchHint: 'UniFi integration: connection status, consoles, collectors, site mappings, device telemetry, sync history',
    deviceArgs: [],
    definition: {
      name: 'get_unifi_status',
      description:
        'Read the partner UniFi integration. Actions: status,hosts (live consoles and sites),collectors,mappings,telemetry (siteId: devices and clients),sync_runs (last 20),controller_sites. Read-only.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...UNIFI_STATUS_ACTIONS], description: 'The action to perform' },
          ...partnerInput,
          siteId: { type: 'string', description: 'telemetry: Breeze site UUID' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },

    handler: async (input, auth) => {
      const action = input.action as Action;
      if (!UNIFI_STATUS_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      if (!canManagePartnerWidePolicies(auth)) return jsonError(PARTNER_GATE, 'ACCESS_DENIED');
      const partner = resolvePartnerId(auth, typeof input.partnerId === 'string' ? input.partnerId : undefined);
      if ('error' in partner) return jsonError(partner.error, 'ACCESS_DENIED');
      const { partnerId } = partner;
      // hosts (vendor-wide) and controller_sites (no site id) cannot be narrowed to a site allowlist, so a
      // site-restricted session is refused rather than shown the whole integration (review finding).
      if ((action === 'hosts' || action === 'controller_sites') && siteAllowlistOf(auth) !== undefined) {
        return jsonError('This view spans every site of the integration; a site-restricted session cannot read it', 'ACCESS_DENIED');
      }

      try {
        const conn = await getConnection(db, partnerId);

        switch (action) {
          case 'status': {
            if (!conn) return json({ connected: false });
            return json({
              connected: true,
              connectionType: conn.connectionType,
              status: conn.status,
              accountLabel: conn.accountLabel,
              lastSyncAt: conn.lastSyncAt,
              lastSyncStatus: conn.lastSyncStatus,
              lastSyncError: clip(conn.lastSyncError),
            });
          }
          case 'hosts': {
            if (!conn) return jsonError('Not connected', 'NOT_CONNECTED');
            const apiKey = await getDecryptedApiKey(db, partnerId);
            if (!apiKey) return jsonError('No API key found', 'NOT_CONNECTED');
            try {
              const client = createUnifiClient({ baseUrl: conn.baseUrl, apiKey });
              const [hosts, allSites] = await runOutsideDbContext(() => Promise.all([client.listHosts(), client.listSites()]));
              const sitesByHost = new Map<string, Array<{ id: string; name: string }>>();
              for (const s of allSites) {
                const list = sitesByHost.get(s.hostId) ?? [];
                list.push({ id: s.id, name: s.name });
                sitesByHost.set(s.hostId, list);
              }
              // Only mappable consoles, exactly as the route lists them for the mapping UI.
              return bounded({
                hosts: hosts
                  .filter((h) => (h.type ?? 'console') === 'console' && (sitesByHost.get(h.id)?.length ?? 0) > 0)
                  .map((h) => ({ id: h.id, name: h.name, model: h.model, sites: sitesByHost.get(h.id) ?? [] })),
              });
            } catch (error) {
              // Only a vendor API error is an upstream failure; anything else is ours and goes to thrown() (logged in full).
              if (!(error instanceof UnifiApiError)) throw error;
              console.warn('[get_unifi_status] hosts lookup failed', { partnerId, status: error.status });
              // The vendor's error body is not relayed (it can echo request details).
              if (error.status === 401 || error.status === 403) {
                return jsonError('The UniFi API key was rejected; reconnect the integration in Settings', 'UPSTREAM_AUTH');
              }
              return jsonError(`The UniFi cloud request failed (HTTP ${error.status})`, 'UPSTREAM_ERROR');
            }
          }
          case 'collectors': {
            if (!conn) return json({ collectors: [] });
            const collectors = await listCollectors(db, conn.id);
            const gate = auth.canAccessSite;
            return bounded({
              collectors: collectors
                .filter((c) => !gate || gate(c.siteId))
                .map((c) => ({
                  id: c.id, siteId: c.siteId, unifiHostId: c.unifiHostId, controllerUrl: c.controllerUrl,
                  isEnabled: c.isEnabled, pollIntervalSeconds: c.pollIntervalSeconds, status: c.status,
                  firmwareOk: c.firmwareOk, lastPollAt: c.lastPollAt, lastPollStatus: c.lastPollStatus,
                  lastPollError: clip(c.lastPollError),
                })),
            });
          }
          case 'mappings': {
            if (!conn) return json({ mappings: [] });
            const mappings = await db.select({
              id: unifiSiteMappings.id, orgId: unifiSiteMappings.orgId, siteId: unifiSiteMappings.siteId,
              unifiHostId: unifiSiteMappings.unifiHostId, unifiSiteId: unifiSiteMappings.unifiSiteId,
              unifiHostName: unifiSiteMappings.unifiHostName, unifiSiteName: unifiSiteMappings.unifiSiteName,
              wanMetricsAt: unifiSiteMappings.wanMetricsAt, updatedAt: unifiSiteMappings.updatedAt,
            }).from(unifiSiteMappings).where(eq(unifiSiteMappings.integrationId, conn.id));
            const gate = auth.canAccessSite;
            return bounded({ mappings: gate ? mappings.filter((m) => gate(m.siteId)) : mappings });
          }
          case 'telemetry': {
            const missing = requireFields(input, ['siteId'], action);
            if (missing) return missing;
            const siteId = String(input.siteId);
            // The route's explicit cross-tenant guard: resolve the site's org and confirm the caller can reach it.
            const [site] = await db.select({ id: sites.id, orgId: sites.orgId }).from(sites).where(eq(sites.id, siteId)).limit(1);
            if (!site || !auth.canAccessOrg(site.orgId)) return jsonError('Site not found or access denied', 'NOT_FOUND');
            if (auth.canAccessSite && !auth.canAccessSite(siteId)) return jsonError('Site not found or access denied', 'NOT_FOUND');
            const devicesOut = await db.select({
              unifiDeviceId: unifiDeviceTelemetry.unifiDeviceId, mac: unifiDeviceTelemetry.mac, name: unifiDeviceTelemetry.name,
              uptimeSeconds: unifiDeviceTelemetry.uptimeSeconds, cpuPct: unifiDeviceTelemetry.cpuPct, memPct: unifiDeviceTelemetry.memPct,
              txBytes: unifiDeviceTelemetry.txBytes, rxBytes: unifiDeviceTelemetry.rxBytes, numClients: unifiDeviceTelemetry.numClients,
              poePorts: unifiDeviceTelemetry.poePorts, isStale: unifiDeviceTelemetry.isStale, lastSeenAt: unifiDeviceTelemetry.lastSeenAt,
            }).from(unifiDeviceTelemetry).where(eq(unifiDeviceTelemetry.siteId, siteId)).limit(ROW_CAP + 1);
            const clientsOut = await db.select({
              mac: unifiClients.mac, hostname: unifiClients.hostname, ipAddress: unifiClients.ipAddress,
              connectedDeviceId: unifiClients.connectedDeviceId, isWired: unifiClients.isWired, ssid: unifiClients.ssid,
              vlan: unifiClients.vlan, signalDbm: unifiClients.signalDbm, isStale: unifiClients.isStale, lastSeenAt: unifiClients.lastSeenAt,
            }).from(unifiClients).where(eq(unifiClients.siteId, siteId)).limit(ROW_CAP + 1);
            return bounded({
              devices: devicesOut.slice(0, ROW_CAP),
              clients: clientsOut.slice(0, ROW_CAP),
              truncated: devicesOut.length > ROW_CAP || clientsOut.length > ROW_CAP,
            });
          }
          case 'sync_runs': {
            if (!conn) return json({ runs: [] });
            const runs = await db.select().from(unifiSyncRuns)
              .where(eq(unifiSyncRuns.integrationId, conn.id))
              .orderBy(desc(unifiSyncRuns.startedAt))
              .limit(20);
            return bounded({
              runs: runs.map((r) => ({
                id: r.id, trigger: r.trigger, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt,
                hostsSeen: r.hostsSeen, devicesCreated: r.devicesCreated, devicesUpdated: r.devicesUpdated,
                devicesUnchanged: r.devicesUnchanged, devicesRemoved: r.devicesRemoved, error: clip(r.error),
              })),
            });
          }
          case 'controller_sites': {
            if (!conn) return json({ sites: [] });
            return bounded({ sites: await listControllerSitesForIntegration(db, conn.id) });
          }
        }
      } catch (error) {
        return thrown('get_unifi_status', error);
      }
    },
  });

  aiTools.set('trigger_unifi_sync', {
    tier: 2,
    domain: 'network',
    searchHint: 'sync UniFi now: pull the latest consoles, sites and devices from the vendor cloud',
    deviceArgs: [],
    definition: {
      name: 'trigger_unifi_sync',
      description:
        'Queue a manual sync of the partner UniFi integration (pulls consoles, sites and devices from the vendor). Returns once queued; read the outcome with get_unifi_status sync_runs.',
      input_schema: {
        type: 'object' as const,
        properties: { ...partnerInput },
        additionalProperties: false,
      },
    },

    handler: async (input, auth) => {
      if (!canManagePartnerWidePolicies(auth)) return jsonError(PARTNER_GATE, 'ACCESS_DENIED');
      const mfa = mfaDenied(auth);
      if (mfa) return mfa;
      const partner = resolvePartnerId(auth, typeof input.partnerId === 'string' ? input.partnerId : undefined);
      if ('error' in partner) return jsonError(partner.error, 'ACCESS_DENIED');
      try {
        const conn = await getConnection(db, partner.partnerId);
        if (!conn) return jsonError('Not connected', 'NOT_CONNECTED');
        await enqueueUnifiSync(conn.id, partner.partnerId, 'manual');
        return json({ queued: true, note: 'The sync runs in the background; read the outcome with get_unifi_status sync_runs.' });
      } catch (error) {
        return thrown('trigger_unifi_sync', error);
      }
    },
  });
}
