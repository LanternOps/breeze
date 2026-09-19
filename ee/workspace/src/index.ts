import { Hono } from 'hono';
import {
  asWorkspaceDatabase,
  type BreezeExtensionV1,
  type ExtensionAiContext,
  type WorkspaceDatabase,
} from './hostTypes';
import { createAgentRoutes } from './routes/agent';
import { createContentRoutes } from './routes/content';
import { createDashboardRoutes } from './routes/dashboard';
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
import { createDashboardService } from './services/dashboardService';
import { createEnrichmentService } from './services/enrichmentService';
import { createFilingService } from './services/filingService';
import { createCrawlRunsService } from './services/crawlRunsService';
import { createCredentialService } from './services/credentialService';
import { createDeviceSummaryService } from './services/deviceSummaryService';
import { createFileQueryService } from './services/fileQueryService';
import { createIngestJobsService } from './services/ingestJobsService';
import { createIngestJobRunner, type EnrichRunResult } from './services/ingestJobRunner';
import { createSourcesService } from './services/sourcesService';
import { getOrgSettings } from './services/orgSettingsService';

/**
 * Enrichment needs the host's metered `context.ai` capability; construct only
 * when the host provides one. Absent capability (older host) → routes answer
 * 503 rather than crashing registration — same no-op shape as the pre-BYOK
 * missing-ANTHROPIC_API_KEY case this replaces. The host resolves BYOK vs
 * platform key, meters, and records usage; the extension never sees a key.
 */
function buildEnrichmentService(
  db: WorkspaceDatabase,
  ai: ExtensionAiContext | undefined,
): ReturnType<typeof createEnrichmentService> | undefined {
  if (!ai) return undefined;
  return createEnrichmentService(db, { invoke: ai.invoke });
}

const workspaceExtension: BreezeExtensionV1 = {
  register(registrar, context) {
    const app = new Hono();
    // The host supplies the org-scoped (RLS-enforcing) Drizzle connection; the
    // narrowing lives in hostTypes.ts so no service carries its own cast.
    const db = asWorkspaceDatabase(context.db);
    // Per-org content flag (W2 Task 3): the single switch for the content
    // layer, replacing the process-wide WORKSPACE_CONTENT_PREVIEW env var.
    // Content is enabled iff getOrgSettings(orgId).contentEnabled.
    const getSettings = (orgId: string) => getOrgSettings(db, orgId);
    const sourcesService = createSourcesService(db);
    const credentialService = createCredentialService(db, context.secrets, getSettings);
    const crosswalkService = createCrosswalkService(db);
    const filingService = createFilingService(db, { crosswalkService });

    // W3: productized ingest. contentIngestService/enrichmentService are
    // constructed once here (rather than inline at createContentRoutes' call
    // site) so the SAME instances back both the admin content routes and the
    // in-request runner the agent poke and the admin advance endpoint share.
    // No background worker/queue/scheduler anywhere in this file — advance()
    // only ever runs inside an authenticated request.
    const contentIngestService = createContentIngestService(db, {
      reader: buildContentReader(
        (orgId, sourceId) => credentialService.decryptForContentIngest(orgId, sourceId),
      ),
      maxBytes: process.env.WORKSPACE_CONTENT_MAX_BYTES
        ? Number(process.env.WORKSPACE_CONTENT_MAX_BYTES)
        : undefined,
      // Embedder-absent (no VOYAGE_API_KEY) is a normal deploy shape:
      // contentIngestService.run skips the embed call and the runner drives
      // the ingest phase exactly the same either way.
      embedder: buildEmbedder(),
    });
    const enrichmentService = buildEnrichmentService(db, context.ai);
    // Enrichment-absent (no context.ai capability) must still let the runner
    // construct and drive a job through: this no-op stand-in reports the
    // enrich phase already drained, so the pipeline advances straight to
    // crosswalk instead of the runner failing to construct at all. The admin
    // /content/enrich-run route (content.ts) still answers 503 directly, so a
    // caller asking for enrichment explicitly gets an honest error — this
    // stand-in only governs the automatic in-request advancement path.
    const enrichmentForRunner = enrichmentService ?? {
      run: async (): Promise<EnrichRunResult> => ({ processed: 0, remaining: 0, errors: [] }),
    };
    const ingestJobsService = createIngestJobsService(db);
    const ingestRunner = createIngestJobRunner({
      jobs: ingestJobsService,
      contentIngest: contentIngestService,
      enrichment: enrichmentForRunner,
      crosswalk: crosswalkService,
      getSettings,
      log: (msg) => context.log('warn', `workspace ingest runner: ${msg}`),
    });

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
      ingestJobs: ingestJobsService,
      ingestRunner,
      getSettings,
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

    // W4: the Outlook add-in's end-user surface — DELIBERATELY NOT MOUNTED HERE.
    //
    // Upstream (LanternOps/breeze-workspace) mounted `/client/*` at this point,
    // because there it was only ever reachable through core's generic client-ai
    // proxy: that proxy dispatches under its own `/api/v1/client-ai/ext/:extension/*`
    // mount with a synthesized organization-scoped context, and clientGate
    // (inside createClientRoutes) admits exactly that shape.
    //
    // That proxy does not exist in this repo yet — it is unmerged, on
    // ToddHebebrand/client-ext-seam-w4. Mounting `/client` here anyway would
    // NOT reach it; the extension gateway would route `/client/*` down its
    // default arm, i.e. an ordinary browser session JWT. clientGate checks the
    // SHAPE of the auth context, not its provenance, so any organization-scoped
    // Breeze user would satisfy it — and `/client/*` would become the only
    // Workspace surface an org-scoped user can reach at all, since adminGate
    // rejects that scope outright. That is an intra-org authorization gap (mail
    // metadata search, filing decisions overwritable by any org user), so the
    // mount waits for its dispatcher.
    //
    // Everything else about the surface is ported and tested; restoring it means
    // routing createClientRoutes into the app below, and belongs with whichever
    // commits from that branch land the proxy. Note when doing so that the
    // proxy's synthesized context sets no `principal` field, so a provenance
    // check on clientGate cannot key off `principal.kind` as-is.
    //
    // The prefix is still claimed by a bare catch-all, for the same reason the
    // real mount had one: without it, `/client/*` falls through to the
    // admin-gated user routes below and answers their `adminGate` 403 instead,
    // which both leaks that the prefix is unhandled and puts the tree one
    // routing change away from the admin surface.
    const clientApp = new Hono();
    clientApp.all('*', (c) => c.json({ error: 'not found' }, 404));
    app.route('/client', clientApp);

    app.route('/', createSourcesRoutes({
      sourcesService,
      credentialService,
      audit: context.audit,
      // Threaded so audit-write failures are reported rather than silently
      // leaving a hole in the audit trail.
      log: context.log,
    }));
    // Content layer: every route except /content/settings and the admin job
    // endpoints (/content/jobs, /content/jobs/advance) answers
    // 404 {"error":"not_found"} unless the org has contentEnabled set
    // (getOrgSettings), default-deny on a missing row. DLP runs
    // unconditionally at ingest — redact before store, block before embed
    // (see README).
    app.route('/', createContentRoutes({
      contentIngestService,
      enrichmentService,
      crosswalkService,
      ingestJobs: ingestJobsService,
      ingestRunner,
      db,
      audit: context.audit,
      log: context.log,
    }));
    // W3 Task 6: admin dashboard read model. Shares the contentIngestService
    // instance built above (single source of truth for the ingest card, same
    // instance the admin content routes and the in-request runner use).
    app.route('/', createDashboardRoutes({
      dashboardService: createDashboardService(db, {
        contentIngestStatus: (orgId) => contentIngestService.status(orgId),
      }),
      ingestJobs: ingestJobsService,
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
