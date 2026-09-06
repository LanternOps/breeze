import { Hono } from 'hono';
import { z } from 'zod';

import { zValidator } from '../lib/validation';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import {
  createRemediationRun,
  markRunDispatchFailed,
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
import { captureException } from '../services/sentry';

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

const remediateSharedFields = {
  parameters: z.record(z.string(), z.unknown()).default({}),
  // Subset of finding membership; ABSENT = all current members, `[]` is
  // rejected outright (`.min(1)`) rather than silently treated the same as
  // absent — a caller who meant to scope the run to specific devices but
  // sent an empty array must get a 400, not an unintended fleet-wide run.
  // Bounded to cap request-body size / worst-case validation cost from an
  // authenticated caller — this is NOT `BULK_COMMAND_MAX_DEVICES` (500,
  // chosen for a *synchronous* bulk-command endpoint bounded by
  // Cloudflare's proxy timeout): remediation dispatch is async (BullMQ
  // chunks of its own, ≤500 each), so a single fleet-wide finding
  // legitimately spanning thousands of devices is an expected shape, not
  // an abuse signal.
  deviceIds: z.array(z.string().guid()).min(1).max(5000).optional(),
};

// Discriminated on `actionKind`, mirroring the `RemediateRequest` union in
// services/fleetFindings/dispatch.ts: `scriptId` is REQUIRED for a script and
// absent for a command, `commandType` vice versa. Both branches are `.strict()`
// so a body carrying BOTH fields is a 400 rather than a silent strip — under
// the previous both-optional object, `{actionKind:'script', scriptId, commandType:'reboot'}`
// validated, `commandType` was dropped on the floor, and the caller was never
// told which of the two things they asked for actually ran.
const remediateBodySchema = z.discriminatedUnion('actionKind', [
  z.object({
    actionKind: z.literal('script'),
    scriptId: z.string().guid(),
    // #4888 — run context for this remediation. Script branch only: a
    // `command` run has no script row whose default there would be anything
    // to override, and `.strict()` turns sending it on that branch into a 400
    // rather than a silently ignored field. Same enum as
    // `executeScriptSchema` — 'elevated' is not a launch-time choice.
    runAs: z.enum(['system', 'user']).optional(),
    ...remediateSharedFields,
  }).strict(),
  z.object({
    actionKind: z.literal('command'),
    commandType: z.enum(REMEDIATION_COMMAND_TYPE_ALLOWLIST),
    ...remediateSharedFields,
  }).strict(),
]);

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

    // The run + its `pending` targets are already committed at this point
    // (createRemediationRun succeeded). If enqueueing the dispatch/poll jobs
    // itself fails (e.g. Redis is down), that run would otherwise be
    // stranded forever — `queued` with targets nothing will ever pick up,
    // and no poll job to notice. Catch it, fail the run out explicitly
    // (mirrors a run whose devices were all invalid: terminal `failed`,
    // its pending targets marked `skipped`), and still audit — the outcome
    // is exactly the kind of thing an audit trail exists for.
    let dispatchEnqueueFailed = false;
    try {
      await enqueueRemediationDispatch(result.runId, result.targetCount);
    } catch (err) {
      dispatchEnqueueFailed = true;
      console.error(`[fleetFindings] Failed to enqueue remediation dispatch for run ${result.runId}:`, err);
      captureException(err instanceof Error ? err : new Error(String(err)), c, {
        service: 'fleetFindings.remediate',
        stage: 'enqueue',
        runId: result.runId,
      });

      // The recovery write can itself fail (the same outage that broke the
      // enqueue, an RLS denial, a dead connection). If it does, the run stays
      // `queued` with `pending` targets and NOTHING will ever move it — the
      // exact stranding markRunDispatchFailed exists to prevent — so it must
      // not be allowed to escape as an unhandled 500 that hides the original
      // enqueue failure. Report it and still return the 502 below: the caller
      // gets the same answer either way, but the stranded run is now visible.
      try {
        await markRunDispatchFailed(result.runId);
      } catch (markErr) {
        console.error(
          `[fleetFindings] Failed to mark run ${result.runId} dispatch-failed — run is stranded:`,
          markErr
        );
        captureException(markErr instanceof Error ? markErr : new Error(String(markErr)), c, {
          service: 'fleetFindings.remediate',
          stage: 'markRunDispatchFailed',
          runId: result.runId,
        });
      }
    }

    writeRouteAudit(c, {
      orgId: result.orgId,
      action: 'fleet_finding.remediate',
      resourceType: 'fleet_finding',
      resourceId: id,
      result: dispatchEnqueueFailed ? 'failure' : 'success',
      details: {
        runId: result.runId,
        actionKind: body.actionKind,
        commandType: body.actionKind === 'command' ? body.commandType : null,
        scriptId: body.actionKind === 'script' ? body.scriptId : null,
        // #4888 — null means "the script's saved default", which is what the
        // dispatcher will resolve it to.
        runAs: body.actionKind === 'script' ? body.runAs ?? null : null,
        targetCount: result.targetCount,
        skippedCount: result.skipped.length,
        dispatchEnqueueFailed,
      },
    });

    if (dispatchEnqueueFailed) {
      return c.json(
        { error: 'Failed to enqueue remediation dispatch', runId: result.runId },
        502
      );
    }

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
