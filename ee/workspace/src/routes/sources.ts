import { pgErrorCode } from '@breeze/shared/pgErrors';
import type { ExtensionLog, WorkspaceAudit } from '../hostTypes';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  createCredentialService,
} from '../services/credentialService';
import {
  createSourcesService,
  SourceValidationError,
  type CrawlRunRow,
  type SafeSourceRow,
} from '../services/sourcesService';
import { adminGate, type WorkspaceRouteEnv } from './adminGate';

type SourcesService = Pick<
  ReturnType<typeof createSourcesService>,
  'list' | 'get' | 'create' | 'update' | 'remove' | 'listRuns'
>;
type CredentialService = Pick<
  ReturnType<typeof createCredentialService>,
  'set' | 'clear'
>;

export interface SourcesRouteDeps {
  sourcesService: SourcesService;
  credentialService: CredentialService;
  audit: WorkspaceAudit;
  log: ExtensionLog;
}

type SmbConfig = {
  kind?: 'smb_share' | 'local_profile';
  rootPath?: string;
  crawlDeviceId?: string | null;
};

function validateSmbConfig(input: SmbConfig, ctx: z.RefinementCtx): void {
  if (input.kind === 'local_profile') {
    // #3472: crawl_device_id is only meaningful for smb_share. A local_profile
    // row carrying one is the exact shape deviceSummaryService's owned-sources
    // branch defends against with `device_id IS NULL` — without that guard the
    // source would attribute every OTHER device's device-scoped rows to its
    // crawl device. Enforce the invariant on WRITE instead of relying on the
    // read side to keep absorbing it.
    if (input.crawlDeviceId) {
      ctx.addIssue({
        code: 'custom',
        path: ['crawlDeviceId'],
        message: 'local_profile sources cannot have a crawl device',
      });
    }
    return;
  }
  if (input.kind !== 'smb_share') return;
  if (!input.crawlDeviceId) {
    ctx.addIssue({ code: 'custom', path: ['crawlDeviceId'], message: 'SMB sources require a crawl device' });
  }
  if (!input.rootPath?.startsWith('\\\\')) {
    ctx.addIssue({ code: 'custom', path: ['rootPath'], message: 'SMB sources require a UNC root path' });
  }
}

// crawl_cadence_minutes is an int4 column; the cap (one year) exists so an
// oversized-but-valid JSON number is a 400 here, not an overflow 500 at the DB.
const MAX_CADENCE_MINUTES = 525_600;

const sourceInputBaseSchema = z.object({
  kind: z.enum(['smb_share', 'local_profile']),
  displayName: z.string().min(1).max(256),
  rootPath: z.string().min(1).max(4096),
  crawlDeviceId: z.uuid().nullable().optional(),
  visibilityGroupIds: z.array(z.uuid()).max(256),
  crawlCadenceMinutes: z.number().int().positive().max(MAX_CADENCE_MINUTES),
  excludeGlobs: z.array(z.string().max(1024)).max(256),
  watch: z.boolean(),
  status: z.enum(['active', 'paused']),
}).strict();

const sourceInputSchema = sourceInputBaseSchema.superRefine(validateSmbConfig);
const sourcePatchSchema = sourceInputBaseSchema.partial().refine(
  (patch) => Object.keys(patch).length > 0,
  { message: 'At least one source field is required' },
);
const smbConfigSchema = z.object({
  kind: z.enum(['smb_share', 'local_profile']),
  rootPath: z.string(),
  crawlDeviceId: z.uuid().nullable().optional(),
}).superRefine(validateSmbConfig);
const credentialSchema = z.object({
  username: z.string().min(1).max(512),
  password: z.string().min(1).max(512),
  domain: z.string().max(512).optional(),
}).strict();
const runLimitSchema = z.coerce.number().int().min(1).max(100);

type MutationAction =
  | 'workspace.source.create'
  | 'workspace.source.update'
  | 'workspace.source.delete'
  | 'workspace.source.credential.set'
  | 'workspace.source.credential.clear';

function publicSource(row: SafeSourceRow): Record<string, unknown> {
  return {
    id: row.id,
    orgId: row.orgId,
    kind: row.kind,
    displayName: row.displayName,
    rootPath: row.rootPath,
    crawlDeviceId: row.crawlDeviceId,
    visibilityGroupIds: row.visibilityGroupIds,
    crawlCadenceMinutes: row.crawlCadenceMinutes,
    excludeGlobs: row.excludeGlobs,
    watch: row.watch,
    status: row.status,
    errorReason: row.errorReason,
    lastCompleteRunAt: row.lastCompleteRunAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    hasCredential: row.hasCredential,
  };
}

// Projection for admin run listings; cursor and deviceKey are internal
// (agent-resume state and the NULL-proof index key) and stay server-side.
function publicRun(run: CrawlRunRow): Record<string, unknown> {
  return {
    id: run.id,
    sourceId: run.sourceId,
    deviceId: run.deviceId,
    status: run.status,
    startedAt: run.startedAt,
    lastActivityAt: run.lastActivityAt,
    completedAt: run.completedAt,
    stats: run.stats,
    errorReason: run.errorReason,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isForeignKeyViolation(error: unknown): boolean {
  return pgErrorCode(error) === '23503';
}

export function createSourcesRoutes(deps: SourcesRouteDeps): Hono<WorkspaceRouteEnv> {
  const app = new Hono<WorkspaceRouteEnv>();
  app.use('*', adminGate);

  const audit = async (
    auth: WorkspaceRouteEnv['Variables']['auth'],
    orgId: string,
    action: MutationAction,
    result: 'success' | 'failure',
    resourceId?: string,
    error?: unknown,
  ) => {
    const auditErrorMessage = error === undefined
      ? undefined
      : action.startsWith('workspace.source.credential.')
        ? 'Credential operation failed'
        : errorMessage(error);
    try {
      await deps.audit({
        actorType: 'user',
        actorId: auth.user.id,
        orgId,
        action,
        resourceType: 'workspace_source',
        ...(resourceId === undefined ? {} : { resourceId }),
        result,
        ...(auditErrorMessage === undefined ? {} : { errorMessage: auditErrorMessage }),
      });
    } catch (auditError) {
      // Audit transport failure must not rewrite the outcome of an already-
      // completed mutation — but it must be visible: an undetectable hole in
      // the audit trail is an incident of its own.
      deps.log(
        'error',
        `workspace audit write failed action=${action} org=${orgId}` +
        `${resourceId === undefined ? '' : ` resource=${resourceId}`}: ${errorMessage(auditError)}`,
      );
    }
  };

  const readBody = async <T>(
    c: Context<WorkspaceRouteEnv>,
    schema: z.ZodType<T>,
  ): Promise<{ data: T } | { response: Response }> => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return { response: c.json({ error: 'Invalid JSON body' }, 400) };
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return { response: c.json({ error: 'Invalid request body' }, 400) };
    }
    return { data: parsed.data };
  };

  app.get('/sources', async (c) => {
    const rows = await deps.sourcesService.list(c.get('workspaceOrgId'));
    return c.json({ sources: rows.map(publicSource) });
  });

  app.post('/sources', async (c) => {
    const parsed = await readBody(c, sourceInputSchema);
    if ('response' in parsed) return parsed.response;
    const auth = c.get('auth');
    const orgId = c.get('workspaceOrgId');
    try {
      const created = await deps.sourcesService.create(orgId, parsed.data);
      await audit(auth, orgId, 'workspace.source.create', 'success', created.id);
      return c.json(publicSource(created), 201);
    } catch (error) {
      await audit(auth, orgId, 'workspace.source.create', 'failure', undefined, error);
      if (error instanceof SourceValidationError) {
        return c.json({ error: error.message }, 400);
      }
      if (isForeignKeyViolation(error)) {
        return c.json({ error: 'crawlDeviceId does not reference a known device' }, 400);
      }
      return c.json({ error: 'Failed to create source' }, 500);
    }
  });

  app.get('/sources/:id', async (c) => {
    const row = await deps.sourcesService.get(c.get('workspaceOrgId'), c.req.param('id'));
    if (!row) return c.json({ error: 'Source not found' }, 404);
    return c.json(publicSource(row));
  });

  app.patch('/sources/:id', async (c) => {
    const parsed = await readBody(c, sourcePatchSchema);
    if ('response' in parsed) return parsed.response;
    const auth = c.get('auth');
    const orgId = c.get('workspaceOrgId');
    const sourceId = c.req.param('id');
    try {
      const existing = await deps.sourcesService.get(orgId, sourceId);
      if (!existing) {
        await audit(auth, orgId, 'workspace.source.update', 'failure', sourceId);
        return c.json({ error: 'Source not found' }, 404);
      }
      // Validate the plain merge — the state the row will actually hold. A flip
      // to local_profile that leaves a stale crawl device is REJECTED here
      // rather than silently nulled (#3472); the web form always sends
      // `crawlDeviceId` explicitly, so a deliberate flip still passes.
      // sourcesService.update re-validates the same merge, so a caller that
      // bypasses this route cannot write the shape either.
      const mergedConfig = smbConfigSchema.safeParse({
        kind: parsed.data.kind ?? existing.kind,
        rootPath: parsed.data.rootPath ?? existing.rootPath,
        crawlDeviceId: parsed.data.crawlDeviceId === undefined
          ? existing.crawlDeviceId
          : parsed.data.crawlDeviceId,
      });
      if (!mergedConfig.success) {
        // Surface the specific issue rather than a generic string: the merged
        // check is the only thing a caller sees when an existing row is the
        // problem, so "Invalid request body" leaves them nothing to act on.
        return c.json({
          error: mergedConfig.error.issues[0]?.message ?? 'Invalid request body',
        }, 400);
      }
      const updated = await deps.sourcesService.update(orgId, sourceId, parsed.data);
      if (!updated) {
        await audit(auth, orgId, 'workspace.source.update', 'failure', sourceId);
        return c.json({ error: 'Source not found' }, 404);
      }
      await audit(auth, orgId, 'workspace.source.update', 'success', sourceId);
      return c.json(publicSource(updated));
    } catch (error) {
      await audit(auth, orgId, 'workspace.source.update', 'failure', sourceId, error);
      // The merged smbConfigSchema check above rejects the same states, so in
      // practice this branch is unreachable through this route. It is here
      // because the two validators are independent: if they ever drift, an
      // invalid patch must still surface as a 400, not an opaque 500. POST
      // already maps SourceValidationError this way.
      if (error instanceof SourceValidationError) {
        return c.json({ error: error.message }, 400);
      }
      if (isForeignKeyViolation(error)) {
        return c.json({ error: 'crawlDeviceId does not reference a known device' }, 400);
      }
      return c.json({ error: 'Failed to update source' }, 500);
    }
  });

  app.delete('/sources/:id', async (c) => {
    const auth = c.get('auth');
    const orgId = c.get('workspaceOrgId');
    const sourceId = c.req.param('id');
    try {
      const removed = await deps.sourcesService.remove(orgId, sourceId);
      if (!removed) {
        await audit(auth, orgId, 'workspace.source.delete', 'failure', sourceId);
        return c.json({ error: 'Source not found' }, 404);
      }
      await audit(auth, orgId, 'workspace.source.delete', 'success', sourceId);
      return c.json({ success: true });
    } catch (error) {
      await audit(auth, orgId, 'workspace.source.delete', 'failure', sourceId, error);
      return c.json({ error: 'Failed to delete source' }, 500);
    }
  });

  app.put('/sources/:id/credential', async (c) => {
    const parsed = await readBody(c, credentialSchema);
    if ('response' in parsed) return parsed.response;
    const auth = c.get('auth');
    const orgId = c.get('workspaceOrgId');
    const sourceId = c.req.param('id');
    try {
      const source = await deps.sourcesService.get(orgId, sourceId);
      if (!source) {
        await audit(auth, orgId, 'workspace.source.credential.set', 'failure', sourceId);
        return c.json({ error: 'Source not found' }, 404);
      }
      if (source.kind !== 'smb_share') {
        await audit(auth, orgId, 'workspace.source.credential.set', 'failure', sourceId);
        return c.json({ error: 'Credentials apply only to SMB sources' }, 400);
      }
      const stored = await deps.credentialService.set(orgId, sourceId, parsed.data);
      if (!stored) {
        await audit(auth, orgId, 'workspace.source.credential.set', 'failure', sourceId);
        return c.json({ error: 'Source not found' }, 404);
      }
      await audit(auth, orgId, 'workspace.source.credential.set', 'success', sourceId);
      return c.json({ success: true });
    } catch (error) {
      await audit(auth, orgId, 'workspace.source.credential.set', 'failure', sourceId, error);
      return c.json({ error: 'Failed to set credential' }, 500);
    }
  });

  app.delete('/sources/:id/credential', async (c) => {
    const auth = c.get('auth');
    const orgId = c.get('workspaceOrgId');
    const sourceId = c.req.param('id');
    try {
      const cleared = await deps.credentialService.clear(orgId, sourceId);
      if (!cleared) {
        await audit(auth, orgId, 'workspace.source.credential.clear', 'failure', sourceId);
        return c.json({ error: 'Source not found' }, 404);
      }
      await audit(auth, orgId, 'workspace.source.credential.clear', 'success', sourceId);
      return c.json({ success: true });
    } catch (error) {
      await audit(auth, orgId, 'workspace.source.credential.clear', 'failure', sourceId, error);
      return c.json({ error: 'Failed to clear credential' }, 500);
    }
  });

  app.get('/sources/:id/runs', async (c) => {
    const orgId = c.get('workspaceOrgId');
    const sourceId = c.req.param('id');
    const parsedLimit = runLimitSchema.safeParse(c.req.query('limit') ?? 20);
    if (!parsedLimit.success) return c.json({ error: 'Invalid limit' }, 400);
    const source = await deps.sourcesService.get(orgId, sourceId);
    if (!source) return c.json({ error: 'Source not found' }, 404);
    const runs = await deps.sourcesService.listRuns(orgId, sourceId, parsedLimit.data);
    return c.json({ runs: runs.map(publicRun) });
  });

  return app;
}
