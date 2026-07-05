import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, ilike, inArray, type SQL } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { deviceVulnerabilities, devices, vulnerabilities } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../services/permissions';
import { remediateVulnerabilities } from '../services/vulnerabilityRemediation';
import { buildGroupDetail, computeStats, filterFindings, groupFindings, toGroupFinding } from '../services/vulnerabilityFleetAggregation';
import { fetchCveCatalogRecord, fetchFleetFindingRows } from '../services/vulnerabilityFleetQueries';
import { writeRouteAudit } from '../services/auditEvents';
import { platformAdminMiddleware } from '../middleware/platformAdmin';
import { userRateLimit } from '../middleware/userRateLimit';
import { enqueueVulnSourceSync, enqueueVulnCorrelation } from '../jobs/vulnerabilityJobs';

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

// Query-string boolean: accepts "true"/"false" (any case), rejects everything else.
const boolQuerySchema = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase())
  .pipe(z.enum(['true', 'false']))
  .transform((value) => value === 'true');

const listQuerySchema = z.object({
  status: statusSchema.default('open'),
  severity: severitySchema.optional(),
  cve: z.string().trim().min(1).max(32).optional(),
  kevOnly: boolQuerySchema.optional(),
  patchAvailable: boolQuerySchema.optional(),
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

const bulkAcceptRiskSchema = z.object({
  deviceVulnerabilityIds: z.array(z.string().uuid()).min(1).max(200),
  reason: z.string().trim().min(1).max(2000),
  acceptedUntil: z.string().datetime(),
});

const bulkMitigateSchema = z.object({
  deviceVulnerabilityIds: z.array(z.string().uuid()).min(1).max(200),
  note: z.string().trim().min(1).max(2000),
});

const softwareQuerySchema = z.object({
  status: statusSchema.default('open'),
  severity: severitySchema.optional(),
  search: z.string().trim().min(1).max(200).optional(),
  kevOnly: boolQuerySchema.optional(),
  patchAvailable: boolQuerySchema.optional(),
});

const SOFTWARE_GROUP_CAP = 500;

const groupKeyParamSchema = z.object({
  // Opaque group key: sw:<name>|<vendor> or os:<platform>. Hono decodes the
  // URL-encoded segment before validation.
  groupKey: z.string().min(4).max(600).regex(/^(sw:|os:)/),
});

const cveIdParamSchema = z.object({
  // Real-world CVE ids are CVE-YYYY-NNNN+, but seeded/e2e ids use letters too.
  cveId: z.string().trim().regex(/^CVE-\d{4}-[A-Za-z0-9-]{1,32}$/i),
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

type BulkFindingRow = { id: string; orgId: string; deviceId: string; status: string };
type BulkAccess = { valid: BulkFindingRow[]; skipped: Array<{ id: string; reason: string }> };

/**
 * Batch analogue of loadFindingForWrite: resolves each id to a finding the
 * caller may write (org via RLS + orgCondition on the device row, site via
 * canAccessSite), collecting per-item skip reasons instead of failing the
 * batch. Duplicate ids are collapsed.
 */
async function loadFindingsForBulkWrite(ids: string[], auth: AuthContext): Promise<BulkAccess> {
  const unique = [...new Set(ids)];
  const rows = await db
    .select({
      id: deviceVulnerabilities.id,
      orgId: deviceVulnerabilities.orgId,
      deviceId: deviceVulnerabilities.deviceId,
      status: deviceVulnerabilities.status,
    })
    .from(deviceVulnerabilities)
    .where(inArray(deviceVulnerabilities.id, unique));
  const byId = new Map(rows.map((r) => [r.id, r]));

  const deviceIds = [...new Set(rows.map((r) => r.deviceId))];
  const orgCond = auth.orgCondition(devices.orgId);
  const deviceRows =
    deviceIds.length > 0
      ? await db
          .select({ id: devices.id, siteId: devices.siteId })
          .from(devices)
          .where(orgCond ? and(inArray(devices.id, deviceIds), orgCond) : inArray(devices.id, deviceIds))
      : [];
  const deviceById = new Map(deviceRows.map((d) => [d.id, d]));

  const valid: BulkFindingRow[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const id of unique) {
    const row = byId.get(id);
    if (!row) {
      skipped.push({ id, reason: 'finding not found' });
      continue;
    }
    const device = deviceById.get(row.deviceId);
    if (!device) {
      // Device outside the caller's org scope reads as not-found (no existence leak).
      skipped.push({ id, reason: 'finding not found' });
      continue;
    }
    if (auth.canAccessSite && !auth.canAccessSite(device.siteId)) {
      skipped.push({ id, reason: 'site access denied' });
      continue;
    }
    valid.push(row);
  }
  return { valid, skipped };
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
  filters: { severity?: string; cve?: string; kevOnly?: boolean; patchAvailable?: boolean },
): Promise<CatalogRow[]> {
  if (vulnerabilityIds.length === 0) return [];

  const conditions: SQL[] = [inArray(vulnerabilities.id, vulnerabilityIds)];
  if (filters.severity) {
    conditions.push(eq(vulnerabilities.severity, filters.severity));
  }
  if (filters.cve) {
    conditions.push(ilike(vulnerabilities.cveId, `%${filters.cve}%`));
  }
  if (filters.kevOnly) {
    conditions.push(eq(vulnerabilities.knownExploited, true));
  }
  if (filters.patchAvailable) {
    conditions.push(eq(vulnerabilities.patchAvailable, true));
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
  kevOnly?: boolean;
  patchAvailable?: boolean;
  /** Site-axis narrowing: when set, only return findings for devices in these sites.
   *  Empty array = caller has no in-scope sites → return nothing (fail-closed). */
  allowedSiteIds?: string[];
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
  // Site-axis (app-layer only; RLS does NOT enforce site isolation). Mirrors
  // assertDeviceSiteAccess used by per-device routes in this file and
  // the allowedSiteIds filter pattern in reports/data.ts.
  if (filters.allowedSiteIds !== undefined) {
    if (filters.allowedSiteIds.length === 0) {
      return [];
    }
    const allowedDeviceRows = await db
      .select({ id: devices.id })
      .from(devices)
      .where(inArray(devices.siteId, filters.allowedSiteIds));
    const allowedDeviceIds = allowedDeviceRows.map((r) => r.id);
    if (allowedDeviceIds.length === 0) {
      return [];
    }
    conditions.push(inArray(deviceVulnerabilities.deviceId, allowedDeviceIds));
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
    kevOnly: filters.kevOnly,
    patchAvailable: filters.patchAvailable,
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
  patchAvailable: boolean;
  statuses: string[];
};

/**
 * Collapse per-device findings into one row per CVE for the fleet view.
 * `id` = vulnerabilityId (stable aggregate key). Risk fields are CVE-constant;
 * we take the max riskScore across devices to be safe. Sort: riskScore DESC,
 * knownExploited (true first), epssScore DESC, cvssScore DESC — all nulls last.
 */
function aggregateFleet(items: MergedItem[]): FleetRow[] {
  const byVuln = new Map<string, FleetRow>();
  const statusesByVuln = new Map<string, Set<string>>();
  for (const item of items) {
    const statuses = statusesByVuln.get(item.vulnerabilityId);
    if (statuses) {
      statuses.add(item.status);
    } else {
      statusesByVuln.set(item.vulnerabilityId, new Set([item.status]));
    }

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
      patchAvailable: item.patchAvailable,
      statuses: [],
    });
  }

  for (const row of byVuln.values()) {
    const statuses = statusesByVuln.get(row.id);
    row.statuses = statuses ? [...statuses].sort() : [];
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
  // Site-axis narrowing for the fleet view: per-device routes already gate via
  // assertDeviceSiteAccess; this fleet (all-devices) query must also restrict to
  // the caller's allowed sites. Mirrors the site-filter pattern in core.ts.
  const perms = c.get('permissions') as UserPermissions | undefined;
  const items = await listVulnerabilities({
    ...query,
    allowedSiteIds: perms?.allowedSiteIds,
  });
  return c.json({ items: aggregateFleet(items) });
});

// Fleet work queue: one row per remediation unit (software product or OS
// pseudo-group). Group cardinality is fleet-bounded; hard cap + hasMore
// instead of pagination.
vulnerabilityRoutes.get('/software', zValidator('query', softwareQuerySchema), async (c) => {
  const query = c.req.valid('query');
  const perms = c.get('permissions') as UserPermissions | undefined;
  const rows = await fetchFleetFindingRows({
    status: query.status,
    allowedSiteIds: perms?.allowedSiteIds,
  });
  const filtered = filterFindings(rows, {
    status: query.status,
    severity: query.severity,
    kevOnly: query.kevOnly,
    patchAvailable: query.patchAvailable,
  });
  const groups = groupFindings(filtered, { search: query.search });
  return c.json({
    items: groups.slice(0, SOFTWARE_GROUP_CAP),
    hasMore: groups.length > SOFTWARE_GROUP_CAP,
  });
});

// Software-group drawer payload: group summary + per-CVE rollup + raw findings.
vulnerabilityRoutes.get('/software/:groupKey', zValidator('param', groupKeyParamSchema), async (c) => {
  const { groupKey } = c.req.valid('param');
  const perms = c.get('permissions') as UserPermissions | undefined;
  // status 'all' so the drawer can show accepted/mitigated findings alongside
  // open ones (reopen lives in the drawers).
  const rows = await fetchFleetFindingRows({ status: 'all', allowedSiteIds: perms?.allowedSiteIds });
  const detail = buildGroupDetail(groupKey, rows);
  if (!detail) {
    return c.json({ error: 'Group not found' }, 404);
  }
  return c.json(detail);
});

// The four stat-card numbers in one call. Needs every status: open findings
// feed three cards, accepted findings feed the expiring-soon card.
vulnerabilityRoutes.get('/stats', async (c) => {
  const perms = c.get('permissions') as UserPermissions | undefined;
  const rows = await fetchFleetFindingRows({
    status: 'all',
    allowedSiteIds: perms?.allowedSiteIds,
  });
  return c.json(computeStats(rows, new Date()));
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

// CVE drawer payload: catalog record + fleet findings for that CVE. Registered
// LAST among the GET routes — a param in the first path segment would
// otherwise shadow every static-first-segment GET route above it
// (/software, /software/:groupKey, /stats, /devices/:deviceId).
vulnerabilityRoutes.get('/:cveId/devices', zValidator('param', cveIdParamSchema), async (c) => {
  const { cveId } = c.req.valid('param');
  const cve = await fetchCveCatalogRecord(cveId);
  if (!cve) {
    return c.json({ error: 'CVE not found' }, 404);
  }
  const perms = c.get('permissions') as UserPermissions | undefined;
  const rows = await fetchFleetFindingRows({ status: 'all', allowedSiteIds: perms?.allowedSiteIds });
  const target = cveId.toLowerCase();
  const findings = rows
    .filter((r) => r.cveId.toLowerCase() === target)
    .map(toGroupFinding)
    .sort((a, b) => a.deviceName.localeCompare(b.deviceName));
  return c.json({ cve, findings });
});

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

// POST /bulk/accept-risk — accept risk for many findings at once, fault-tolerant
// per item. MUST be registered before /:id/accept-risk below: Hono's router
// matches in registration order, so a param route registered first would
// otherwise shadow this static path (bound as id="bulk").
vulnerabilityRoutes.post(
  '/bulk/accept-risk',
  requirePermission(PERMISSIONS.VULN_RISK_ACCEPT.resource, PERMISSIONS.VULN_RISK_ACCEPT.action),
  zValidator('json', bulkAcceptRiskSchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceVulnerabilityIds, reason, acceptedUntil } = c.req.valid('json');

    if (new Date(acceptedUntil).getTime() <= Date.now()) {
      return c.json({ success: false, error: 'acceptedUntil must be in the future' }, 400);
    }

    const { valid, skipped } = await loadFindingsForBulkWrite(deviceVulnerabilityIds, auth);
    if (valid.length > 0) {
      await db
        .update(deviceVulnerabilities)
        .set({
          status: 'accepted',
          acceptedBy: auth.user.id,
          acceptedUntil: new Date(acceptedUntil),
          // Acceptance rationale reuses mitigation_note — same as the
          // per-finding accept-risk endpoint (no dedicated reason column).
          mitigationNote: reason,
          updatedAt: new Date(),
        })
        .where(inArray(deviceVulnerabilities.id, valid.map((v) => v.id)));
      for (const row of valid) {
        writeRouteAudit(c, {
          orgId: row.orgId,
          action: 'vulnerability.accept_risk',
          resourceType: 'device_vulnerability',
          resourceId: row.id,
          details: { acceptedUntil, reason, bulk: true },
        });
      }
    }
    return c.json({ success: valid.length > 0, succeeded: valid.length, skipped });
  },
);

// POST /bulk/mitigate — mitigate many findings at once, fault-tolerant per item.
// MUST be registered before /:id/mitigate below (same shadowing reason as above).
vulnerabilityRoutes.post(
  '/bulk/mitigate',
  requireVulnerabilityWrite,
  zValidator('json', bulkMitigateSchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceVulnerabilityIds, note } = c.req.valid('json');

    const { valid, skipped } = await loadFindingsForBulkWrite(deviceVulnerabilityIds, auth);
    if (valid.length > 0) {
      await db
        .update(deviceVulnerabilities)
        .set({ status: 'mitigated', mitigationNote: note, resolvedAt: new Date(), updatedAt: new Date() })
        .where(inArray(deviceVulnerabilities.id, valid.map((v) => v.id)));
      for (const row of valid) {
        writeRouteAudit(c, {
          orgId: row.orgId,
          action: 'vulnerability.mitigate',
          resourceType: 'device_vulnerability',
          resourceId: row.id,
          details: { note, bulk: true },
        });
      }
    }
    return c.json({ success: valid.length > 0, succeeded: valid.length, skipped });
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

// Manually trigger a correlation pass (platform-admin + MFA via the `*` mw above).
// Useful to populate device_vulnerabilities immediately after enabling the
// `vulnerability` config-policy feature for an org, instead of waiting for the
// daily 13:00 UTC schedule.
vulnerabilitySyncRoutes.post(
  '/correlate',
  userRateLimit('vuln-manual-correlate', 10, 3600), // 10/hour/user
  async (c) => {
    const jobId = await enqueueVulnCorrelation();
    writeRouteAudit(c, {
      orgId: null,
      action: 'vulnerability.manual_correlate',
      resourceType: 'vulnerability_source',
      details: { jobId },
    });
    return c.json({ enqueued: true, jobId });
  },
);
