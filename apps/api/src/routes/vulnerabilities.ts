import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, ilike, inArray, type SQL } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { deviceVulnerabilities, vulnerabilities } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { remediateVulnerabilities } from '../services/vulnerabilityRemediation';
import { writeRouteAudit } from '../services/auditEvents';

export const vulnerabilityRoutes = new Hono();

const requireVulnerabilityRead = requirePermission(
  PERMISSIONS.DEVICES_READ.resource,
  PERMISSIONS.DEVICES_READ.action,
);

const statusSchema = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase())
  .pipe(z.enum(['open', 'patched', 'mitigated', 'accepted']));

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
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => {
      const cvssOrder = compareScoresDescNullsLast(a.cvssScore, b.cvssScore);
      if (cvssOrder !== 0) return cvssOrder;
      return compareScoresDescNullsLast(a.riskScore, b.riskScore);
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
  const conditions: SQL[] = [eq(deviceVulnerabilities.status, filters.status)];
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

vulnerabilityRoutes.use('*', authMiddleware);
vulnerabilityRoutes.use('*', requireScope('organization', 'partner', 'system'));
vulnerabilityRoutes.use('*', requireVulnerabilityRead);

vulnerabilityRoutes.get('/', zValidator('query', listQuerySchema), async (c) => {
  const query = c.req.valid('query');
  const items = await listVulnerabilities(query);
  return c.json({ items });
});

vulnerabilityRoutes.get(
  '/devices/:deviceId',
  zValidator('param', deviceParamSchema),
  zValidator('query', listQuerySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const query = c.req.valid('query');
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
// state write (DEVICES_WRITE; no MFA/execute — it queues no command).
vulnerabilityRoutes.post(
  '/:id/accept-risk',
  requireVulnerabilityWrite,
  zValidator('param', idParamSchema),
  zValidator('json', acceptRiskSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const { reason, acceptedUntil } = c.req.valid('json');

    if (new Date(acceptedUntil).getTime() <= Date.now()) {
      return c.json({ success: false, error: 'acceptedUntil must be in the future' }, 400);
    }

    // Load under request RLS so a cross-org id is invisible (404, not a silent 0-row write).
    const [row] = await db
      .select({ id: deviceVulnerabilities.id, orgId: deviceVulnerabilities.orgId })
      .from(deviceVulnerabilities)
      .where(eq(deviceVulnerabilities.id, id))
      .limit(1);
    if (!row) {
      return c.json({ success: false, error: 'Vulnerability finding not found' }, 404);
    }

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

// POST /:id/mitigate — mark a finding mitigated with a note. Org-scoped state write.
vulnerabilityRoutes.post(
  '/:id/mitigate',
  requireVulnerabilityWrite,
  zValidator('param', idParamSchema),
  zValidator('json', mitigateSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { note } = c.req.valid('json');

    const [row] = await db
      .select({ id: deviceVulnerabilities.id, orgId: deviceVulnerabilities.orgId })
      .from(deviceVulnerabilities)
      .where(eq(deviceVulnerabilities.id, id))
      .limit(1);
    if (!row) {
      return c.json({ success: false, error: 'Vulnerability finding not found' }, 404);
    }

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
