import type {
  ExtensionAuditEvent,
  ExtensionHelperDevice,
  ExtensionLog,
  WorkspaceAudit,
} from '../hostTypes';
import { Hono } from 'hono';
import { z } from 'zod';
import { createActivityService } from '../services/activityService';
import { createContentSearchService } from '../services/contentSearchService';
import { createFileQueryService } from '../services/fileQueryService';
import { createFilingService } from '../services/filingService';

// End-user finder surface, authenticated by the core helper (Breeze Assist
// device-token) middleware — the gateway maps /helper/* here when the manifest
// sets helperRoutes. The helper session carries a device identity only; the
// optional helperUser label is device-local display text, never authorization.

export interface WorkspaceHelperRouteEnv {
  Variables: { helperDevice: ExtensionHelperDevice };
}

type FileQueryService = Pick<
  ReturnType<typeof createFileQueryService>,
  'visibleSources' | 'search' | 'browse'
>;
type ActivityService = Pick<
  ReturnType<typeof createActivityService>,
  'record' | 'recents' | 'departmentRecent'
>;

export interface HelperRouteDeps {
  fileQueryService: FileQueryService;
  activityService: ActivityService;
  /**
   * Content retrieval for the content layer. Only consulted when content is
   * enabled for the caller's org; while disabled the legacy search path below
   * runs untouched — byte-identical responses (snapshot-tested).
   */
  contentSearchService?: Pick<ReturnType<typeof createContentSearchService>, 'search' | 'passages'>;
  /** Filing panel backend; absent or content disabled → routes 404. */
  filingService?: Pick<ReturnType<typeof createFilingService>, 'list' | 'classify' | 'assign' | 'projects'>;
  /**
   * Per-org content flag (W2 Task 3): resolves the caller org's content
   * setting. Replaces the process-wide WORKSPACE_CONTENT_PREVIEW env var, so
   * content affordances can be on for one org and off for another in the same
   * process. Read once per request off the authenticated device's orgId.
   */
  getSettings: (orgId: string) => Promise<{ contentEnabled: boolean }>;
  audit: WorkspaceAudit;
  log: ExtensionLog;
}

// What this phase actually ships; the Helper hides its Files view when this
// endpoint is absent (404) and keys per-feature affordances off this list.
const HELPER_FEATURES = ['search', 'browse', 'recents', 'open'] as const;

const searchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  sourceId: z.uuid().optional(),
  ext: z.string().min(1).max(100).optional(),
  modifiedAfter: z.iso.datetime().optional(),
  modifiedBefore: z.iso.datetime().optional(),
  project: z.string().min(1).max(200).optional(),
  docType: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().optional(),
});
const browseQuerySchema = z.object({
  // uuid-ness is checked separately so a malformed id is the contract 404
  // (unknown-or-hidden source), mirroring the agent routes' 22P02 guard.
  sourceId: z.string().min(1),
  parentPath: z.string().max(4096).default(''),
  // Same optional shape as searchQuerySchema's project/docType — see the
  // Architecture note authorizing these two params on browse as well.
  project: z.string().min(1).max(200).optional(),
  docType: z.string().min(1).max(200).optional(),
});
const passagesQuerySchema = z.object({
  q: z.string().min(1).max(200),
  fileIndexId: z.string().min(1).optional(),
  limit: z.coerce.number().int().optional(),
});
const recentsQuerySchema = z.object({
  helperUser: z.string().max(100).optional(),
});
const activitySchema = z.object({
  fileIndexId: z.string(),
  action: z.enum(['open', 'reveal', 'copy_path']),
  helperUser: z.string().max(100).optional(),
}).strict();

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createHelperRoutes(deps: HelperRouteDeps): Hono<WorkspaceHelperRouteEnv> {
  const app = new Hono<WorkspaceHelperRouteEnv>();

  // Audit transport failures must not change a request's outcome, but they
  // must never be invisible either (same rule as the agent routes).
  async function guardedAudit(
    event: ExtensionAuditEvent,
    context: string,
  ): Promise<void> {
    try {
      await deps.audit(event);
    } catch (error) {
      deps.log('error', `workspace helper audit write failed (${context}): ${errorDetail(error)}`);
    }
  }

  // Fail closed on missing helper identity, explicitly and in one place. The
  // host gateway applies core helper auth on /helper/* (legacy-manifest
  // helperRoutes flag) and every handler below dereferences
  // c.get('helperDevice') unconditionally — without this guard a missing
  // identity would only fail incidentally, as a TypeError surfacing through
  // onError as a 500, instead of the status that names the condition.
  app.use('*', async (c, next) => {
    if (!c.get('helperDevice')) {
      deps.log('warn', `workspace helper request without identity ${c.req.method} ${c.req.path}`);
      return c.json({ error: 'helper identity required' }, 401);
    }
    await next();
  });

  app.get('/capabilities', (c) => c.json({ ok: true, features: [...HELPER_FEATURES] }));

  app.get('/sources', async (c) => {
    const device = c.get('helperDevice');
    // groupIds [] — helper auth carries no Entra group claims yet, so every
    // read fails closed to ungrouped sources (see visibility.ts).
    const sources = await deps.fileQueryService.visibleSources(device.orgId, []);
    // rootPath stays server-side; the wire shape is id/displayName/kind only.
    return c.json({
      sources: sources.map(({ id, displayName, kind }) => ({ id, displayName, kind })),
    });
  });

  app.get('/search', async (c) => {
    const parsed = searchQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: 'invalid request' }, 400);
    const device = c.get('helperDevice');
    if (deps.contentSearchService && (await deps.getSettings(device.orgId)).contentEnabled) {
      const results = await deps.contentSearchService.search(device.orgId, device.id, parsed.data, []);
      return c.json({ results });
    }
    const results = await deps.fileQueryService.search(device.orgId, device.id, parsed.data, []);
    return c.json({ results });
  });

  // Content capability probe: the Helper shows content affordances
  // (snippets, inferred metadata, filing) only when this answers 200. With
  // content disabled for the org it 404s — existing endpoint shapes never
  // change based on the flag.
  app.get('/content/capabilities', async (c) => {
    const device = c.get('helperDevice');
    if (!deps.contentSearchService || !(await deps.getSettings(device.orgId)).contentEnabled) {
      return c.json({ error: 'not found' }, 404);
    }
    const features = ['contentSearch'];
    if (deps.filingService) features.push('filing', 'projects');
    return c.json({ enabled: true, features });
  });

  // Cited-RAG retrieval: visibility-scoped content passages for the chat
  // file-passages tool. 404s under the same gate as the rest of the
  // /content/* surface (the caller org's content setting).
  app.get('/content/passages', async (c) => {
    const device = c.get('helperDevice');
    if (!deps.contentSearchService?.passages || !(await deps.getSettings(device.orgId)).contentEnabled) {
      return c.json({ error: 'not found' }, 404);
    }
    const parsed = passagesQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: 'invalid request' }, 400);
    // A malformed fileIndexId is the contract 404 (unknown-or-hidden file),
    // mirroring the browse/activity 22P02 guard — never a 500.
    if (parsed.data.fileIndexId !== undefined
        && !z.uuid().safeParse(parsed.data.fileIndexId).success) {
      return c.json({ error: 'not found' }, 404);
    }
    const passages = await deps.contentSearchService.passages(device.orgId, parsed.data.q, {
      helperDeviceId: device.id,
      ...(parsed.data.fileIndexId !== undefined ? { fileIndexId: parsed.data.fileIndexId } : {}),
      ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
    }, []);
    return c.json({ passages });
  });

  // ---- Filing panel -------------------------------------------------------
  // Per-org gate: filing is available only when a filing service is wired AND
  // content is enabled for the caller's org (W2 Task 3).
  const filingAvailable = async (orgId: string) =>
    Boolean(deps.filingService) && (await deps.getSettings(orgId)).contentEnabled;

  app.get('/filing', async (c) => {
    const device = c.get('helperDevice');
    if (!(await filingAvailable(device.orgId))) return c.json({ error: 'not found' }, 404);
    return c.json({ filings: await deps.filingService!.list(device.orgId, []) });
  });

  app.get('/content/projects', async (c) => {
    const device = c.get('helperDevice');
    if (!(await filingAvailable(device.orgId))) return c.json({ error: 'not found' }, 404);
    return c.json({ projects: await deps.filingService!.projects(device.orgId) });
  });

  const classifySchema = z.object({ fileIndexId: z.string() }).strict();
  app.post('/filing/classify', async (c) => {
    const device = c.get('helperDevice');
    if (!(await filingAvailable(device.orgId))) return c.json({ error: 'not found' }, 404);
    const parsed = classifySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: 'invalid request' }, 400);
    if (!z.uuid().safeParse(parsed.data.fileIndexId).success) {
      return c.json({ error: 'not found' }, 404);
    }
    const filing = await deps.filingService!.classify(device.orgId, parsed.data.fileIndexId, []);
    if (!filing) return c.json({ error: 'not found' }, 404);
    await guardedAudit({
      orgId: device.orgId,
      actorType: 'agent',
      actorId: device.id,
      action: 'workspace.filing.classify',
      resourceType: 'workspace_file',
      resourceId: parsed.data.fileIndexId,
      details: {
        suggestedProjectKey: filing.suggestedProjectKey,
        confidence: filing.confidence,
      },
      result: 'success',
    }, `filing classify file=${parsed.data.fileIndexId}`);
    return c.json({ filing });
  });

  const assignSchema = z.object({
    projectKey: z.string().min(1).max(40),
    helperUser: z.string().max(100).optional(),
  }).strict();
  app.post('/filing/:fileIndexId/assign', async (c) => {
    const device = c.get('helperDevice');
    if (!(await filingAvailable(device.orgId))) return c.json({ error: 'not found' }, 404);
    const fileIndexId = c.req.param('fileIndexId');
    if (!z.uuid().safeParse(fileIndexId).success) return c.json({ error: 'not found' }, 404);
    const parsed = assignSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: 'invalid request' }, 400);
    const filing = await deps.filingService!.assign(
      device.orgId, fileIndexId, parsed.data.projectKey, parsed.data.helperUser ?? null, [],
    );
    if (!filing) return c.json({ error: 'not found' }, 404);
    await guardedAudit({
      orgId: device.orgId,
      actorType: 'agent',
      actorId: device.id,
      action: 'workspace.filing.assign',
      resourceType: 'workspace_file',
      resourceId: fileIndexId,
      details: { projectKey: parsed.data.projectKey, helperUser: parsed.data.helperUser ?? null },
      result: 'success',
    }, `filing assign file=${fileIndexId}`);
    return c.json({ filing });
  });

  app.get('/browse', async (c) => {
    const parsed = browseQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: 'invalid request' }, 400);
    if (!z.uuid().safeParse(parsed.data.sourceId).success) {
      return c.json({ error: 'not found' }, 404);
    }
    const device = c.get('helperDevice');
    // An unknown or hidden source must be indistinguishable: both 404 before
    // the file index is touched (visibility fails closed).
    const visible = await deps.fileQueryService.visibleSources(device.orgId, []);
    if (!visible.some((source) => source.id === parsed.data.sourceId)) {
      return c.json({ error: 'not found' }, 404);
    }
    const entries = await deps.fileQueryService.browse(
      device.orgId,
      device.id,
      parsed.data.sourceId,
      parsed.data.parentPath,
      { project: parsed.data.project, docType: parsed.data.docType },
      [],
    );
    return c.json({ entries });
  });

  app.get('/recents', async (c) => {
    const parsed = recentsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: 'invalid request' }, 400);
    const device = c.get('helperDevice');
    const helperUser = parsed.data.helperUser ?? null;
    const [recent, department] = await Promise.all([
      deps.activityService.recents(device.orgId, device.id, helperUser, undefined, []),
      deps.activityService.departmentRecent(device.orgId, device.id, undefined, []),
    ]);
    return c.json({ recent, department });
  });

  app.post('/activity', async (c) => {
    const parsed = activitySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: 'invalid request' }, 400);
    if (!z.uuid().safeParse(parsed.data.fileIndexId).success) {
      return c.json({ error: 'not found' }, 404);
    }
    const device = c.get('helperDevice');
    const helperUser = parsed.data.helperUser ?? null;
    const result = await deps.activityService.record(device.orgId, {
      fileIndexId: parsed.data.fileIndexId,
      deviceId: device.id,
      helperUser,
      action: parsed.data.action,
    }, []);
    // notFound covers unknown, tombstoned, AND hidden-source files — the
    // activity API must never confirm a file outside the caller's view.
    if ('notFound' in result) return c.json({ error: 'not found' }, 404);
    await guardedAudit({
      orgId: device.orgId,
      actorType: 'agent',
      actorId: device.id,
      action: `workspace.file.${parsed.data.action}`,
      resourceType: 'workspace_file',
      resourceId: parsed.data.fileIndexId,
      details: { helperUser, fileIndexId: parsed.data.fileIndexId },
      result: 'success',
    }, `activity file=${parsed.data.fileIndexId}`);
    return c.json({ recorded: true }, 201);
  });

  return app;
}
