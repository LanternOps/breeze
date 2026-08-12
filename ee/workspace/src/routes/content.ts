// Admin content routes (dev-preview). EVERYTHING here except /content/settings
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
import { getOrgSettings, putOrgSettings, type DlpConfig } from '../services/orgSettingsService';
import { adminGate, type WorkspaceRouteEnv } from './adminGate';

export interface ContentRouteDeps {
  contentIngestService: Pick<ReturnType<typeof createContentIngestService>, 'run' | 'status'>;
  /** Absent when ANTHROPIC_API_KEY is not configured → enrich-run answers 503. */
  enrichmentService?: Pick<ReturnType<typeof createEnrichmentService>, 'run'>;
  crosswalkService?: Pick<ReturnType<typeof createCrosswalkService>, 'run'>;
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

export function createContentRoutes(deps: ContentRouteDeps): Hono<WorkspaceRouteEnv> {
  const routes = new Hono<WorkspaceRouteEnv>();

  // adminGate first so the org is resolved (and unauthenticated probes hit
  // auth) before the per-org content flag is consulted.
  routes.use('/content/*', adminGate);
  routes.use('/content/*', async (c, next) => {
    // /content/settings is the switch that flips contentEnabled — it must stay
    // reachable while content is disabled, so it is exempt from this gate.
    if (c.req.path.endsWith('/content/settings')) return next();
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
    const result = await deps.enrichmentService.run(orgId, parsed.data.batch);
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

  return routes;
}
