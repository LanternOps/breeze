import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { EDR_DETECTION_STATUSES, EDR_SEVERITIES, type EdrDetectionDto } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import {
  EDR_DETECTIONS_MAX_LIMIT,
  EdrReadError,
  getEdrStatus,
  listEdrDetections,
  resolveEdrReadScope,
} from '../../services/edrProviders/read';
import { COVERAGE_MAX_LIMIT, readSecurityAgentCoverage } from '../../services/securityAgents/coverageRead';

/**
 * EDR-framework detection reads (#8166 W02). Thin over the shared read model
 * (services/edrProviders/read.ts), which the AI tools also use. Every response
 * carries `coverage`: an empty list with `partial: true` is NOT "no threats".
 */
export const edrDetectionRoutes = new Hono();

const requireDevicesRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);

const severityList = z
  .string()
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
  .pipe(z.array(z.enum(EDR_SEVERITIES)).min(1));

const listQuerySchema = z.object({
  orgId: z.string().guid().optional(),
  deviceId: z.string().guid().optional(),
  severity: severityList.optional(),
  status: z.enum(['open', 'all', ...EDR_DETECTION_STATUSES]).default('open'),
  provider: z.string().min(1).max(30).optional(),
  // Clamped, not refused: a client asking for more gets the maximum page.
  limit: z.coerce.number().int().min(1).default(50).transform((n) => Math.min(n, EDR_DETECTIONS_MAX_LIMIT)),
  offset: z.coerce.number().int().min(0).default(0),
});

const statusQuerySchema = z.object({ orgId: z.string().guid().optional() });

/** Explicit allow-list projection: vendor jsonb never leaves the API. */
function project(row: EdrDetectionDto): EdrDetectionDto {
  const out: EdrDetectionDto = {
    id: row.id,
    orgId: row.orgId,
    provider: row.provider,
    providerLabel: row.providerLabel,
    vendorDetectionId: row.vendorDetectionId,
    vendorKind: row.vendorKind,
    severity: row.severity,
    status: row.status,
    title: row.title,
    category: row.category,
    threatName: row.threatName,
    filePath: row.filePath,
    processName: row.processName,
    mitreTechniques: row.mitreTechniques,
    detectedAt: row.detectedAt,
    resolvedAt: row.resolvedAt,
    endpointId: row.endpointId,
    breezeDeviceId: row.breezeDeviceId,
    deviceName: row.deviceName,
    detached: row.detached,
    promotedIncidentId: row.promotedIncidentId,
  };
  if (row.connectionId !== undefined) out.connectionId = row.connectionId;
  return out;
}

// GET /edr/detections
edrDetectionRoutes.get(
  '/detections',
  requireScope('organization', 'partner', 'system'),
  requireDevicesRead,
  zValidator('query', listQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const q = c.req.valid('query');
    try {
      const scope = await resolveEdrReadScope(auth, perms);
      const result = await listEdrDetections(scope, {
        orgId: q.orgId,
        deviceId: q.deviceId,
        severity: q.severity,
        status: q.status,
        provider: q.provider,
        limit: q.limit,
        offset: q.offset,
      });
      return c.json({
        data: result.rows.map(project),
        pagination: { limit: q.limit, offset: q.offset, total: result.total },
        coverage: result.coverage,
      });
    } catch (err) {
      if (err instanceof EdrReadError) return c.json({ error: err.message }, err.status as ContentfulStatusCode);
      throw err;
    }
  },
);

// GET /edr/status
edrDetectionRoutes.get(
  '/status',
  requireScope('organization', 'partner', 'system'),
  requireDevicesRead,
  zValidator('query', statusQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const q = c.req.valid('query');
    try {
      const scope = await resolveEdrReadScope(auth, perms);
      return c.json({ data: await getEdrStatus(scope, { orgId: q.orgId }) });
    } catch (err) {
      if (err instanceof EdrReadError) return c.json({ error: err.message }, err.status as ContentfulStatusCode);
      throw err;
    }
  },
);

// ---------------------------------------------------------------------------
// Security agent coverage (#6960 W03)
// ---------------------------------------------------------------------------
//
// READ-ONLY. Coverage is derived state written by the software compliance
// worker and the coverage reconciler; nothing here mutates it. It lives on the
// EDR read surface because that is where it is shown (EDR summary, device EDR
// panel) and it shares the same org/site read scope.

const COVERAGE_STATES = ['covered', 'gap', 'vendor_only', 'vendor_offline', 'mismatched_org', 'not_applicable', 'pending'] as const;
const COVERAGE_VENDORS = ['huntress', 'sentinelone', 'controld', 'nextdns'] as const;

const coverageStateList = z
  .string()
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
  .pipe(z.array(z.enum(COVERAGE_STATES)).min(1));

const coverageQuerySchema = z.object({
  orgId: z.string().guid().optional(),
  deviceId: z.string().guid().optional(),
  vendor: z.enum(COVERAGE_VENDORS).optional(),
  state: coverageStateList.optional(),
  limit: z.coerce.number().int().min(1).default(50).transform((n) => Math.min(n, COVERAGE_MAX_LIMIT)),
  offset: z.coerce.number().int().min(0).default(0),
});

// GET /edr/security-agents/coverage
edrDetectionRoutes.get(
  '/security-agents/coverage',
  requireScope('organization', 'partner', 'system'),
  requireDevicesRead,
  zValidator('query', coverageQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const q = c.req.valid('query');
    try {
      const scope = await resolveEdrReadScope(auth, perms);
      const result = await readSecurityAgentCoverage(scope, {
        orgId: q.orgId,
        deviceId: q.deviceId,
        vendor: q.vendor,
        states: q.state,
        limit: q.limit,
        offset: q.offset,
      });
      return c.json({
        summary: result.summary,
        data: result.rows,
        pagination: { limit: q.limit, offset: q.offset, total: result.total },
      });
    } catch (err) {
      if (err instanceof EdrReadError) return c.json({ error: err.message }, err.status as ContentfulStatusCode);
      throw err;
    }
  },
);
