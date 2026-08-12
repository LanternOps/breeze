import { Hono } from 'hono';
import Anthropic from '@anthropic-ai/sdk';
import { asWorkspaceDatabase, type BreezeExtensionV1, type WorkspaceDatabase } from './hostTypes';
import { createAgentRoutes } from './routes/agent';
import { createContentRoutes } from './routes/content';
import { createDeviceSummaryRoutes } from './routes/deviceSummary';
import { createHelperRoutes } from './routes/helper';
import { createSourcesRoutes } from './routes/sources';
import { buildContentReader } from './content/byteReader';
import { buildEmbedder } from './content/embedder';
import { createActivityService } from './services/activityService';
import { createBatchUpsertService } from './services/batchUpsertService';
import { createContentIngestService } from './services/contentIngestService';
import { createContentSearchService } from './services/contentSearchService';
import { createCrosswalkService } from './services/crosswalkService';
import { createEnrichmentService, type AnthropicLike } from './services/enrichmentService';
import { createFilingService } from './services/filingService';
import { createCrawlRunsService } from './services/crawlRunsService';
import { createCredentialService } from './services/credentialService';
import { createDeviceSummaryService } from './services/deviceSummaryService';
import { createFileQueryService } from './services/fileQueryService';
import { createSourcesService } from './services/sourcesService';
import { getOrgSettings } from './services/orgSettingsService';

/**
 * Enrichment needs an Anthropic key; construct lazily and only when the
 * content preview could ever serve it. Absent key → routes answer 503 rather
 * than crashing registration. Import stays dynamic-free: the SDK reads
 * ANTHROPIC_API_KEY from the environment at construction.
 */
function buildEnrichmentService(
  db: WorkspaceDatabase,
): ReturnType<typeof createEnrichmentService> | undefined {
  if (!process.env.ANTHROPIC_API_KEY) return undefined;
  return createEnrichmentService(db, {
    client: new Anthropic() as unknown as AnthropicLike,
  });
}

const workspaceExtension: BreezeExtensionV1 = {
  register(registrar, context) {
    const app = new Hono();
    // The host supplies the org-scoped (RLS-enforcing) Drizzle connection; the
    // narrowing lives in hostTypes.ts so no service carries its own cast.
    const db = asWorkspaceDatabase(context.db);
    // Per-org content flag (W2 Task 3): the single switch for the content
    // preview surface, replacing the process-wide WORKSPACE_CONTENT_PREVIEW
    // env var. Content is enabled iff getOrgSettings(orgId).contentEnabled.
    const getSettings = (orgId: string) => getOrgSettings(db, orgId);
    const sourcesService = createSourcesService(db);
    const credentialService = createCredentialService(db, context.secrets, getSettings);
    const crosswalkService = createCrosswalkService(db);
    const filingService = createFilingService(db, { crosswalkService });

    // No auth middleware is attached here: the host gateway applies the
    // manifest-declared boundary before dispatch — agent auth on /agent/*,
    // core helper auth on /helper/* (legacy-manifest helperRoutes flag), user
    // auth everywhere else (publicRoutes: []) — and puts the caller identity
    // on the request.
    app.get('/health', (c) => c.json({ ok: true, extension: 'workspace' }));

    // Mount order is load-bearing. Hono composes matching handlers in
    // registration order, so /agent and /helper must be mounted before the
    // user routes: each tree — including its catch-all — has to answer first,
    // or an unmatched /agent/* or /helper/* request would fall through to the
    // admin-gated user routes below.
    const agentApp = new Hono();
    agentApp.route('/', createAgentRoutes({
      sourcesService,
      credentialService,
      crawlRunsService: createCrawlRunsService(db),
      batchUpsertService: createBatchUpsertService(db),
      audit: context.audit,
      log: context.log,
    }));
    // The host gateway authenticates extension agent traffic on
    // /agent/:agentId/... (device identity in the path, mirroring core's
    // /api/v1/agents/:id/* convention), while the phase-2 wire spec — and the
    // Go client's default endpoint base — use flat /agent/... paths. Mount the
    // agent surface under both shapes: the :agentId segment is consumed here
    // purely for routing (identity always comes from c.get('agent'), bound by
    // auth to the token, never from the path).
    //
    // No catch-all INSIDE agentApp: under the dual mount a flat
    // /agent/crawl-config first matches the /agent/:agentId mount (the segment
    // parses as an agent id, inner path '/'), and an inner catch-all would
    // answer 404 there before the flat /agent mount could route it. The
    // catch-alls live on the outer app, after both mounts, so real routes win.
    app.route('/agent/:agentId', agentApp);
    app.route('/agent', agentApp);
    app.all('/agent', (c) => c.json({ error: 'not found' }, 404));
    app.all('/agent/*', (c) => c.json({ error: 'not found' }, 404));

    const helperApp = new Hono();
    helperApp.route('/', createHelperRoutes({
      fileQueryService: createFileQueryService(db),
      activityService: createActivityService(db),
      contentSearchService: createContentSearchService(db, { embedder: buildEmbedder() }),
      filingService,
      getSettings,
      audit: context.audit,
      log: context.log,
    }));
    helperApp.all('*', (c) => c.json({ error: 'not found' }, 404));
    app.route('/helper', helperApp);

    app.route('/', createSourcesRoutes({
      sourcesService,
      credentialService,
      audit: context.audit,
      // Threaded so audit-write failures are reported rather than silently
      // leaving a hole in the audit trail.
      log: context.log,
    }));
    // Content phase (dev-preview): every route except /content/settings 404s
    // unless content is enabled for the org (getOrgSettings). DLP runs at
    // ingest (redact before store, block before embed); never enable in
    // production (see README).
    app.route('/', createContentRoutes({
      contentIngestService: createContentIngestService(db, {
        reader: buildContentReader(
          (orgId, sourceId) => credentialService.decryptForContentIngest(orgId, sourceId),
        ),
        maxBytes: process.env.WORKSPACE_CONTENT_MAX_BYTES
          ? Number(process.env.WORKSPACE_CONTENT_MAX_BYTES)
          : undefined,
        embedder: buildEmbedder(),
      }),
      enrichmentService: buildEnrichmentService(db),
      crosswalkService,
      db,
      audit: context.audit,
      log: context.log,
    }));
    app.route('/', createDeviceSummaryRoutes({
      deviceSummaryService: createDeviceSummaryService(db),
    }));

    // Unhandled service/DB exceptions must come back as the JSON error shape
    // every agent and admin response uses (never Hono's text/plain default),
    // and must leave a log line — a silent text 500 was invisible in
    // production. Hono carries a sub-app's onError through route(), so this
    // handler survives however the host mounts the extension.
    app.onError((error, c) => {
      context.log(
        'error',
        `workspace unhandled error ${c.req.method} ${c.req.path}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
      return c.json({ error: 'internal error' }, 500);
    });

    registrar.mountRoute(app);
    context.log('info', 'workspace extension registered');
  },
};

export default workspaceExtension;
