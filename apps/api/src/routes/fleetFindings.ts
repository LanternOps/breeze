import { Hono } from 'hono';
import { z } from 'zod';

import { zValidator } from '../lib/validation';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import {
  createRemediationRun,
  REMEDIATION_COMMAND_TYPE_ALLOWLIST,
  RemediationRequestError,
  type RemediateRequest,
} from '../services/fleetFindings/dispatch';
import {
  applyFleetFindingLifecycle,
  getFleetFinding,
  getRemediationRun,
  listFleetFindings,
  type FleetFindingLifecycleAction,
} from '../services/fleetFindings/query';
import { enqueueRemediationDispatch } from '../jobs/fleetRemediationDispatch';
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

const remediateBodySchema = z.object({
  actionKind: z.enum(['script', 'command']),
  scriptId: z.string().guid().optional(),
  commandType: z.enum(REMEDIATION_COMMAND_TYPE_ALLOWLIST).optional(),
  parameters: z.record(z.string(), z.unknown()).default({}),
  // Subset of finding membership; absent = all current members. Bounded to
  // cap request-body size / worst-case validation cost from an authenticated
  // caller — this is NOT `BULK_COMMAND_MAX_DEVICES` (500, chosen for a
  // *synchronous* bulk-command endpoint bounded by Cloudflare's proxy
  // timeout): remediation dispatch is async (BullMQ chunks of its own,
  // ≤500 each), so a single fleet-wide finding legitimately spanning
  // thousands of devices is an expected shape, not an abuse signal.
  deviceIds: z.array(z.string().guid()).max(5000).optional(),
});

const requireFindingsRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);
const requireFindingsWrite = requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);
const requireFindingsExecute = requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action);

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

// `GET /runs/:runId` (top-level) and `GET /:id/runs` / `POST /:id/remediate`
// are all two path segments, so none of them can be swallowed by the
// single-segment `/:id` below regardless of registration order — but they're
// registered first anyway (and any NEW single-segment static route, e.g. a
// bare `/runs`, MUST be registered before `/:id`, to avoid Hono matching it
// as an id).
fleetFindingsRoutes.get('/runs/:runId', requireScope('organization', 'partner', 'system'), requireFindingsRead, async (c) => {
  const auth = c.get('auth');
  const runId = c.req.param('runId')!;

  const run = await getRemediationRun(auth, runId);
  if (!run) {
    return c.json({ error: 'Remediation run not found' }, 404);
  }

  return c.json(run);
});

fleetFindingsRoutes.get('/:id/runs', requireScope('organization', 'partner', 'system'), requireFindingsRead, async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id')!;

  const finding = await getFleetFinding(auth, id);
  if (!finding) {
    return c.json({ error: 'Finding not found' }, 404);
  }

  // `getFleetFinding` already caps this at the last 10 runs; that's fine for
  // this endpoint's purpose (recent remediation history alongside the
  // finding), not a general paginated run listing.
  return c.json({ runs: finding.runs });
});

fleetFindingsRoutes.post(
  '/:id/remediate',
  requireScope('organization', 'partner', 'system'),
  requireFindingsExecute,
  requireMfa(),
  zValidator('json', remediateBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const id = c.req.param('id')!;
    const body = c.req.valid('json') as RemediateRequest;

    let result;
    try {
      result = await createRemediationRun(auth, id, body);
    } catch (err) {
      if (err instanceof RemediationRequestError) {
        return c.json({ error: err.message }, err.status);
      }
      throw err;
    }

    await enqueueRemediationDispatch(result.runId, result.targetCount);

    writeRouteAudit(c, {
      orgId: result.orgId,
      action: 'fleet_finding.remediate',
      resourceType: 'fleet_finding',
      resourceId: id,
      details: {
        runId: result.runId,
        actionKind: body.actionKind,
        commandType: body.commandType ?? null,
        scriptId: body.scriptId ?? null,
        targetCount: result.targetCount,
        skippedCount: result.skipped.length,
      },
    });

    return c.json(
      { runId: result.runId, targetCount: result.targetCount, skipped: result.skipped },
      202
    );
  }
);

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
