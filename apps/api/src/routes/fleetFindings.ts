import { Hono } from 'hono';
import { z } from 'zod';

import { zValidator } from '../lib/validation';
import { authMiddleware, requirePermission, requireScope } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import {
  applyFleetFindingLifecycle,
  getFleetFinding,
  listFleetFindings,
  type FleetFindingLifecycleAction,
} from '../services/fleetFindings/query';
import { PERMISSIONS } from '../services/permissions';

export const fleetFindingsRoutes = new Hono();

fleetFindingsRoutes.use('*', authMiddleware);

const KIND_VALUES = ['metric_anomaly_pattern', 'log_correlation', 'reliability_offenders'] as const;
const SEVERITY_VALUES = ['info', 'warning', 'error', 'critical'] as const;
const STATUS_VALUES = ['open', 'acknowledged', 'dismissed', 'resolved'] as const;
const STATUS_SET = new Set<string>(STATUS_VALUES);
const DEFAULT_STATUSES = ['open', 'acknowledged'] as const;
const LIFECYCLE_ACTIONS = ['acknowledge', 'dismiss', 'reopen'] as const;

type StatusValue = (typeof STATUS_VALUES)[number];

/** `status=open,acknowledged` CSV -> validated array, or `null` on an unknown value. */
function parseStatusCsv(raw: string | undefined): StatusValue[] | null {
  if (!raw) return [...DEFAULT_STATUSES];
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length === 0) return [...DEFAULT_STATUSES];
  for (const item of items) {
    if (!STATUS_SET.has(item)) return null;
  }
  return items as StatusValue[];
}

const listQuerySchema = z.object({
  orgId: z.string().guid().optional(),
  kind: z.enum(KIND_VALUES).optional(),
  severity: z.enum(SEVERITY_VALUES).optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const patchBodySchema = z.object({
  action: z.enum(LIFECYCLE_ACTIONS),
  notes: z.string().max(2000).optional(),
});

const requireFindingsRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);
const requireFindingsWrite = requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);

fleetFindingsRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  requireFindingsRead,
  zValidator('query', listQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    if (query.orgId && !auth.canAccessOrg(query.orgId)) {
      return c.json({ error: 'Access to this organization denied' }, 403);
    }

    const statuses = parseStatusCsv(query.status);
    if (!statuses) {
      return c.json({ error: `Invalid status filter. Allowed values: ${STATUS_VALUES.join(', ')}` }, 400);
    }

    const result = await listFleetFindings(auth, {
      orgId: query.orgId,
      kind: query.kind,
      severity: query.severity,
      statuses,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });

    return c.json(result);
  }
);

// Task 7 adds `GET /runs/:runId` (top-level) and `GET /:id/runs`,
// `POST /:id/remediate`. `/runs/:runId` is two path segments so it cannot be
// swallowed by the single-segment `/:id` below regardless of registration
// order — but register any NEW single-segment static route (e.g. a bare
// `/runs`) BEFORE `/:id` all the same, to avoid Hono matching it as an id.
fleetFindingsRoutes.get('/:id', requireScope('organization', 'partner', 'system'), requireFindingsRead, async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id')!;

  const finding = await getFleetFinding(auth, id);
  if (!finding) {
    return c.json({ error: 'Finding not found' }, 404);
  }

  return c.json(finding);
});

fleetFindingsRoutes.patch(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requireFindingsWrite,
  zValidator('json', patchBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const id = c.req.param('id')!;
    const body = c.req.valid('json');

    const result = await applyFleetFindingLifecycle(
      auth,
      id,
      body.action as FleetFindingLifecycleAction,
      body.notes,
      auth.user.id
    );

    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }

    writeRouteAudit(c, {
      orgId: result.finding.orgId,
      action: `fleet_finding.${body.action}`,
      resourceType: 'fleet_finding',
      resourceId: result.finding.id,
      resourceName: result.finding.title,
      details: { notes: body.notes ?? null, newStatus: result.finding.status },
    });

    return c.json(result.finding);
  }
);
