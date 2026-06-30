import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { db } from '../../db';
import { devices, unifiCollectors, unifiDeviceTelemetry, unifiClients, unifiSiteMappings, unifiSyncRuns, sites } from '../../db/schema';
import { createUnifiClient, UnifiApiError } from '../../services/unifi/unifiClient';
import { getConnection, getDecryptedApiKey, upsertConnection, deleteConnection, createSelfHostedIntegration } from '../../services/unifi/unifiConnectionService';
import { listCollectors, upsertCollector, deleteCollector, upsertSelfHostedController } from '../../services/unifi/unifiCollectorService';
import { enqueueUnifiSync } from '../../jobs/unifiWorker';

export const unifiRoutes = new Hono();

type RouteAuth = Pick<AuthContext, 'scope' | 'partnerId' | 'orgId' | 'canAccessOrg'>;

function requestedPartnerId(c: { req: { query: (key: string) => string | undefined } }): string | undefined {
  return c.req.query('partnerId');
}

function resolvePartnerId(auth: RouteAuth, requested?: string): { partnerId: string } | { error: string; status: 400 | 403 } {
  if (auth.scope === 'partner') {
    if (!auth.partnerId) return { error: 'Partner context required', status: 403 };
    if (requested && requested !== auth.partnerId) return { error: 'Access to this partner denied', status: 403 };
    return { partnerId: auth.partnerId };
  }
  if (auth.scope === 'organization') {
    return { error: 'UniFi network integrations are managed at partner scope', status: 403 };
  }
  if (!requested) return { error: 'partnerId is required for system scope', status: 400 };
  return { partnerId: requested };
}

const readPerm = requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action);
const writePerm = requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action);
const partnerScopes = requireScope('partner', 'system');

const connectSchema = z.object({
  apiKey: z.string().min(1),
  baseUrl: z.string().url().max(300).optional(),
  accountLabel: z.string().max(200).optional(),
});

const mappingsSchema = z.object({
  mappings: z.array(z.object({
    unifiHostId: z.string().min(1),
    unifiSiteId: z.string().min(1),
    unifiHostName: z.string().optional(),
    unifiSiteName: z.string().optional(),
    siteId: z.string().guid(),
  })),
});

const collectorSchema = z.object({
  unifiHostId: z.string().min(1),
  siteId: z.string().guid(),
  collectorDeviceId: z.string().guid(),
  controllerUrl: z.string().url().max(300),
  apiKey: z.string().min(1),
  pollIntervalSeconds: z.number().int().min(15).max(3600).optional(),
});

unifiRoutes.use('*', authMiddleware);

// GET /unifi — connection status
unifiRoutes.get('/', partnerScopes, readPerm, async (c) => {
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const conn = await getConnection(db, partner.partnerId);
  if (!conn) return c.json({ connected: false });
  return c.json({
    connected: true,
    connectionType: conn.connectionType,
    status: conn.status,
    accountLabel: conn.accountLabel,
    lastSyncAt: conn.lastSyncAt,
    lastSyncStatus: conn.lastSyncStatus,
    lastSyncError: conn.lastSyncError,
  });
});

// POST /unifi/connect — validate API key then store
unifiRoutes.post('/connect', partnerScopes, writePerm, requireMfa(), zValidator('json', connectSchema), async (c) => {
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const { apiKey, baseUrl, accountLabel } = c.req.valid('json');
  const base = baseUrl ?? 'https://api.ui.com';
  try {
    await createUnifiClient({ baseUrl: base, apiKey }).listHosts();
  } catch (err) {
    // Only a 401/403 means the key is actually bad (→ 400, user-actionable).
    // A UniFi outage, DNS/network fault, or a bug here is NOT "wrong key":
    // surface 502 and log it so on-call can diagnose instead of blaming the key.
    if (err instanceof UnifiApiError && (err.status === 401 || err.status === 403)) {
      return c.json({ success: false, message: 'Could not validate the UniFi API key. Check the key and host URL.' }, 400);
    }
    console.error('[unifi] connect: non-auth failure validating API key:', err);
    return c.json({ success: false, message: 'Could not reach UniFi to validate the key. Please try again shortly.' }, 502);
  }
  const conn = await upsertConnection(db, partner.partnerId, {
    baseUrl: base,
    apiKey,
    accountLabel: accountLabel ?? null,
    createdBy: auth.user.id,
  });
  return c.json({ connected: true, status: conn.status });
});

const connectSelfHostedSchema = z.object({
  accountLabel: z.string().max(200).optional(),
});

// POST /unifi/connect-self-hosted — create a self-hosted integration (no cloud key)
unifiRoutes.post('/connect-self-hosted', partnerScopes, writePerm, requireMfa(), zValidator('json', connectSelfHostedSchema), async (c) => {
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const { accountLabel } = c.req.valid('json');
  const integration = await createSelfHostedIntegration(db, partner.partnerId, {
    accountLabel: accountLabel ?? null,
    createdBy: auth.user.id,
  });
  return c.json({ connected: true, connectionType: integration.connectionType });
});

// POST /unifi/test — live connection test against stored credentials
unifiRoutes.post('/test', partnerScopes, writePerm, requireMfa(), async (c) => {
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const conn = await getConnection(db, partner.partnerId);
  if (!conn) return c.json({ success: false, message: 'Not connected' }, 400);
  const apiKey = await getDecryptedApiKey(db, partner.partnerId);
  if (!apiKey) return c.json({ success: false, message: 'No API key found' }, 400);
  try {
    const client = createUnifiClient({ baseUrl: conn.baseUrl, apiKey });
    const hosts = await client.listHosts();
    return c.json({ success: true, hostsFound: hosts.length });
  } catch (err) {
    return c.json({ success: false, message: err instanceof Error ? err.message : String(err) }, 502);
  }
});

// POST /unifi/disconnect — remove connection for partner
unifiRoutes.post('/disconnect', partnerScopes, writePerm, requireMfa(), async (c) => {
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  // Idempotent: a 0-row delete means "already disconnected", which is the desired
  // end state — report success so runAction doesn't toast a misleading failure on
  // a double-click or concurrent disconnect.
  await deleteConnection(db, partner.partnerId);
  return c.json({ success: true });
});

// GET /unifi/hosts — live host+site list for the mapping UI
unifiRoutes.get('/hosts', partnerScopes, readPerm, async (c) => {
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const conn = await getConnection(db, partner.partnerId);
  if (!conn) return c.json({ success: false, message: 'Not connected' }, 400);
  const apiKey = await getDecryptedApiKey(db, partner.partnerId);
  if (!apiKey) return c.json({ success: false, message: 'No API key found' }, 400);
  try {
    const client = createUnifiClient({ baseUrl: conn.baseUrl, apiKey });
    const [hosts, allSites] = await Promise.all([client.listHosts(), client.listSites()]);
    const sitesByHost = new Map<string, Array<{ id: string; name: string }>>();
    for (const s of allSites) {
      const list = sitesByHost.get(s.hostId) ?? [];
      list.push({ id: s.id, name: s.name });
      sitesByHost.set(s.hostId, list);
    }
    return c.json({
      hosts: hosts.map((h) => ({ id: h.id, name: h.name, sites: sitesByHost.get(h.id) ?? [] })),
    });
  } catch (err) {
    return c.json({ success: false, message: err instanceof Error ? err.message : String(err) }, 502);
  }
});

// PUT /unifi/mappings — upsert site-to-Breeze-site mappings (derive org_id from site)
unifiRoutes.put('/mappings', partnerScopes, writePerm, requireMfa(), zValidator('json', mappingsSchema), async (c) => {
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const conn = await getConnection(db, partner.partnerId);
  if (!conn) return c.json({ success: false, message: 'Not connected' }, 400);
  const { mappings } = c.req.valid('json');
  // Resolve + authorize EVERY target site before any write. Doing this inline
  // per-iteration would leave earlier mappings persisted when a later cross-org
  // entry hits the 403, so the client sees a failure on a partially-applied batch.
  const resolved: Array<{ m: (typeof mappings)[number]; orgId: string; siteId: string }> = [];
  for (const m of mappings) {
    const [site] = await db.select({ id: sites.id, orgId: sites.orgId }).from(sites).where(eq(sites.id, m.siteId)).limit(1);
    if (!site) return c.json({ success: false, message: `Unknown Breeze site: ${m.siteId}` }, 400);
    if (!auth.canAccessOrg(site.orgId)) {
      return c.json({ success: false, message: 'Access to target organization denied' }, 403);
    }
    resolved.push({ m, orgId: site.orgId, siteId: site.id });
  }
  for (const { m, orgId, siteId } of resolved) {
    await db.insert(unifiSiteMappings).values({
      integrationId: conn.id,
      orgId,
      siteId,
      unifiHostId: m.unifiHostId,
      unifiSiteId: m.unifiSiteId,
      unifiHostName: m.unifiHostName ?? null,
      unifiSiteName: m.unifiSiteName ?? null,
    }).onConflictDoUpdate({
      target: [unifiSiteMappings.integrationId, unifiSiteMappings.unifiHostId, unifiSiteMappings.unifiSiteId],
      set: {
        orgId,
        siteId,
        unifiHostName: m.unifiHostName ?? null,
        unifiSiteName: m.unifiSiteName ?? null,
        updatedAt: new Date(),
      },
    });
  }
  return c.json({ success: true });
});

// GET /unifi/mappings — currently-saved site mappings (DB read, not a live UniFi call)
unifiRoutes.get('/mappings', partnerScopes, readPerm, async (c) => {
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const conn = await getConnection(db, partner.partnerId);
  if (!conn) return c.json({ mappings: [] });
  // Scoped by integration_id; org-axis RLS on unifi_site_mappings additionally
  // limits rows to orgs this partner can access (all rows here qualify by construction).
  const mappings = await db.select({
    id: unifiSiteMappings.id,
    orgId: unifiSiteMappings.orgId,
    siteId: unifiSiteMappings.siteId,
    unifiHostId: unifiSiteMappings.unifiHostId,
    unifiSiteId: unifiSiteMappings.unifiSiteId,
    unifiHostName: unifiSiteMappings.unifiHostName,
    unifiSiteName: unifiSiteMappings.unifiSiteName,
    wanMetricsAt: unifiSiteMappings.wanMetricsAt,
    updatedAt: unifiSiteMappings.updatedAt,
  }).from(unifiSiteMappings).where(eq(unifiSiteMappings.integrationId, conn.id));
  // Site-axis gate: a site-restricted caller only sees mappings for sites in their
  // allowlist; partner-wide callers (canAccessSite undefined) see all.
  const siteGate = auth.canAccessSite;
  const visible = siteGate ? mappings.filter((m) => siteGate(m.siteId)) : mappings;
  return c.json({ mappings: visible });
});

// GET /unifi/collectors — configured collectors + status
unifiRoutes.get('/collectors', partnerScopes, readPerm, async (c) => {
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const conn = await getConnection(db, partner.partnerId);
  if (!conn) return c.json({ collectors: [] });
  const collectors = await listCollectors(db, conn.id);
  return c.json({ collectors });
});

// PUT /unifi/collectors — upsert a console's collector
unifiRoutes.put('/collectors', partnerScopes, writePerm, requireMfa(), zValidator('json', collectorSchema), async (c) => {
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const conn = await getConnection(db, partner.partnerId);
  if (!conn) return c.json({ success: false, message: 'Not connected' }, 400);
  const body = c.req.valid('json');
  const [site] = await db.select({ id: sites.id, orgId: sites.orgId }).from(sites).where(eq(sites.id, body.siteId)).limit(1);
  if (!site) return c.json({ success: false, message: `Unknown Breeze site: ${body.siteId}` }, 400);
  if (!auth.canAccessOrg(site.orgId)) return c.json({ success: false, message: 'Access to target organization denied' }, 403);
  const [dev] = await db.select({ id: devices.id, orgId: devices.orgId }).from(devices).where(eq(devices.id, body.collectorDeviceId)).limit(1);
  if (!dev) return c.json({ success: false, message: 'Unknown collector agent' }, 400);
  if (dev.orgId !== site.orgId) return c.json({ success: false, message: 'Collector agent must belong to the site\'s organization' }, 400);
  const collector = await upsertCollector(db, {
    integrationId: conn.id,
    orgId: site.orgId,
    siteId: site.id,
    unifiHostId: body.unifiHostId,
    collectorDeviceId: body.collectorDeviceId,
    controllerUrl: body.controllerUrl,
    apiKey: body.apiKey,
    pollIntervalSeconds: body.pollIntervalSeconds,
    createdBy: auth.user.id,
  });
  return c.json({ success: true, collectorId: collector.id });
});

const controllerSchema = z.object({
  siteId: z.string().guid(),
  collectorDeviceId: z.string().guid(),
  controllerUrl: z.string().url().max(300),
  apiKey: z.string().min(1),
  pollIntervalSeconds: z.number().int().min(15).max(3600).optional(),
});

// PUT /unifi/controllers — register/update a self-hosted controller (no cloud host)
unifiRoutes.put('/controllers', partnerScopes, writePerm, requireMfa(), zValidator('json', controllerSchema), async (c) => {
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const conn = await getConnection(db, partner.partnerId);
  if (!conn) return c.json({ success: false, message: 'Not connected' }, 400);
  if (conn.connectionType !== 'self_hosted') {
    return c.json({ success: false, message: 'Controllers can only be registered on a self-hosted integration' }, 400);
  }
  const body = c.req.valid('json');
  const [site] = await db.select({ id: sites.id, orgId: sites.orgId }).from(sites).where(eq(sites.id, body.siteId)).limit(1);
  if (!site) return c.json({ success: false, message: `Unknown Breeze site: ${body.siteId}` }, 400);
  if (!auth.canAccessOrg(site.orgId)) return c.json({ success: false, message: 'Access to target organization denied' }, 403);
  const [dev] = await db.select({ id: devices.id, orgId: devices.orgId }).from(devices).where(eq(devices.id, body.collectorDeviceId)).limit(1);
  if (!dev) return c.json({ success: false, message: 'Unknown collector agent' }, 400);
  if (dev.orgId !== site.orgId) return c.json({ success: false, message: 'Collector agent must belong to the site\'s organization' }, 400);
  const collector = await upsertSelfHostedController(db, {
    integrationId: conn.id,
    orgId: site.orgId,
    siteId: site.id,
    collectorDeviceId: body.collectorDeviceId,
    controllerUrl: body.controllerUrl,
    apiKey: body.apiKey,
    pollIntervalSeconds: body.pollIntervalSeconds,
    createdBy: auth.user.id,
  });
  return c.json({ success: true, collectorId: collector.id });
});

// DELETE /unifi/collectors/:hostId — remove a console's collector
unifiRoutes.delete('/collectors/:hostId', partnerScopes, writePerm, requireMfa(), async (c) => {
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const conn = await getConnection(db, partner.partnerId);
  if (!conn) return c.json({ success: false, message: 'Not connected' }, 400);
  const hostId = c.req.param('hostId');
  if (!hostId) return c.json({ success: false, message: 'hostId is required' }, 400);
  // Idempotent (see /disconnect): already-absent is the desired end state.
  await deleteCollector(db, conn.id, hostId);
  return c.json({ success: true });
});

// GET /unifi/telemetry?siteId= — devices (with poe_ports) + clients for a mapped site
unifiRoutes.get('/telemetry', partnerScopes, readPerm, async (c) => {
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const siteId = c.req.query('siteId');
  if (!siteId) return c.json({ error: 'siteId is required' }, 400);
  // Explicit cross-tenant guard (defense-in-depth, not RLS alone): resolve the
  // site's org and confirm the caller can access it — mirrors PUT /mappings and
  // PUT /collectors. Without this, an arbitrary siteId query param relies solely
  // on org-axis RLS to scope the read.
  const [site] = await db.select({ id: sites.id, orgId: sites.orgId }).from(sites).where(eq(sites.id, siteId)).limit(1);
  if (!site) return c.json({ error: 'Unknown site' }, 404);
  if (!auth.canAccessOrg(site.orgId)) return c.json({ error: 'Access to this site denied' }, 403);
  // Site-axis gate: a site-restricted caller (allowedSiteIds set) must not read a
  // site outside their allowlist even within an org they can access. Unrestricted
  // (partner-wide) callers have canAccessSite undefined → no-op.
  if (auth.canAccessSite && !auth.canAccessSite(siteId)) return c.json({ error: 'Access to this site denied' }, 403);
  const devicesOut = await db.select().from(unifiDeviceTelemetry).where(eq(unifiDeviceTelemetry.siteId, siteId));
  const clientsOut = await db.select().from(unifiClients).where(eq(unifiClients.siteId, siteId));
  return c.json({ devices: devicesOut, clients: clientsOut });
});

// POST /unifi/sync — manual sync trigger
unifiRoutes.post('/sync', partnerScopes, writePerm, requireMfa(), async (c) => {
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const conn = await getConnection(db, partner.partnerId);
  if (!conn) return c.json({ success: false, message: 'Not connected' }, 400);
  await enqueueUnifiSync(conn.id, partner.partnerId, 'manual');
  return c.json({ success: true });
});

// GET /unifi/sync-runs — last 20 sync run ledger entries
unifiRoutes.get('/sync-runs', partnerScopes, readPerm, async (c) => {
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const conn = await getConnection(db, partner.partnerId);
  if (!conn) return c.json({ runs: [] });
  const runs = await db.select().from(unifiSyncRuns)
    .where(eq(unifiSyncRuns.integrationId, conn.id))
    .orderBy(desc(unifiSyncRuns.startedAt))
    .limit(20);
  return c.json({ runs });
});
