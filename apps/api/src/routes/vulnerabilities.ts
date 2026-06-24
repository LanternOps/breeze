import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, ilike, inArray, type SQL } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { deviceVulnerabilities, devices, vulnerabilities } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { remediateVulnerabilities } from '../services/vulnerabilityRemediation';
import { writeRouteAudit } from '../services/auditEvents';
import { platformAdminMiddleware } from '../middleware/platformAdmin';
import { userRateLimit } from '../middleware/userRateLimit';
import { enqueueVulnSourceSync } from '../jobs/vulnerabilityJobs';

export const vulnerabilityRoutes = new Hono();

const requireVulnerabilityRead = requirePermission(
  PERMISSIONS.DEVICES_READ.resource,
  PERMISSIONS.DEVICES_READ.action,
);

const statusSchema = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase())
  .pipe(z.enum(['open', 'patched', 'mitigated', 'accepted', 'all']));

const severitySchema = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase())
  .pipe(z.enum(['low', 'medium', 'high', 'critical']));

const listQuerySchema = z.object({
  status: statusSchema.default('open'),
  severity: severitySchema.optional(),
  cve: z.string().trim().min(1).max(32).optional(),
});

const deviceParamSchema = z.object({
  deviceId: z.string().uuid(),
});

const remediateSchema = z.object({
  deviceVulnerabilityIds: z.array(z.string().uuid()).min(1).max(200),
});

const idParamSchema = z.object({
  id: z.string().uuid(),
});

const acceptRiskSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
  acceptedUntil: z.string().datetime(),
});

const mitigateSchema = z.object({
  note: z.string().trim().min(1).max(2000),
});

const requireVulnerabilityWrite = requirePermission(
  PERMISSIONS.DEVICES_WRITE.resource,
  PERMISSIONS.DEVICES_WRITE.action,
);

type FindingAccess =
  | { ok: true; row: { id: string; orgId: string; deviceId: string; status: string } }
  | { ok: false; status: 404 | 403; error: string };

/**
 * Enforce the intra-org SITE axis for a per-device route: RLS isolates orgs but
 * NOT sites, so a site-restricted caller must be checked here via
 * `auth.canAccessSite`. The device is loaded under the request context + org
 * condition (defense-in-depth) to read its siteId. 404 if invisible/unknown,
 * 403 if outside the caller's site allowlist.
 */
async function assertDeviceSiteAccess(
  deviceId: string,
  auth: AuthContext,
): Promise<{ ok: true } | { ok: false; status: 404 | 403; error: string }> {
  const orgCond = auth.orgCondition(devices.orgId);
  const [device] = await db
    .select({ siteId: devices.siteId })
    .from(devices)
    .where(orgCond ? and(eq(devices.id, deviceId), orgCond) : eq(devices.id, deviceId))
    .limit(1);
  if (!device) return { ok: false, status: 404, error: 'Device not found' };
  if (auth.canAccessSite && !auth.canAccessSite(device.siteId)) {
    return { ok: false, status: 403, error: 'Access to this site denied' };
  }
  return { ok: true };
}

/**
 * Load a device-vulnerability finding for a write (accept-risk / mitigate) and
 * enforce BOTH axes: org via the request RLS context, and the intra-org SITE
 * axis via {@link assertDeviceSiteAccess}. A cross-org id is invisible under RLS
 * (404); a finding on a device outside the caller's site allowlist is denied.
 */
async function loadFindingForWrite(id: string, auth: AuthContext): Promise<FindingAccess> {
  const [row] = await db
    .select({
      id: deviceVulnerabilities.id,
      orgId: deviceVulnerabilities.orgId,
      deviceId: deviceVulnerabilities.deviceId,
      status: deviceVulnerabilities.status,
    })
    .from(deviceVulnerabilities)
    .where(eq(deviceVulnerabilities.id, id))
    .limit(1);
  if (!row) return { ok: false, status: 404, error: 'Vulnerability finding not found' };

  const deviceAccess = await assertDeviceSiteAccess(row.deviceId, auth);
  if (!deviceAccess.ok) {
    // Hide cross-site existence as "not found" when keyed by a finding id.
    return {
      ok: false,
      status: deviceAccess.status,
      error: deviceAccess.status === 404 ? 'Vulnerability finding not found' : deviceAccess.error,
    };
  }
  return { ok: true, row };
}

type DeviceVulnerabilityRow = {
  id: string;
  deviceId: string;
  vulnerabilityId: string;
  softwareInventoryId: string | null;
  status: string;
  riskScore: string | null;
  detectedAt: Date;
};

type CatalogRow = {
  id: string;
  cveId: string;
  cvssScore: string | null;
  cvssVector: string | null;
  severity: string | null;
  knownExploited: boolean | null;
  epssScore: string | null;
  patchAvailable: boolean | null;
};

function numericOrNull(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareScoresDescNullsLast(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

function mergeRows(deviceRows: DeviceVulnerabilityRow[], catalogRows: CatalogRow[]) {
  const catalogById = new Map(catalogRows.map((row) => [row.id, row]));

  return deviceRows
    .map((row) => {
      const catalog = catalogById.get(row.vulnerabilityId);
      if (!catalog) return null;

      return {
        id: row.id,
        deviceId: row.deviceId,
        vulnerabilityId: row.vulnerabilityId,
        softwareInventoryId: row.softwareInventoryId,
        status: row.status,
        riskScore: numericOrNull(row.riskScore),
        detectedAt: row.detectedAt,
        cveId: catalog.cveId,
        cvssScore: numericOrNull(catalog.cvssScore),
        cvssVector: catalog.cvssVector,
        severity: catalog.severity,
        knownExploited: catalog.knownExploited ?? false,
        epssScore: numericOrNull(catalog.epssScore),
        patchAvailable: catalog.patchAvailable ?? false,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => {
      // Per-device sort: riskScore DESC (nulls last), tie-break cveId ASC.
      const byRisk = compareScoresDescNullsLast(a.riskScore, b.riskScore);
      if (byRisk !== 0) return byRisk;
      return a.cveId < b.cveId ? -1 : a.cveId > b.cveId ? 1 : 0;
    });
}

async function readCatalogRows(
  vulnerabilityIds: string[],
  filters: { severity?: string; cve?: string },
): Promise<CatalogRow[]> {
  if (vulnerabilityIds.length === 0) return [];

  const conditions: SQL[] = [inArray(vulnerabilities.id, vulnerabilityIds)];
  if (filters.severity) {
    conditions.push(eq(vulnerabilities.severity, filters.severity));
  }
  if (filters.cve) {
    conditions.push(ilike(vulnerabilities.cveId, filters.cve));
  }

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({
          id: vulnerabilities.id,
          cveId: vulnerabilities.cveId,
          cvssScore: vulnerabilities.cvssScore,
          cvssVector: vulnerabilities.cvssVector,
          severity: vulnerabilities.severity,
          knownExploited: vulnerabilities.knownExploited,
          epssScore: vulnerabilities.epssScore,
          patchAvailable: vulnerabilities.patchAvailable,
        })
        .from(vulnerabilities)
        .where(and(...conditions))
        .orderBy(desc(vulnerabilities.cvssScore))
    )
  );
}

async function listVulnerabilities(filters: {
  status: string;
  deviceId?: string;
  severity?: string;
  cve?: string;
}) {
  const conditions: SQL[] = [];
  // 'all' means no status filter — return every status. Any other value is
  // treated as a specific status to match (open | patched | mitigated | accepted).
  if (filters.status !== 'all') {
    conditions.push(eq(deviceVulnerabilities.status, filters.status));
  }
  if (filters.deviceId) {
    conditions.push(eq(deviceVulnerabilities.deviceId, filters.deviceId));
  }

  const deviceRows = await db
    .select({
      id: deviceVulnerabilities.id,
      deviceId: deviceVulnerabilities.deviceId,
      vulnerabilityId: deviceVulnerabilities.vulnerabilityId,
      softwareInventoryId: deviceVulnerabilities.softwareInventoryId,
      status: deviceVulnerabilities.status,
      riskScore: deviceVulnerabilities.riskScore,
      detectedAt: deviceVulnerabilities.detectedAt,
    })
    .from(deviceVulnerabilities)
    .where(and(...conditions));

  const vulnerabilityIds = [...new Set(deviceRows.map((row) => row.vulnerabilityId))];
  const catalogRows = await readCatalogRows(vulnerabilityIds, {
    severity: filters.severity,
    cve: filters.cve,
  });

  return mergeRows(deviceRows, catalogRows);
}

type MergedItem = ReturnType<typeof mergeRows>[number];

type FleetRow = {
  id: string;
  cveId: string;
  cvssScore: number | null;
  severity: string | null;
  knownExploited: boolean;
  epssScore: number | null;
  riskScore: number | null;
  deviceCount: number;
};

/**
 * Collapse per-device findings into one row per CVE for the fleet view.
 * `id` = vulnerabilityId (stable aggregate key). Risk fields are CVE-constant;
 * we take the max riskScore across devices to be safe. Sort: riskScore DESC,
 * knownExploited (true first), epssScore DESC, cvssScore DESC — all nulls last.
 */
function aggregateFleet(items: MergedItem[]): FleetRow[] {
  const byVuln = new Map<string, FleetRow>();
  for (const item of items) {
    const existing = byVuln.get(item.vulnerabilityId);
    if (existing) {
      existing.deviceCount += 1;
      if ((item.riskScore ?? -1) > (existing.riskScore ?? -1)) {
        existing.riskScore = item.riskScore;
      }
      continue;
    }
    byVuln.set(item.vulnerabilityId, {
      id: item.vulnerabilityId,
      cveId: item.cveId,
      cvssScore: item.cvssScore,
      severity: item.severity,
      knownExploited: item.knownExploited,
      epssScore: item.epssScore,
      riskScore: item.riskScore,
      deviceCount: 1,
    });
  }

  return Array.from(byVuln.values()).sort((a, b) => {
    const byRisk = compareScoresDescNullsLast(a.riskScore, b.riskScore);
    if (byRisk !== 0) return byRisk;
    if (a.knownExploited !== b.knownExploited) return a.knownExploited ? -1 : 1;
    const byEpss = compareScoresDescNullsLast(a.epssScore, b.epssScore);
    if (byEpss !== 0) return byEpss;
    return compareScoresDescNullsLast(a.cvssScore, b.cvssScore);
  });
}

vulnerabilityRoutes.use('*', authMiddleware);
vulnerabilityRoutes.use('*', requireScope('organization', 'partner', 'system'));
vulnerabilityRoutes.use('*', requireVulnerabilityRead);

vulnerabilityRoutes.get('/', zValidator('query', listQuerySchema), async (c) => {
  const query = c.req.valid('query');
  const items = await listVulnerabilities(query);
  return c.json({ items: aggregateFleet(items) });
});

vulnerabilityRoutes.get(
  '/devices/:deviceId',
  zValidator('param', deviceParamSchema),
  zValidator('query', listQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId } = c.req.valid('param');
    const query = c.req.valid('query');
    // Intra-org site gate (RLS isolates orgs, not sites).
    const access = await assertDeviceSiteAccess(deviceId, auth);
    if (!access.ok) {
      return c.json({ error: access.error }, access.status);
    }
    const items = await listVulnerabilities({ ...query, deviceId });
    return c.json({ items });
  },
);

// POST /remediate — schedule per-device install commands for a set of findings.
// The `*` middleware already enforces auth + scope + DEVICES_READ; this high-power
// write additionally requires DEVICES_EXECUTE + MFA (mirrors /devices/:id/patches/install).
vulnerabilityRoutes.post(
  '/remediate',
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', remediateSchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceVulnerabilityIds } = c.req.valid('json');
    // Org-scope callers pass their org; partner/system callers pass '' so the
    // core derives the org per-device (auth.orgId is null off org scope).
    const result = await remediateVulnerabilities(
      auth.orgId ?? '',
      deviceVulnerabilityIds,
      auth.user.id,
      auth,
    );
    // runAction treats {success:false} as a failure; report success when at least
    // one finding was scheduled (or nothing was asked).
    return c.json({
      success: result.scheduled > 0 || deviceVulnerabilityIds.length === 0,
      ...result,
    });
  },
);

// POST /:id/accept-risk — accept a finding's risk with a reason + expiry. Org-scoped
// state write gated on vulnerabilities:accept_risk (formal waiver; higher trust than
// a compensating-control mitigate write, which stays on devices:write).
vulnerabilityRoutes.post(
  '/:id/accept-risk',
  requirePermission(PERMISSIONS.VULN_RISK_ACCEPT.resource, PERMISSIONS.VULN_RISK_ACCEPT.action),
  zValidator('param', idParamSchema),
  zValidator('json', acceptRiskSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const { reason, acceptedUntil } = c.req.valid('json');

    if (new Date(acceptedUntil).getTime() <= Date.now()) {
      return c.json({ success: false, error: 'acceptedUntil must be in the future' }, 400);
    }

    const access = await loadFindingForWrite(id, auth);
    if (!access.ok) {
      return c.json({ success: false, error: access.error }, access.status);
    }
    const { row } = access;

    await db
      .update(deviceVulnerabilities)
      .set({
        status: 'accepted',
        acceptedBy: auth.user.id,
        acceptedUntil: new Date(acceptedUntil),
        mitigationNote: reason,
      })
      .where(eq(deviceVulnerabilities.id, id));

    writeRouteAudit(c, {
      orgId: row.orgId,
      action: 'vulnerability.accept_risk',
      resourceType: 'device_vulnerability',
      resourceId: id,
      details: { acceptedUntil, reason },
    });

    return c.json({ success: true });
  },
);

// POST /:id/mitigate — mark a finding mitigated with a note. Org-scoped state
// write on devices:write (NOT the accept_risk gate): mitigate asserts a
// compensating control is in place (technician work) and is reversible via the
// now-governance-gated reopen. Accepting risk is the formal waiver.
vulnerabilityRoutes.post(
  '/:id/mitigate',
  requireVulnerabilityWrite,
  zValidator('param', idParamSchema),
  zValidator('json', mitigateSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const { note } = c.req.valid('json');

    const access = await loadFindingForWrite(id, auth);
    if (!access.ok) {
      return c.json({ success: false, error: access.error }, access.status);
    }
    const { row } = access;

    await db
      .update(deviceVulnerabilities)
      .set({ status: 'mitigated', mitigationNote: note, resolvedAt: new Date() })
      .where(eq(deviceVulnerabilities.id, id));

    writeRouteAudit(c, {
      orgId: row.orgId,
      action: 'vulnerability.mitigate',
      resourceType: 'device_vulnerability',
      resourceId: id,
      details: { note },
    });

    return c.json({ success: true });
  },
);

// POST /:id/reopen — revert an accepted/mitigated finding back to open. Gated on
// vulnerabilities:accept_risk (symmetric with accept-risk: both are governance
// operations on the waiver lifecycle). Clears all resolution fields so the finding
// is treated as newly-open again.
vulnerabilityRoutes.post(
  '/:id/reopen',
  requirePermission(PERMISSIONS.VULN_RISK_ACCEPT.resource, PERMISSIONS.VULN_RISK_ACCEPT.action),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const access = await loadFindingForWrite(id, auth);
    if (!access.ok) {
      return c.json({ success: false, error: access.error }, access.status);
    }
    const { row } = access;

    await db
      .update(deviceVulnerabilities)
      .set({
        status: 'open',
        acceptedBy: null,
        acceptedUntil: null,
        mitigationNote: null,
        resolvedAt: null,
      })
      .where(eq(deviceVulnerabilities.id, id));

    writeRouteAudit(c, {
      orgId: row.orgId,
      action: 'vulnerability.reopen',
      resourceType: 'device_vulnerability',
      resourceId: id,
      details: { previousStatus: row.status },
    });

    return c.json({ success: true });
  },
);

// Admin manual sync trigger. A SEPARATE router so the org-scoped `*` middleware
// above (auth + scope + DEVICES_READ) does NOT gate it — it is platform-admin
// only. Mounted at `/api/v1/vulnerabilities/sync` (deeper than the main router's
// `/vulnerabilities` mount, which isolates the two routers' `.use('*')` chains).
export const vulnerabilitySyncRoutes = new Hono();

const syncSchema = z.object({
  source: z.enum(['msrc', 'nvd', 'sofa', 'kev_epss']),
});

vulnerabilitySyncRoutes.use('*', platformAdminMiddleware);
vulnerabilitySyncRoutes.use('*', requireMfa());

vulnerabilitySyncRoutes.post(
  '/',
  userRateLimit('vuln-manual-sync', 10, 3600), // 10/hour/user
  zValidator('json', syncSchema),
  async (c) => {
    const { source } = c.req.valid('json');
    const jobId = await enqueueVulnSourceSync(source);
    // resourceId is a uuid column — the source string lives in details, not there.
    writeRouteAudit(c, {
      orgId: null,
      action: 'vulnerability.manual_sync',
      resourceType: 'vulnerability_source',
      details: { source, jobId },
    });
    return c.json({ enqueued: true, jobId });
  },
);
