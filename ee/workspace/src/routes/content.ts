// Admin content routes. EVERYTHING here except /content/settings
// 404s when content is disabled for the org — but only after adminGate has
// resolved the org, so an unauthenticated probe hits auth first. /content/settings
// is the switch itself and must work while content is disabled.
// DLP runs at ingest, between extraction and persistence; see contentIngestService.
import type { ExtensionLog, WorkspaceAudit, WorkspaceDatabase } from '../hostTypes';
import { Hono } from 'hono';
import { z } from 'zod';
import type { createContentIngestService } from '../services/contentIngestService';
import type { createCrosswalkService } from '../services/crosswalkService';
import type { createEnrichmentService } from '../services/enrichmentService';
import type { createIngestJobsService } from '../services/ingestJobsService';
import type { createIngestJobRunner } from '../services/ingestJobRunner';
import { getOrgSettings, putOrgSettings, type DlpConfig } from '../services/orgSettingsService';
import { isTransientIngestError } from '../services/ingestErrors';
import { adminGate, type WorkspaceRouteEnv } from './adminGate';

// Paths exempt from the content-enabled 404 gate below: the settings switch
// itself, and (W3) the admin job API — job visibility (and the ability to
// trigger/advance a job) must survive content-off, same rationale as
// /content/settings.
const CONTENT_FLAG_GATE_EXEMPT_SUFFIXES = ['/content/settings', '/content/jobs', '/content/jobs/advance'];

export interface ContentRouteDeps {
  contentIngestService: Pick<ReturnType<typeof createContentIngestService>, 'run' | 'status'>;
  /** Absent when ANTHROPIC_API_KEY is not configured → enrich-run answers 503. */
  enrichmentService?: Pick<ReturnType<typeof createEnrichmentService>, 'run'>;
  crosswalkService?: Pick<ReturnType<typeof createCrosswalkService>, 'run'>;
  // W3: the admin job API's create/list surface — advancement lives on ingestRunner.
  ingestJobs: Pick<ReturnType<typeof createIngestJobsService>, 'ensureJob' | 'list'>;
  ingestRunner: Pick<ReturnType<typeof createIngestJobRunner>, 'advance'>;
  /** Backs the org settings routes (getOrgSettings/putOrgSettings). */
  db: WorkspaceDatabase;
  audit: WorkspaceAudit;
  log: ExtensionLog;
}

const ingestRunSchema = z.strictObject({
  batch: z.number().int().min(1).max(100).default(10),
});

// Detector actions and custom-pattern actions are accepted as plain strings
// here — orgSettingsService.normalizeDlp is the one place that validates
// them against the known DlpAction set and collapses anything unrecognized
// (e.g. a typo'd action) to the safe per-detector default. This schema only
// enforces shape and rejects unknown keys.
const putSettingsSchema = z.strictObject({
  contentEnabled: z.boolean().optional(),
  dlpConfig: z.strictObject({
    detectors: z.record(z.string(), z.string()).optional(),
    customPatterns: z.array(z.strictObject({
      name: z.string(),
      pattern: z.string(),
      action: z.string(),
    })).optional(),
  }).optional(),
});

// W3 admin job API request shapes.
const createJobSchema = z.strictObject({
  sourceId: z.uuid().optional(),
  force: z.boolean().optional(),
});
const advanceJobSchema = z.strictObject({
  budgetMs: z.number().int().min(1).max(15_000).optional(),
  batch: z.number().int().min(1).max(32).optional(),
});

export function createContentRoutes(deps: ContentRouteDeps): Hono<WorkspaceRouteEnv> {
  const routes = new Hono<WorkspaceRouteEnv>();

  // adminGate first so the org is resolved (and unauthenticated probes hit
  // auth) before the per-org content flag is consulted.
  routes.use('/content/*', adminGate);
  routes.use('/content/*', async (c, next) => {
    // /content/settings is the switch that flips contentEnabled, and (W3) the
    // admin job endpoints must stay reachable so job visibility/triggering
    // survives content-off — both are exempt from this gate.
    if (CONTENT_FLAG_GATE_EXEMPT_SUFFIXES.some((suffix) => c.req.path.endsWith(suffix))) return next();
    const s = await getOrgSettings(deps.db, c.get('workspaceOrgId'));
    if (!s.contentEnabled) return c.json({ error: 'not_found' }, 404);
    await next();
  });

  routes.post('/content/ingest-run', async (c) => {
    const orgId = c.get('workspaceOrgId');
    const auth = c.get('auth');
    let body: unknown = {};
    try {
      const raw = await c.req.text();
      body = raw.trim().length > 0 ? JSON.parse(raw) : {};
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const parsed = ingestRunSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid request', details: parsed.error.issues }, 400);
    }
    try {
      const result = await deps.contentIngestService.run(orgId, parsed.data.batch);
      await deps.audit({
        actorType: 'user',
        actorId: auth.user.id,
        orgId,
        action: 'workspace.content.ingest_run',
        resourceType: 'workspace_source',
        result: 'success',
        details: {
          processed: result.processed,
          remaining: result.remaining,
          errorCount: result.errors.length,
        },
      });
      return c.json(result);
    } catch (error) {
      await deps.audit({
        actorType: 'user',
        actorId: auth.user.id,
        orgId,
        action: 'workspace.content.ingest_run',
        resourceType: 'workspace_source',
        result: 'failure',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });

  routes.get('/content/status', async (c) => {
    const orgId = c.get('workspaceOrgId');
    return c.json(await deps.contentIngestService.status(orgId));
  });

  routes.post('/content/enrich-run', async (c) => {
    if (!deps.enrichmentService) {
      return c.json({ error: 'enrichment unavailable (no model credentials configured)' }, 503);
    }
    const orgId = c.get('workspaceOrgId');
    const auth = c.get('auth');
    let body: unknown = {};
    try {
      const raw = await c.req.text();
      body = raw.trim().length > 0 ? JSON.parse(raw) : {};
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const parsed = ingestRunSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid request', details: parsed.error.issues }, 400);
    }
    // Task 4 made classifyOne rethrow Anthropic 429/>=500 as a
    // TransientIngestError; surface that as a retryable 503 rather than letting
    // app.onError turn a provider rate cap into an opaque 500. Non-transient
    // failures still propagate to the 500 path.
    let result;
    try {
      result = await deps.enrichmentService.run(orgId, parsed.data.batch);
    } catch (e) {
      if (isTransientIngestError(e)) {
        return c.json({ error: 'enrichment provider unavailable or rate limited; retry later' }, 503);
      }
      throw e;
    }
    if (result.aiUnavailable) {
      // The run degraded on a permanent AI failure — no provider on this
      // deployment (no platform key, no partner BYOK key), AI switched off for
      // the org, a partner plan without AI, or an unpriced model id. The
      // ingest pipeline treats that as a drained phase, but a caller who
      // explicitly asked to enrich gets the same 503 the pre-BYOK
      // missing-credentials guard returned above — and, like ingest-run's
      // failure path, an audit row: an admin action that produced nothing must
      // still leave a trail, not vanish.
      await deps.audit({
        actorType: 'user',
        actorId: auth.user.id,
        orgId,
        action: 'workspace.content.enrich_run',
        resourceType: 'workspace_source',
        result: 'failure',
        errorMessage: 'enrichment unavailable (no usable AI provider for this organization)',
      });
      return c.json({ error: 'enrichment unavailable (no model credentials configured)' }, 503);
    }
    await deps.audit({
      actorType: 'user',
      actorId: auth.user.id,
      orgId,
      action: 'workspace.content.enrich_run',
      resourceType: 'workspace_source',
      result: 'success',
      details: {
        processed: result.processed,
        remaining: result.remaining,
        errorCount: result.errors.length,
      },
    });
    return c.json(result);
  });

  routes.get('/content/settings', async (c) => {
    const orgId = c.get('workspaceOrgId');
    const settings = await getOrgSettings(deps.db, orgId);
    return c.json(settings);
  });

  routes.put('/content/settings', async (c) => {
    const orgId = c.get('workspaceOrgId');
    const auth = c.get('auth');
    let body: unknown = {};
    try {
      const raw = await c.req.text();
      body = raw.trim().length > 0 ? JSON.parse(raw) : {};
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const parsed = putSettingsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid request', details: parsed.error.issues }, 400);
    }
    const settings = await putOrgSettings(deps.db, orgId, {
      ...(parsed.data.contentEnabled !== undefined ? { contentEnabled: parsed.data.contentEnabled } : {}),
      // Cast: the schema above validates shape only, not detector/action
      // enum membership — putOrgSettings's normalizeDlp is the source of
      // truth for that and safely defaults anything invalid.
      ...(parsed.data.dlpConfig !== undefined
        ? { dlpConfig: parsed.data.dlpConfig as unknown as DlpConfig }
        : {}),
    });
    await deps.audit({
      actorType: 'user',
      actorId: auth.user.id,
      orgId,
      action: 'workspace.content.settings_update',
      resourceType: 'workspace_org_settings',
      result: 'success',
      details: { contentEnabled: settings.contentEnabled },
    });
    return c.json(settings);
  });

  routes.post('/content/crosswalk-run', async (c) => {
    if (!deps.crosswalkService) return c.json({ error: 'crosswalk unavailable' }, 503);
    const orgId = c.get('workspaceOrgId');
    const auth = c.get('auth');
    const result = await deps.crosswalkService.run(orgId);
    await deps.audit({
      actorType: 'user',
      actorId: auth.user.id,
      orgId,
      action: 'workspace.content.crosswalk_run',
      resourceType: 'workspace_source',
      result: 'success',
      details: { mined: result.mined },
    });
    return c.json(result);
  });

  // W3 admin job API: org-operator scope (adminGate above already enforces
  // partner/system scope), all active sources — NO groupIds/visibility
  // filtering. Exempt from the content-enabled gate above (job visibility
  // must survive content-off).
  routes.post('/content/jobs', async (c) => {
    const orgId = c.get('workspaceOrgId');
    let body: unknown = {};
    try {
      const raw = await c.req.text();
      body = raw.trim().length > 0 ? JSON.parse(raw) : {};
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const parsed = createJobSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid request', details: parsed.error.issues }, 400);
    }
    const force = parsed.data.force ?? false;
    const { job, created } = await deps.ingestJobs.ensureJob(orgId, {
      sourceId: parsed.data.sourceId,
      crawlRunId: undefined,
      trigger: force ? 'reingest' : 'manual',
      force,
    });
    return c.json({ job, created });
  });

  routes.post('/content/jobs/advance', async (c) => {
    const orgId = c.get('workspaceOrgId');
    let body: unknown = {};
    try {
      const raw = await c.req.text();
      body = raw.trim().length > 0 ? JSON.parse(raw) : {};
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const parsed = advanceJobSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid request', details: parsed.error.issues }, 400);
    }
    const result = await deps.ingestRunner.advance(orgId, {
      budgetMs: parsed.data.budgetMs,
      batch: parsed.data.batch,
    });
    return c.json(result);
  });

  routes.get('/content/jobs', async (c) => {
    const orgId = c.get('workspaceOrgId');
    const rawLimit = c.req.query('limit');
    const limit = rawLimit !== undefined && Number.isFinite(Number(rawLimit))
      ? Number(rawLimit)
      : undefined;
    const jobs = await deps.ingestJobs.list(orgId, limit);
    return c.json({ jobs });
  });

  return routes;
}
