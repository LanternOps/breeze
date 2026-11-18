import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { requireMfa, requirePermission, requireScope, withAuthDbAccessContext } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS } from '../../services/permissions';
import { isS3Configured } from '../../services/s3Storage';
import { enqueueTicketImportSlice } from '../../services/ticketImport/importQueue';
import { RUN_ISSUE_KINDS } from '../../services/ticketImport/runReport';
import { cancelRun, failQueuedRun, getRun, listRunIssues, listRuns, startRun } from '../../services/ticketImport/runStore';
import { getSource } from '../../services/ticketImport/sourceStore';
import { callerPartner, idParamSchema, importErrorResponse, runIdParamSchema } from './shared';

/**
 * Runs of a source (#8313 W4; spec 2026-10-19 §5.7, §5.8). Starting a run
 * needs only a partner-wide admin: an import uses a window, which only the
 * principal's owner can open, and that window is the grant. Cancel narrows,
 * so any partner-wide admin may. Progress and the report are polled.
 *
 * POST /sources/:id/runs is in SELF_MANAGED_DB_CONTEXT_ROUTES: the run row
 * must commit before its first slice is enqueued, or the worker could pick
 * the job up before the row is visible.
 */
export const ticketImportRunRoutes = new Hono();

const readGate = [
  requireScope('partner'),
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
] as const;
const writeGate = [
  requireScope('partner'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
] as const;

const startSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dry_run') }).strict(),
  z.object({ kind: z.literal('import'), windowId: z.string().guid() }).strict(),
]);

const issuesQuerySchema = z.object({
  kind: z.enum(RUN_ISSUE_KINDS).optional(),
  after: z.string().guid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

ticketImportRunRoutes.post('/sources/:id/runs', ...writeGate, zValidator('param', idParamSchema), zValidator('json', startSchema), async (c) => {
  const caller = callerPartner(c);
  if ('response' in caller) return caller.response;
  const { auth, partnerId } = caller;
  const { id } = c.req.valid('param');
  const input = c.req.valid('json');
  try {
    const run = await withAuthDbAccessContext(auth, () => startRun({
      partnerId,
      sourceId: id,
      kind: input.kind,
      windowId: input.kind === 'import' ? input.windowId : undefined,
      startedBy: auth.user.id,
      objectStorageConfigured: isS3Configured(),
    }));
    try {
      await enqueueTicketImportSlice({ runId: run.id, partnerId, seq: 0 });
    } catch (error) {
      console.error('[ticketImports] could not enqueue the first slice', { runId: run.id, error: error instanceof Error ? error.message : error });
      // Free the source's one active run: nothing will ever run this one.
      await withAuthDbAccessContext(auth, () => failQueuedRun(partnerId, run.id, 'enqueue_failed'));
      return c.json({ error: 'The run could not be queued; try again', code: 'TICKET_IMPORT_QUEUE_UNAVAILABLE' }, 503);
    }
    writeRouteAudit(c as never, {
      orgId: null,
      action: 'ticket_import.run_started',
      resourceType: 'ticket_import_run',
      resourceId: run.id,
      details: { partnerId, sourceId: id, kind: run.kind, windowId: run.windowId },
    });
    return c.json({ data: run }, 201);
  } catch (error) {
    return importErrorResponse(c, error);
  }
});

ticketImportRunRoutes.get('/sources/:id/runs', ...readGate, zValidator('param', idParamSchema), async (c) => {
  const caller = callerPartner(c);
  if ('response' in caller) return caller.response;
  const { id } = c.req.valid('param');
  if (!(await getSource(caller.partnerId, id))) {
    return c.json({ error: 'Ticket import source not found', code: 'TICKET_IMPORT_SOURCE_NOT_FOUND' }, 404);
  }
  return c.json({ data: await listRuns(caller.partnerId, id) });
});

ticketImportRunRoutes.get('/runs/:runId', ...readGate, zValidator('param', runIdParamSchema), async (c) => {
  const caller = callerPartner(c);
  if ('response' in caller) return caller.response;
  const run = await getRun(caller.partnerId, c.req.valid('param').runId);
  if (!run) return c.json({ error: 'Ticket import run not found', code: 'TICKET_IMPORT_RUN_NOT_FOUND' }, 404);
  return c.json({ data: run });
});

ticketImportRunRoutes.get(
  '/runs/:runId/issues',
  ...readGate,
  zValidator('param', runIdParamSchema),
  zValidator('query', issuesQuerySchema),
  async (c) => {
    const caller = callerPartner(c);
    if ('response' in caller) return caller.response;
    const query = c.req.valid('query');
    const page = await listRunIssues({ partnerId: caller.partnerId, runId: c.req.valid('param').runId, ...query });
    if (!page) return c.json({ error: 'Ticket import run not found', code: 'TICKET_IMPORT_RUN_NOT_FOUND' }, 404);
    return c.json({ data: page.issues, next: page.next });
  },
);

ticketImportRunRoutes.post('/runs/:runId/cancel', ...writeGate, zValidator('param', runIdParamSchema), async (c) => {
  const caller = callerPartner(c);
  if ('response' in caller) return caller.response;
  const { runId } = c.req.valid('param');
  const result = await cancelRun(caller.partnerId, runId);
  if (!result) return c.json({ error: 'Ticket import run not found', code: 'TICKET_IMPORT_RUN_NOT_FOUND' }, 404);
  if (!result.alreadyFinished) {
    writeRouteAudit(c as never, {
      orgId: null,
      action: 'ticket_import.run_cancelled',
      resourceType: 'ticket_import_run',
      resourceId: runId,
      details: { partnerId: caller.partnerId, sourceId: result.run.sourceId, kind: result.run.kind },
    });
  }
  return c.json({ data: result.run, alreadyFinished: result.alreadyFinished });
});
