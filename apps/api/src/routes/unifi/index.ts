import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { db } from '../../db';
import { unifiSiteMappings, unifiSyncRuns, sites } from '../../db/schema';
import { createUnifiClient } from '../../services/unifi/unifiClient';
import { getConnection, getDecryptedApiKey, upsertConnection, deleteConnection } from '../../services/unifi/unifiConnectionService';
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
  } catch {
    return c.json({ success: false, message: 'Could not validate the UniFi API key. Check the key and host URL.' }, 400);
  }
  const conn = await upsertConnection(db, partner.partnerId, {
    baseUrl: base,
    apiKey,
    accountLabel: accountLabel ?? null,
    createdBy: auth.user.id,
  });
  return c.json({ connected: true, status: conn.status });
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
  const ok = await deleteConnection(db, partner.partnerId);
  return c.json({ success: ok });
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
  for (const m of mappings) {
    const [site] = await db.select({ id: sites.id, orgId: sites.orgId }).from(sites).where(eq(sites.id, m.siteId)).limit(1);
    if (!site) return c.json({ success: false, message: `Unknown Breeze site: ${m.siteId}` }, 400);
    if (!auth.canAccessOrg(site.orgId)) {
      return c.json({ success: false, message: 'Access to target organization denied' }, 403);
    }
    await db.insert(unifiSiteMappings).values({
      integrationId: conn.id,
      orgId: site.orgId,
      siteId: site.id,
      unifiHostId: m.unifiHostId,
      unifiSiteId: m.unifiSiteId,
      unifiHostName: m.unifiHostName ?? null,
      unifiSiteName: m.unifiSiteName ?? null,
    }).onConflictDoUpdate({
      target: [unifiSiteMappings.integrationId, unifiSiteMappings.unifiHostId, unifiSiteMappings.unifiSiteId],
      set: {
        orgId: site.orgId,
        siteId: site.id,
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
  return c.json({ mappings });
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
