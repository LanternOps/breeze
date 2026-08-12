import { gzipSync } from 'node:zlib';
import { Hono } from 'hono';
import type { ExtensionAgentContext, ExtensionAuditEvent } from '../hostTypes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentRoutes, type AgentRouteDeps, type WorkspaceAgentRouteEnv } from './agent';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_DEVICE_ID = '55555555-5555-4555-8555-555555555555';
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

const agent: ExtensionAgentContext = {
  deviceId: DEVICE_ID,
  agentId: 'agent-1',
  orgId: ORG_ID,
  siteId: '66666666-6666-4666-8666-666666666666',
  role: 'agent',
};

function source(overrides: Record<string, unknown> = {}) {
  return {
    id: SOURCE_ID,
    orgId: ORG_ID,
    kind: 'smb_share' as const,
    displayName: 'Shared files',
    rootPath: '\\\\server\\share',
    crawlDeviceId: DEVICE_ID,
    visibilityGroupIds: [],
    hasCredential: true,
    excludeGlobs: ['**/.git/**'],
    watch: false,
    crawlCadenceMinutes: 60,
    crawlCursor: {},
    status: 'active' as const,
    statusDetail: null,
    errorReason: null,
    lastCompleteRunAt: new Date('2026-07-12T10:00:00.000Z'),
    createdAt: new Date('2026-07-12T09:00:00.000Z'),
    updatedAt: new Date('2026-07-12T09:00:00.000Z'),
    ...overrides,
  };
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    orgId: ORG_ID,
    sourceId: SOURCE_ID,
    deviceId: null,
    deviceKey: ZERO_UUID,
    status: 'running' as const,
    startedAt: new Date('2026-07-12T10:01:00.000Z'),
    lastActivityAt: new Date('2026-07-12T10:02:00.000Z'),
    completedAt: null,
    cursor: 'folder/one',
    stats: {},
    errorReason: null,
    ...overrides,
  };
}

const entry = {
  relPath: 'folder/report.txt',
  parentPath: 'folder',
  name: 'report.txt',
  isDir: false,
  size: 12,
  mtime: '2026-07-12T10:00:00.000Z',
  ctime: null,
  ext: 'txt',
  attrs: {},
};

function makeHarness(agentValue = agent) {
  const sourcesService = {
    get: vi.fn(async (_orgId: string, id: string) => {
      const row = source();
      return row.id === id ? row : null;
    }),
    listForDevice: vi.fn(async () => [source()]),
  };
  const credentialService = {
    decryptForDevice: vi.fn(async () => ({ username: 'alice', password: 'secret', domain: null })),
  };
  const crawlRunsService = {
    start: vi.fn(async () => ({ run: run() })),
    touch: vi.fn(async () => 1),
    finish: vi.fn(async () => ({ tombstoned: 0 })),
    getActive: vi.fn(async () => run()),
    getById: vi.fn(async () => run()),
  };
  const batchUpsertService = {
    upsertBatch: vi.fn(async (_orgId: string, _sourceId: string, _deviceKey: string, entries: unknown[]) => ({
      inserted: entries.length,
      expected: entries.length,
    })),
    tombstonePaths: vi.fn(async () => 2),
  };
  const audit = vi.fn(async (_event: ExtensionAuditEvent) => {});
  const log = vi.fn();
  const ingestJobs = {
    ensureJob: vi.fn(async () => ({ job: { id: 'job-1' }, created: true })),
  } as unknown as AgentRouteDeps['ingestJobs'] & { ensureJob: ReturnType<typeof vi.fn> };
  const ingestRunner = {
    advance: vi.fn(async () => ({ advanced: false, job: null })),
  } as unknown as AgentRouteDeps['ingestRunner'] & { advance: ReturnType<typeof vi.fn> };
  const getSettings = vi.fn(async () => ({ contentEnabled: true }));
  const app = new Hono<WorkspaceAgentRouteEnv>();
  app.use('*', async (c, next) => {
    c.set('agent', agentValue);
    await next();
  });
  app.route('/', createAgentRoutes({
    sourcesService,
    credentialService,
    crawlRunsService,
    batchUpsertService,
    ingestJobs,
    ingestRunner,
    getSettings,
    audit,
    log,
  }));
  return {
    app,
    sourcesService,
    credentialService,
    crawlRunsService,
    batchUpsertService,
    ingestJobs,
    ingestRunner,
    getSettings,
    audit,
    log,
  };
}

function jsonRequest(body: unknown) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.WORKSPACE_CRAWL_ENABLED;
});

describe('workspace agent routes', () => {
  it('builds crawl config from device-visible sources and active runs', async () => {
    const h = makeHarness();
    const res = await h.app.request('/crawl-config');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: true,
      pollIntervalSeconds: 300,
      limits: { maxBatchBytes: 921600, maxBatchEntries: 2000, walkOpsPerSecond: 200 },
      sources: [{
        id: SOURCE_ID,
        kind: 'smb_share',
        rootPath: '\\\\server\\share',
        cadenceMinutes: 60,
        excludeGlobs: ['**/.git/**'],
        hasCredential: true,
        lastCompleteRunAt: '2026-07-12T10:00:00.000Z',
        activeRun: { runId: RUN_ID, startedAt: '2026-07-12T10:01:00.000Z', cursor: 'folder/one' },
        watch: false,
      }],
    });
    expect(h.sourcesService.listForDevice).toHaveBeenCalledWith(ORG_ID, DEVICE_ID);
    expect(h.crawlRunsService.getActive).toHaveBeenCalledWith(ORG_ID, SOURCE_ID, DEVICE_ID);
  });

  it('honors the kill switch without querying sources', async () => {
    process.env.WORKSPACE_CRAWL_ENABLED = 'false';
    const h = makeHarness();
    const res = await h.app.request('/crawl-config');
    expect(await res.json()).toEqual({ enabled: false, pollIntervalSeconds: 300, sources: [] });
    expect(h.sourcesService.listForDevice).not.toHaveBeenCalled();
  });

  it('audits successful and missing credential fetches and disables caching', async () => {
    const h = makeHarness();
    const success = await h.app.request(`/sources/${SOURCE_ID}/credential`, { method: 'POST' });
    expect(success.status).toBe(200);
    expect(success.headers.get('cache-control')).toBe('no-store');
    expect(await success.json()).toEqual({ username: 'alice', password: 'secret', domain: null });

    h.credentialService.decryptForDevice.mockResolvedValueOnce(null as never);
    const missing = await h.app.request(`/sources/${SOURCE_ID}/credential`, { method: 'POST' });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toBe('no-store');
    expect(h.audit).toHaveBeenNthCalledWith(1, expect.objectContaining({
      orgId: ORG_ID,
      actorType: 'agent',
      actorId: DEVICE_ID,
      action: 'workspace.source.credential.fetch',
      resourceId: SOURCE_ID,
      result: 'success',
    }));
    expect(h.audit).toHaveBeenNthCalledWith(2, expect.objectContaining({ result: 'failure' }));
  });

  it('audits an invalid credential source ID as an indistinguishable 404 without service access', async () => {
    const h = makeHarness();
    const res = await h.app.request('/sources/not-a-uuid/credential', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'not found' });
    expect(h.credentialService.decryptForDevice).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: 'not-a-uuid',
      result: 'failure',
    }));
  });

  it('returns 404 when starting a run for another device SMB source', async () => {
    const h = makeHarness();
    h.sourcesService.listForDevice.mockResolvedValueOnce([]);
    const res = await h.app.request('/runs', jsonRequest({ sourceId: SOURCE_ID }));
    expect(res.status).toBe(404);
    expect(h.crawlRunsService.start).not.toHaveBeenCalled();
  });

  it('validates run creation and maps active-run conflicts to 409', async () => {
    const h = makeHarness();
    const invalid = await h.app.request('/runs', jsonRequest({ sourceId: 'not-a-uuid' }));
    expect(invalid.status).toBe(400);
    h.crawlRunsService.start.mockResolvedValueOnce({ conflict: true } as never);
    const conflict = await h.app.request('/runs', jsonRequest({ sourceId: SOURCE_ID }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: 'run already active' });
  });

  it('logs unexpected run-start failures and returns 500', async () => {
    const h = makeHarness();
    h.crawlRunsService.start.mockRejectedValueOnce(new Error('database unavailable'));
    const res = await h.app.request('/runs', jsonRequest({ sourceId: SOURCE_ID }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'failed to start run' });
    expect(h.log).toHaveBeenCalledWith('error', expect.stringContaining('workspace agent run start failed'));
    expect(h.log).toHaveBeenCalledWith('error', expect.stringContaining(SOURCE_ID));
    expect(h.log).toHaveBeenCalledWith('error', expect.stringContaining('database unavailable'));
  });

  it('keeps typed unassigned/missing run starts indistinguishable as 404', async () => {
    const h = makeHarness();
    const { SourceNotAssignedError, SourceNotFoundError } =
      await import('../services/crawlRunsService');
    h.crawlRunsService.start.mockRejectedValueOnce(new SourceNotAssignedError());
    const unassigned = await h.app.request('/runs', jsonRequest({ sourceId: SOURCE_ID }));
    expect(unassigned.status).toBe(404);
    expect(await unassigned.json()).toEqual({ error: 'not found' });

    h.crawlRunsService.start.mockRejectedValueOnce(new SourceNotFoundError());
    const missing = await h.app.request('/runs', jsonRequest({ sourceId: SOURCE_ID }));
    expect(missing.status).toBe(404);
    expect(h.log).not.toHaveBeenCalled();
  });

  it('gunzips a valid batch, upserts it, and advances the cursor', async () => {
    const h = makeHarness();
    const encoded = gzipSync(JSON.stringify({ cursor: entry.relPath, entries: [entry] }));
    const res = await h.app.request(`/runs/${RUN_ID}/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: encoded,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inserted: 1, expected: 1 });
    expect(h.batchUpsertService.upsertBatch).toHaveBeenCalledWith(ORG_ID, SOURCE_ID, ZERO_UUID, [entry]);
    expect(h.crawlRunsService.touch).toHaveBeenCalledWith(ORG_ID, RUN_ID, entry.relPath, { seen: 1 });
    expect(h.crawlRunsService.getById).toHaveBeenCalledWith(ORG_ID, RUN_ID);
  });

  it('returns 413 when a gzip body expands past the 4 MB decoded cap', async () => {
    const h = makeHarness();
    const encoded = gzipSync('x'.repeat(4 * 1024 * 1024 + 1));
    const res = await h.app.request(`/runs/${RUN_ID}/batch`, {
      method: 'POST',
      headers: { 'content-encoding': 'gzip' },
      body: encoded,
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'batch too large' });
  });

  it('returns 413 for more than 2000 entries and 400 for malformed JSON', async () => {
    const h = makeHarness();
    const oversized = await h.app.request(`/runs/${RUN_ID}/batch`, jsonRequest({
      cursor: 'last',
      entries: Array.from({ length: 2001 }, () => entry),
    }));
    expect(oversized.status).toBe(413);
    const malformed = await h.app.request(`/runs/${RUN_ID}/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(malformed.status).toBe(400);
    expect(h.batchUpsertService.upsertBatch).not.toHaveBeenCalled();
  });

  it('returns 404 for a foreign run and 409 for a visible non-running run', async () => {
    const h = makeHarness();
    h.crawlRunsService.getById.mockResolvedValueOnce(null as never);
    const foreign = await h.app.request(`/runs/${RUN_ID}/batch`, jsonRequest({ cursor: 'last', entries: [] }));
    expect(foreign.status).toBe(404);

    h.crawlRunsService.getById.mockResolvedValueOnce(run({ status: 'failed' }));
    const stopped = await h.app.request(`/runs/${RUN_ID}/batch`, jsonRequest({ cursor: 'last', entries: [] }));
    expect(stopped.status).toBe(409);
  });

  it('returns 409 for an older stopped run on a paused SMB source still assigned to this device', async () => {
    const h = makeHarness();
    h.sourcesService.listForDevice.mockResolvedValueOnce([]);
    h.sourcesService.get.mockResolvedValueOnce(source({ status: 'paused' }));
    h.crawlRunsService.getById.mockResolvedValueOnce(run({ status: 'failed' }));
    const res = await h.app.request(
      `/runs/${RUN_ID}/batch`,
      jsonRequest({ cursor: 'last', entries: [] }),
    );
    expect(res.status).toBe(409);
    expect(h.sourcesService.get).toHaveBeenCalledWith(ORG_ID, SOURCE_ID);
    expect(h.crawlRunsService.getById).toHaveBeenCalledWith(ORG_ID, RUN_ID);
  });

  it('passes complete=false to finish and returns zero tombstones without route-side sweep calls', async () => {
    const h = makeHarness();
    // Wire field is `error` — exactly what the Go agent serializes (json:"error").
    const res = await h.app.request(`/runs/${RUN_ID}/complete`, jsonRequest({
      complete: false,
      stats: { seen: 9, errors: 1 },
      error: 'authenticate: session setup failed',
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tombstoned: 0 });
    expect(h.crawlRunsService.finish).toHaveBeenCalledWith(ORG_ID, RUN_ID, DEVICE_ID, {
      complete: false,
      stats: { seen: 9, errors: 1 },
      errorReason: 'authenticate: session setup failed',
    });
    expect(h.batchUpsertService.tombstonePaths).not.toHaveBeenCalled();
  });

  it('rejects the legacy errorReason wire field (strict schema locks the Go contract)', async () => {
    const h = makeHarness();
    const res = await h.app.request(`/runs/${RUN_ID}/complete`, jsonRequest({
      complete: false,
      errorReason: 'cancelled',
    }));
    expect(res.status).toBe(400);
    expect(h.crawlRunsService.finish).not.toHaveBeenCalled();
  });

  it('returns 404 when finish cannot find a run owned by this device', async () => {
    const h = makeHarness();
    h.crawlRunsService.finish.mockResolvedValueOnce({ notFound: true } as never);
    const res = await h.app.request(`/runs/${RUN_ID}/complete`, jsonRequest({ complete: true }));
    expect(res.status).toBe(404);
  });

  it('returns 404 for an invalid completion run ID without calling finish', async () => {
    const h = makeHarness();
    const res = await h.app.request('/runs/not-a-uuid/complete', jsonRequest({ complete: true }));
    expect(res.status).toBe(404);
    expect(h.crawlRunsService.finish).not.toHaveBeenCalled();
  });

  it('applies local-profile events using the calling device as device key', async () => {
    const h = makeHarness();
    h.sourcesService.listForDevice.mockResolvedValueOnce([source({
      kind: 'local_profile',
      rootPath: '/Users',
      crawlDeviceId: null,
      hasCredential: false,
      watch: true,
    })]);
    const res = await h.app.request(`/sources/${SOURCE_ID}/events`, jsonRequest({
      upserts: [entry],
      deletes: ['folder/deleted.txt'],
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inserted: 1, expected: 1, tombstoned: 2 });
    expect(h.batchUpsertService.upsertBatch).toHaveBeenCalledWith(ORG_ID, SOURCE_ID, DEVICE_ID, [entry]);
    expect(h.batchUpsertService.tombstonePaths).toHaveBeenCalledWith(
      ORG_ID,
      SOURCE_ID,
      DEVICE_ID,
      ['folder/deleted.txt'],
    );
  });

  it('hides SMB and non-visible sources from the events endpoint', async () => {
    const h = makeHarness();
    const smb = await h.app.request(`/sources/${SOURCE_ID}/events`, jsonRequest({ upserts: [], deletes: [] }));
    expect(smb.status).toBe(404);
    h.sourcesService.listForDevice.mockResolvedValueOnce([]);
    const hidden = await h.app.request(`/sources/${SOURCE_ID}/events`, jsonRequest({ upserts: [], deletes: [] }));
    expect(hidden.status).toBe(404);
  });

  it('answers a non-UUID batch run ID with the contract 404 before any service access', async () => {
    const h = makeHarness();
    const res = await h.app.request('/runs/not-a-uuid/batch', jsonRequest({ cursor: 'c', entries: [] }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
    expect(h.crawlRunsService.getById).not.toHaveBeenCalled();
  });

  it('returns 409 when the run goes terminal between the ownership check and the cursor write', async () => {
    const h = makeHarness();
    h.crawlRunsService.touch.mockResolvedValueOnce(0);
    const res = await h.app.request(`/runs/${RUN_ID}/batch`, jsonRequest({ cursor: 'c', entries: [entry] }));
    // The entries were written idempotently but the cursor was NOT persisted;
    // reporting 200 here would silently lose the agent's resume position.
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'run not active' });
  });

  it('rejects a batch entry with an unparseable mtime as 400 before any write', async () => {
    const h = makeHarness();
    const res = await h.app.request(`/runs/${RUN_ID}/batch`, jsonRequest({
      cursor: 'c',
      entries: [{ ...entry, mtime: 'not-a-date' }],
    }));
    expect(res.status).toBe(400);
    expect(h.batchUpsertService.upsertBatch).not.toHaveBeenCalled();
  });

  it('rejects negative and fractional sizes destined for the bigint column', async () => {
    const h = makeHarness();
    for (const size of [-1, 1.5]) {
      const res = await h.app.request(`/runs/${RUN_ID}/batch`, jsonRequest({
        cursor: 'c',
        entries: [{ ...entry, size }],
      }));
      expect(res.status).toBe(400);
    }
    expect(h.batchUpsertService.upsertBatch).not.toHaveBeenCalled();
  });

  it('accepts offset timestamps as the Go agent may emit them', async () => {
    const h = makeHarness();
    const res = await h.app.request(`/runs/${RUN_ID}/batch`, jsonRequest({
      cursor: 'c',
      entries: [{ ...entry, mtime: '2026-07-12T12:00:00.123456789+02:00' }],
    }));
    expect(res.status).toBe(200);
  });

  it('answers a retried complete idempotently instead of 404', async () => {
    const h = makeHarness();
    h.crawlRunsService.finish.mockResolvedValueOnce({ alreadyFinished: true } as never);
    const res = await h.app.request(`/runs/${RUN_ID}/complete`, jsonRequest({ complete: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tombstoned: 0, alreadyFinished: true });
  });

  it('rejects the contradictory complete=true plus error as 400', async () => {
    const h = makeHarness();
    const res = await h.app.request(`/runs/${RUN_ID}/complete`, jsonRequest({
      complete: true,
      error: 'should not be here',
    }));
    expect(res.status).toBe(400);
    expect(h.crawlRunsService.finish).not.toHaveBeenCalled();
  });

  it('treats FALSE and 0 as the kill switch and logs its activation', async () => {
    for (const value of ['FALSE', '0', ' false ']) {
      process.env.WORKSPACE_CRAWL_ENABLED = value;
      const h = makeHarness();
      const res = await h.app.request('/crawl-config');
      expect(await res.json()).toMatchObject({ enabled: false });
      expect(h.log).toHaveBeenCalledWith('warn', expect.stringContaining('kill switch active'));
    }
  });

  it('returns a 500 with a contextual log when credential decrypt fails, distinct from 404', async () => {
    const h = makeHarness();
    const { CredentialDecryptError } = await import('../services/credentialService');
    h.credentialService.decryptForDevice.mockRejectedValueOnce(
      new CredentialDecryptError(new Error('wrong key')),
    );
    const res = await h.app.request(`/sources/${SOURCE_ID}/credential`, { method: 'POST' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'credential fetch failed' });
    expect(h.log).toHaveBeenCalledWith('error', expect.stringContaining('credential decrypt failed'));
    expect(h.log).toHaveBeenCalledWith('error', expect.stringContaining(SOURCE_ID));
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ result: 'failure' }));
  });

  it('still serves the credential when the audit transport fails, but logs the gap', async () => {
    const h = makeHarness();
    h.audit.mockRejectedValue(new Error('audit queue unavailable'));
    const res = await h.app.request(`/sources/${SOURCE_ID}/credential`, { method: 'POST' });
    // Pinned contract: audit-transport failure is fail-open (matching the
    // admin routes) — the credential fetch itself succeeded and the agent
    // needs it; the audit hole is surfaced via the log.
    expect(res.status).toBe(200);
    expect(h.log).toHaveBeenCalledWith('error', expect.stringContaining('audit write failed'));
  });

  it('derives all service identity arguments from c.get(agent)', async () => {
    const h = makeHarness({ ...agent, deviceId: OTHER_DEVICE_ID });
    await h.app.request(`/sources/${SOURCE_ID}/credential`, { method: 'POST' });
    expect(h.credentialService.decryptForDevice).toHaveBeenCalledWith(ORG_ID, SOURCE_ID, OTHER_DEVICE_ID);
  });

  describe('complete-hook job creation (W3)', () => {
    it('creates an ingest job when content is enabled for the org', async () => {
      const h = makeHarness();
      const res = await h.app.request(`/runs/${RUN_ID}/complete`, jsonRequest({ complete: true }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ tombstoned: 0 });
      expect(h.getSettings).toHaveBeenCalledWith(ORG_ID);
      expect(h.ingestJobs.ensureJob).toHaveBeenCalledWith(ORG_ID, {
        sourceId: SOURCE_ID,
        crawlRunId: RUN_ID,
        trigger: 'crawl_complete',
      });
    });

    it('skips job creation when content is disabled for the org', async () => {
      const h = makeHarness();
      h.getSettings.mockResolvedValueOnce({ contentEnabled: false });
      const res = await h.app.request(`/runs/${RUN_ID}/complete`, jsonRequest({ complete: true }));
      expect(res.status).toBe(200);
      expect(h.ingestJobs.ensureJob).not.toHaveBeenCalled();
    });

    it('never 500s the complete response when ensureJob throws', async () => {
      const h = makeHarness();
      h.ingestJobs.ensureJob.mockRejectedValueOnce(new Error('db unavailable'));
      const res = await h.app.request(`/runs/${RUN_ID}/complete`, jsonRequest({ complete: true }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ tombstoned: 0 });
      expect(h.log).toHaveBeenCalledWith('error', expect.stringContaining('ingest job'));
    });

    it('does not create a job for an alreadyFinished (retried) complete', async () => {
      const h = makeHarness();
      h.crawlRunsService.finish.mockResolvedValueOnce({ alreadyFinished: true } as never);
      const res = await h.app.request(`/runs/${RUN_ID}/complete`, jsonRequest({ complete: true }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ tombstoned: 0, alreadyFinished: true });
      expect(h.ingestJobs.ensureJob).not.toHaveBeenCalled();
      expect(h.getSettings).not.toHaveBeenCalled();
    });

    it('does not create a job for a complete=false (failed) finish', async () => {
      const h = makeHarness();
      const res = await h.app.request(`/runs/${RUN_ID}/complete`, jsonRequest({ complete: false }));
      expect(res.status).toBe(200);
      expect(h.ingestJobs.ensureJob).not.toHaveBeenCalled();
    });
  });

  describe('crawl-config ingest piggyback (W3)', () => {
    it('invokes runner.advance with the agent poke budget/batch on a normal poll', async () => {
      const h = makeHarness();
      const { AGENT_POKE_BUDGET_MS, AGENT_POKE_BATCH } = await import('../services/ingestJobRunner');
      const res = await h.app.request('/crawl-config');
      expect(res.status).toBe(200);
      expect(h.ingestRunner.advance).toHaveBeenCalledWith(ORG_ID, {
        budgetMs: AGENT_POKE_BUDGET_MS,
        batch: AGENT_POKE_BATCH,
      });
    });

    it('invokes runner.advance even when the crawl kill switch is active', async () => {
      process.env.WORKSPACE_CRAWL_ENABLED = 'false';
      const h = makeHarness();
      const { AGENT_POKE_BUDGET_MS, AGENT_POKE_BATCH } = await import('../services/ingestJobRunner');
      const res = await h.app.request('/crawl-config');
      expect(await res.json()).toEqual({ enabled: false, pollIntervalSeconds: 300, sources: [] });
      expect(h.ingestRunner.advance).toHaveBeenCalledWith(ORG_ID, {
        budgetMs: AGENT_POKE_BUDGET_MS,
        batch: AGENT_POKE_BATCH,
      });
    });

    it('never fails the crawl-config response when advance throws', async () => {
      const h = makeHarness();
      h.ingestRunner.advance.mockRejectedValueOnce(new Error('advance blew up'));
      const res = await h.app.request('/crawl-config');
      expect(res.status).toBe(200);
      expect(h.log).toHaveBeenCalledWith('error', expect.stringContaining('advance blew up'));
    });
  });
});
