import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { WorkspaceDatabase } from '../hostTypes';
import { createContentRoutes, type ContentRouteDeps } from './content';
import type { WorkspaceRouteEnv } from './adminGate';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_B = '99999999-9999-4999-8999-999999999999';

/** Extract bound literals from a drizzle condition (mirrors credentialService.test.ts). */
function boundValues(value: unknown): unknown[] {
  if (!value || typeof value !== 'object') return [];
  const candidate = value as { value?: unknown; queryChunks?: unknown[] };
  const own = Object.prototype.hasOwnProperty.call(candidate, 'value') ? [candidate.value] : [];
  return [...own, ...(candidate.queryChunks ?? []).flatMap(boundValues)];
}

/**
 * In-memory drizzle-stub backing getOrgSettings/putOrgSettings, filtered by the
 * orgId bound into the WHERE clause so two orgs can coexist in one process:
 * select(...).from(...).where(eq(orgId)) resolves only that org's row(s);
 * insert(...).values(...).onConflictDoUpdate(...) upserts by orgId so a
 * PUT-then-GET in the same test observes the write.
 */
function fakeSettingsDb(initialRows: Record<string, unknown>[] = []) {
  const rows = [...initialRows];
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async (condition: unknown) => {
          const vals = boundValues(condition);
          return rows.filter((r) => vals.includes(r.orgId));
        }),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((row: Record<string, unknown>) => ({
        onConflictDoUpdate: vi.fn(async ({ set }: { set: Record<string, unknown> }) => {
          const idx = rows.findIndex((r) => r.orgId === row.orgId);
          if (idx === -1) rows.push(row);
          else rows[idx] = { ...rows[idx], ...set };
        }),
      })),
    })),
  };
  return db as unknown as WorkspaceDatabase;
}

/** A settings db with content already enabled for the given orgs. */
function enabledDb(...orgIds: string[]) {
  return fakeSettingsDb(orgIds.map((orgId) => ({ orgId, contentEnabled: true, dlpConfig: {} })));
}

function makeApp(overrides: Partial<ContentRouteDeps> = {}, auth?: object | null) {
  const ingest = {
    run: vi.fn(async () => ({ processed: 2, remaining: 5, errors: [] })),
    status: vi.fn(async () => ({
      eligible: 10, extracted: 3, failed: 1, skippedTooLarge: 0, skippedBinary: 1, pending: 5,
    })),
  };
  const deps: ContentRouteDeps = {
    contentIngestService: ingest as unknown as ContentRouteDeps['contentIngestService'],
    // Default to content-enabled for ORG_ID so the behavior suites exercise the
    // live routes; gating/settings suites pass an explicit db.
    db: enabledDb(ORG_ID),
    audit: vi.fn(async () => {}),
    log: vi.fn(),
    ...overrides,
  };
  const app = new Hono<WorkspaceRouteEnv>();
  app.use('*', async (c, next) => {
    if (auth !== null) {
      c.set('auth', (auth ?? {
        user: { id: 'admin-1' }, scope: 'partner', accessibleOrgIds: [ORG_ID],
      }) as WorkspaceRouteEnv['Variables']['auth']);
    }
    await next();
  });
  app.route('/', createContentRoutes(deps));
  return { app, ingest, deps };
}

describe('content routes — per-org content flag gating', () => {
  it('404s content routes when content is disabled for the org (auth resolved first)', async () => {
    const { app, ingest } = makeApp({ db: fakeSettingsDb() }); // no row → disabled
    for (const [method, path] of [
      ['POST', `/content/ingest-run?orgId=${ORG_ID}`],
      ['GET', `/content/status?orgId=${ORG_ID}`],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect(ingest.run).not.toHaveBeenCalled();
  });

  // Deliberate observable change (W2 Task 3): the flag gate now runs AFTER
  // adminGate, so an unauthenticated probe hits auth before the feature 404.
  it('rejects an unauthenticated probe at the admin gate, before the feature check', async () => {
    const { app, ingest } = makeApp({ db: fakeSettingsDb() }, null); // no auth context at all
    const res = await app.request(`/content/status?orgId=${ORG_ID}`);
    expect(res.status).toBe(403);
    expect(ingest.status).not.toHaveBeenCalled();
  });

  it('serves routes when content is enabled for the org', async () => {
    const { app } = makeApp({ db: enabledDb(ORG_ID) });
    const res = await app.request(`/content/status?orgId=${ORG_ID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pending: 5, extracted: 3 });
  });

  // The per-org property the env var could never express: enabled for A,
  // disabled for B, one process, one db.
  it('gates per org in the same process: A enabled → 200, B disabled → 404', async () => {
    const { app, ingest } = makeApp({ db: enabledDb(ORG_ID) }, {
      user: { id: 'admin-1' }, scope: 'system', accessibleOrgIds: null,
    });
    const a = await app.request(`/content/status?orgId=${ORG_ID}`);
    expect(a.status).toBe(200);
    const b = await app.request(`/content/status?orgId=${ORG_B}`);
    expect(b.status).toBe(404);
    expect(ingest.status).toHaveBeenCalledTimes(1);
    expect(ingest.status).toHaveBeenCalledWith(ORG_ID);
  });
});

describe('content routes — behavior (content enabled)', () => {
  it('requires admin scope', async () => {
    const { app } = makeApp({}, {
      user: { id: 'u1' }, scope: 'organization', orgId: ORG_ID, accessibleOrgIds: [ORG_ID],
    });
    const res = await app.request(`/content/ingest-run?orgId=${ORG_ID}`, { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('requires orgId', async () => {
    const { app } = makeApp();
    const res = await app.request('/content/status');
    expect(res.status).toBe(400);
  });

  it('runs an ingest batch and audits the run', async () => {
    const { app, ingest, deps } = makeApp();
    const res = await app.request(`/content/ingest-run?orgId=${ORG_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batch: 25 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ processed: 2, remaining: 5, errors: [] });
    expect(ingest.run).toHaveBeenCalledWith(ORG_ID, 25);
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'workspace.content.ingest_run',
      orgId: ORG_ID,
      result: 'success',
    }));
  });

  it('defaults the batch size and rejects out-of-range/unknown fields', async () => {
    const { app, ingest } = makeApp();
    const ok = await app.request(`/content/ingest-run?orgId=${ORG_ID}`, { method: 'POST' });
    expect(ok.status).toBe(200);
    expect(ingest.run).toHaveBeenCalledWith(ORG_ID, 10);

    const bad = await app.request(`/content/ingest-run?orgId=${ORG_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batch: 1000 }),
    });
    expect(bad.status).toBe(400);

    const unknown = await app.request(`/content/ingest-run?orgId=${ORG_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batch: 5, nope: true }),
    });
    expect(unknown.status).toBe(400);
  });

  it('enrich-run answers 503 when no enrichment service is configured', async () => {
    const { app } = makeApp();
    const res = await app.request(`/content/enrich-run?orgId=${ORG_ID}`, { method: 'POST' });
    expect(res.status).toBe(503);
  });

  it('enrich-run drives the enrichment service and audits', async () => {
    const enrichment = { run: vi.fn(async () => ({ processed: 3, remaining: 1, errors: [] })) };
    const { app, deps } = makeApp({
      enrichmentService: enrichment as unknown as ContentRouteDeps['enrichmentService'],
    });
    const res = await app.request(`/content/enrich-run?orgId=${ORG_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batch: 3 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ processed: 3, remaining: 1, errors: [] });
    expect(enrichment.run).toHaveBeenCalledWith(ORG_ID, 3);
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'workspace.content.enrich_run',
    }));
  });

  it('reports per-file errors in the response body', async () => {
    const { app } = makeApp({
      contentIngestService: {
        run: vi.fn(async () => ({
          processed: 1, remaining: 0,
          errors: [{ fileIndexId: 'f1', relPath: 'a/b.md', error: 'smb read failed' }],
        })),
        status: vi.fn(),
      } as unknown as ContentRouteDeps['contentIngestService'],
    });
    const res = await app.request(`/content/ingest-run?orgId=${ORG_ID}`, { method: 'POST' });
    const body = await res.json();
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].relPath).toBe('a/b.md');
  });
});

describe('content routes — settings (exempt from the content flag gate)', () => {
  it('GET returns defaults for an un-provisioned org even while content is disabled', async () => {
    const { app } = makeApp({ db: fakeSettingsDb() });
    const res = await app.request(`/content/settings?orgId=${ORG_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contentEnabled).toBe(false);
    expect(body.dlpConfig.detectors.ssn).toBe('redact');
    expect(body.dlpConfig.customPatterns).toEqual([]);
  });

  it('PUT flips contentEnabled and round-trips through GET', async () => {
    const db = fakeSettingsDb();
    const { app } = makeApp({ db });

    const putRes = await app.request(`/content/settings?orgId=${ORG_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contentEnabled: true }),
    });
    expect(putRes.status).toBe(200);
    expect((await putRes.json()).contentEnabled).toBe(true);

    const getRes = await app.request(`/content/settings?orgId=${ORG_ID}`);
    expect((await getRes.json()).contentEnabled).toBe(true);
  });

  it('normalizes an invalid detector action to the safe default', async () => {
    const { app } = makeApp({ db: fakeSettingsDb() });
    const res = await app.request(`/content/settings?orgId=${ORG_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dlpConfig: { detectors: { ssn: 'nonsense' } } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dlpConfig.detectors.ssn).toBe('redact');
  });

  it('rejects unknown top-level keys', async () => {
    const { app } = makeApp({ db: fakeSettingsDb() });
    const res = await app.request(`/content/settings?orgId=${ORG_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contentEnabled: true, nope: true }),
    });
    expect(res.status).toBe(400);
  });

  it('requires admin scope, same as the other content routes', async () => {
    const { app } = makeApp({ db: fakeSettingsDb() }, {
      user: { id: 'u1' }, scope: 'organization', orgId: ORG_ID, accessibleOrgIds: [ORG_ID],
    });
    const res = await app.request(`/content/settings?orgId=${ORG_ID}`);
    expect(res.status).toBe(403);
  });

  it('audits the settings update', async () => {
    const { app, deps } = makeApp({ db: fakeSettingsDb() });
    await app.request(`/content/settings?orgId=${ORG_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contentEnabled: true }),
    });
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'workspace.content.settings_update',
      orgId: ORG_ID,
      result: 'success',
    }));
  });
});
