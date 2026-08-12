import type { ExtensionAgentContext, ExtensionLog, WorkspaceAudit } from '../hostTypes';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  batchEntrySchema,
  createBatchUpsertService,
  MAX_BATCH_ENTRIES,
} from '../services/batchUpsertService';
import {
  createCrawlRunsService,
  SourceNotAssignedError,
  SourceNotFoundError,
  type CrawlRunRow,
} from '../services/crawlRunsService';
import { CredentialDecryptError, createCredentialService } from '../services/credentialService';
import { createSourcesService, type SafeSourceRow } from '../services/sourcesService';
import { matchesScope, scopeForDevice } from '../services/runScope';
import type { createIngestJobsService } from '../services/ingestJobsService';
import {
  AGENT_POKE_BATCH, AGENT_POKE_BUDGET_MS, type createIngestJobRunner,
} from '../services/ingestJobRunner';
import { DecodedBodyTooLargeError, readDecodedBody } from './gunzip';

// Soft limit advertised to agents via /crawl-config so well-behaved clients
// size their batches; the enforced hard cap is MAX_DECODED_BODY_BYTES in
// gunzip.ts (4 MiB), leaving headroom for imprecise-but-honest clients.
const MAX_BATCH_BYTES = 921_600;
const POLL_INTERVAL_SECONDS = 300;
const WALK_OPS_PER_SECOND = 200;

export interface WorkspaceAgentRouteEnv {
  Variables: { agent: ExtensionAgentContext };
}

type SourcesService = Pick<
  ReturnType<typeof createSourcesService>,
  'get' | 'listForDevice'
>;
type CredentialService = Pick<ReturnType<typeof createCredentialService>, 'decryptForDevice'>;
type CrawlRunsService = Pick<
  ReturnType<typeof createCrawlRunsService>,
  'start' | 'touch' | 'finish' | 'getActive' | 'getById'
>;
type BatchUpsertService = Pick<
  ReturnType<typeof createBatchUpsertService>,
  'upsertBatch' | 'tombstonePaths'
>;
// W3: the complete-hook only ever ensures a job (never claims/advances one
// itself), so it needs nothing else off the jobs service.
type IngestJobsService = Pick<ReturnType<typeof createIngestJobsService>, 'ensureJob'>;
// W3: the crawl-config piggyback only ever pokes the runner's budgeted
// advance — claiming/releasing stays entirely inside the runner.
type IngestJobRunner = Pick<ReturnType<typeof createIngestJobRunner>, 'advance'>;

export interface AgentRouteDeps {
  sourcesService: SourcesService;
  credentialService: CredentialService;
  crawlRunsService: CrawlRunsService;
  batchUpsertService: BatchUpsertService;
  ingestJobs: IngestJobsService;
  ingestRunner: IngestJobRunner;
  /** Per-org content flag (W2 Task 3 pattern) — gates complete-hook job creation. */
  getSettings: (orgId: string) => Promise<{ contentEnabled: boolean }>;
  audit: WorkspaceAudit;
  log: ExtensionLog;
}

const startSchema = z.object({ sourceId: z.uuid() }).strict();
const batchSchema = z.object({
  cursor: z.string().max(65_536),
  entries: z.array(batchEntrySchema).max(MAX_BATCH_ENTRIES),
}).strict();
// Wire field is `error` (spec §2.5; the Go agent serializes json:"error").
// Mapped to the service's errorReason at the call site. A complete run
// carrying an error string is contradictory input and rejected outright
// rather than silently discarding the error.
const completeSchema = z.object({
  complete: z.boolean(),
  stats: z.record(z.string(), z.unknown()).optional(),
  error: z.string().max(2000).optional(),
}).strict().superRefine((body, ctx) => {
  if (body.complete && body.error !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['error'],
      message: 'error is only valid when complete is false',
    });
  }
});
const eventsSchema = z.object({
  upserts: z.array(batchEntrySchema).max(MAX_BATCH_ENTRIES),
  deletes: z.array(z.string().max(4096)).max(MAX_BATCH_ENTRIES),
}).strict();

type ParsedBody =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; kind: 'too_large' | 'malformed_json' | 'malformed_encoding' };

async function parseBody(request: Request): Promise<ParsedBody> {
  try {
    return { ok: true, value: JSON.parse(await readDecodedBody(request)) as unknown };
  } catch (error) {
    if (error instanceof DecodedBodyTooLargeError) {
      return { ok: false, status: 413, kind: 'too_large' };
    }
    return {
      ok: false,
      status: 400,
      kind: error instanceof SyntaxError ? 'malformed_json' : 'malformed_encoding',
    };
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Ownership mirrors the scope the run was created under (runScope.ts): SMB
// runs are source-scoped and owned by the assigned crawl device; local_profile
// runs are owned by the device they are keyed to. Gates batch/complete writes.
function isOwnedRun(source: SafeSourceRow, run: CrawlRunRow, deviceId: string): boolean {
  const scope = scopeForDevice(source, deviceId);
  return scope !== null && matchesScope(run, scope);
}

function serializeDate(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function crawlKillSwitchActive(): boolean {
  const raw = process.env.WORKSPACE_CRAWL_ENABLED?.trim().toLowerCase();
  return raw === 'false' || raw === '0';
}

export function createAgentRoutes(deps: AgentRouteDeps): Hono<WorkspaceAgentRouteEnv> {
  const app = new Hono<WorkspaceAgentRouteEnv>();

  // Fail closed on missing agent identity, explicitly and in one place.
  //
  // Every handler below dereferences c.get('agent') unconditionally, and the
  // `agent` Variable is typed non-optional, because the host gateway applies
  // the manifest-declared agent boundary (agentRoutes: true, publicRoutes: [])
  // before dispatch. That is a host INVARIANT, not something this extension
  // enforces — and commit 68bf21d removed ctx.agentAuthMiddleware, which is
  // what previously guaranteed it inside the extension.
  //
  // Without this guard the tree still fails closed, but only incidentally and
  // inconsistently: a dereference TypeError surfacing through onError as a 500
  // on some routes, and a body-validation 400 on the routes that parse before
  // they read the identity. Neither states the actual reason. routes/adminGate
  // fails closed deliberately (403) on the user side; this restores the
  // symmetry on the agent side with the status that names the condition.
  //
  // Registered before the route handlers so it runs ahead of them, and scoped
  // to this sub-app so it travels with createAgentRoutes wherever it is
  // mounted. It deliberately does NOT absorb the caller's path: an
  // authenticated agent hitting an unmatched /agent/* path still falls through
  // to the catch-all 404 mounted alongside this app in index.ts.
  app.use('*', async (c, next) => {
    if (!c.get('agent')) {
      deps.log('warn', `workspace agent request without identity ${c.req.method} ${c.req.path}`);
      return c.json({ error: 'agent identity required' }, 401);
    }
    await next();
  });

  async function visibleSources(agent: ExtensionAgentContext): Promise<SafeSourceRow[]> {
    return deps.sourcesService.listForDevice(agent.orgId, agent.deviceId);
  }

  // Audit transport failures must not change a request's outcome, but they
  // must never be invisible either — an undetectably incomplete audit trail is
  // its own incident.
  async function guardedAudit(
    event: Parameters<WorkspaceAudit>[0],
    context: string,
  ): Promise<void> {
    try {
      await deps.audit(event);
    } catch (error) {
      deps.log('error', `workspace agent audit write failed (${context}): ${errorDetail(error)}`);
    }
  }

  function logBodyRejected(agent: ExtensionAgentContext, route: string, kind: string): void {
    deps.log(
      'warn',
      `workspace agent ${route} body rejected (${kind}) org=${agent.orgId} device=${agent.deviceId}`,
    );
  }

  // W3: piggyback a budgeted ingest advance onto the agent's existing poll.
  // There is no background worker — this in-request nudge is what keeps a
  // live job moving between explicit admin advances. Runs even when crawling
  // itself is kill-switched (content gating is the runner's own per-org
  // settings check, independent of crawl). Must NEVER perturb the poll
  // response: any throw is caught and logged, not surfaced.
  async function pokeIngest(agent: ExtensionAgentContext): Promise<void> {
    try {
      await deps.ingestRunner.advance(agent.orgId, {
        budgetMs: AGENT_POKE_BUDGET_MS,
        batch: AGENT_POKE_BATCH,
      });
    } catch (error) {
      deps.log(
        'error',
        `workspace ingest poke failed org=${agent.orgId} device=${agent.deviceId}: ${errorDetail(error)}`,
      );
    }
  }

  async function resolveRun(
    agent: ExtensionAgentContext,
    runId: string,
  ): Promise<
    | { state: 'running'; run: CrawlRunRow }
    | { state: 'stopped' }
    | { state: 'missing' }
  > {
    // Pre-validate before the id reaches a uuid-typed column: a malformed id
    // must be the contract 404, not a Postgres 22P02 surfacing as a 500.
    if (!z.uuid().safeParse(runId).success) return { state: 'missing' };
    const run = await deps.crawlRunsService.getById(agent.orgId, runId);
    if (!run) return { state: 'missing' };
    const source = await deps.sourcesService.get(agent.orgId, run.sourceId);
    if (!source || !isOwnedRun(source, run, agent.deviceId)) return { state: 'missing' };
    return run.status === 'running'
      ? { state: 'running', run }
      : { state: 'stopped' };
  }

  app.get('/crawl-config', async (c) => {
    const agent = c.get('agent');
    if (crawlKillSwitchActive()) {
      deps.log('warn', 'workspace crawl kill switch active (WORKSPACE_CRAWL_ENABLED)');
      // Piggyback runs even with crawling kill-switched: content gating is
      // per-org via the runner's own settings check, independent of crawl.
      await pokeIngest(agent);
      return c.json({ enabled: false, pollIntervalSeconds: POLL_INTERVAL_SECONDS, sources: [] });
    }
    const sources = await visibleSources(agent);
    const configuredSources = await Promise.all(sources.map(async (source) => {
      const active = await deps.crawlRunsService.getActive(agent.orgId, source.id, agent.deviceId);
      return {
        id: source.id,
        kind: source.kind,
        rootPath: source.rootPath,
        cadenceMinutes: source.crawlCadenceMinutes,
        excludeGlobs: source.excludeGlobs,
        hasCredential: source.kind === 'smb_share' && source.hasCredential,
        lastCompleteRunAt: serializeDate(source.lastCompleteRunAt),
        activeRun: active === null ? null : {
          runId: active.id,
          startedAt: active.startedAt.toISOString(),
          cursor: active.cursor,
        },
        watch: source.kind === 'local_profile' ? source.watch : false,
      };
    }));
    const payload = {
      enabled: true,
      pollIntervalSeconds: POLL_INTERVAL_SECONDS,
      limits: {
        maxBatchBytes: MAX_BATCH_BYTES,
        maxBatchEntries: MAX_BATCH_ENTRIES,
        walkOpsPerSecond: WALK_OPS_PER_SECOND,
      },
      sources: configuredSources,
    };
    // Piggyback AFTER the response payload is built (Flag 4: adds up to
    // ~AGENT_POKE_BUDGET_MS to this poll while a job is live).
    await pokeIngest(agent);
    return c.json(payload);
  });

  app.post('/sources/:id/credential', async (c) => {
    c.header('Cache-Control', 'no-store');
    const agent = c.get('agent');
    const sourceId = c.req.param('id');
    const audit = (result: 'success' | 'failure') => guardedAudit({
      orgId: agent.orgId,
      actorType: 'agent',
      actorId: agent.deviceId,
      action: 'workspace.source.credential.fetch',
      resourceType: 'workspace_source',
      resourceId: sourceId,
      result,
    }, `credential.fetch source=${sourceId}`);
    if (!z.uuid().safeParse(sourceId).success) {
      await audit('failure');
      return c.json({ error: 'not found' }, 404);
    }
    try {
      const credential = await deps.credentialService.decryptForDevice(
        agent.orgId,
        sourceId,
        agent.deviceId,
      );
      if (credential === null) {
        await audit('failure');
        return c.json({ error: 'not found' }, 404);
      }
      await audit('success');
      return c.json(credential);
    } catch (error) {
      await audit('failure');
      const label = error instanceof CredentialDecryptError ? 'credential decrypt' : 'credential fetch';
      deps.log(
        'error',
        `workspace agent ${label} failed source=${sourceId} org=${agent.orgId} ` +
        `device=${agent.deviceId}: ${errorDetail(error)}`,
      );
      return c.json({ error: 'credential fetch failed' }, 500);
    }
  });

  app.post('/runs', async (c) => {
    const parsed = startSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: 'invalid request' }, 400);
    const agent = c.get('agent');
    const sources = await visibleSources(agent);
    if (!sources.some((source) => source.id === parsed.data.sourceId)) {
      return c.json({ error: 'not found' }, 404);
    }
    try {
      const result = await deps.crawlRunsService.start(
        agent.orgId,
        parsed.data.sourceId,
        agent.deviceId,
      );
      if ('conflict' in result) return c.json({ error: 'run already active' }, 409);
      return c.json({ runId: result.run.id, startedAt: result.run.startedAt.toISOString() });
    } catch (error) {
      if (error instanceof SourceNotFoundError || error instanceof SourceNotAssignedError) {
        return c.json({ error: 'not found' }, 404);
      }
      deps.log(
        'error',
        `workspace agent run start failed source=${parsed.data.sourceId} ` +
        `org=${agent.orgId} device=${agent.deviceId}: ${errorDetail(error)}`,
      );
      return c.json({ error: 'failed to start run' }, 500);
    }
  });

  app.post('/runs/:runId/batch', async (c) => {
    const agent = c.get('agent');
    const runId = c.req.param('runId');
    const decoded = await parseBody(c.req.raw);
    if (!decoded.ok) {
      if (decoded.status === 400) logBodyRejected(agent, `batch run=${runId}`, decoded.kind);
      return c.json(
        { error: decoded.status === 413 ? 'batch too large' : 'invalid request' },
        decoded.status,
      );
    }
    // Checked before Zod so oversized batches get 413 (agent splits and
    // retries) rather than a generic 400 (agent drops the batch).
    const rawEntries = typeof decoded.value === 'object' && decoded.value !== null &&
      'entries' in decoded.value && Array.isArray(decoded.value.entries)
      ? decoded.value.entries
      : null;
    if (rawEntries !== null && rawEntries.length > MAX_BATCH_ENTRIES) {
      return c.json({ error: 'batch too large' }, 413);
    }
    const parsed = batchSchema.safeParse(decoded.value);
    if (!parsed.success) return c.json({ error: 'invalid request' }, 400);
    const resolved = await resolveRun(agent, runId);
    if (resolved.state === 'missing') return c.json({ error: 'not found' }, 404);
    if (resolved.state === 'stopped') return c.json({ error: 'run not active' }, 409);
    const result = await deps.batchUpsertService.upsertBatch(
      agent.orgId,
      resolved.run.sourceId,
      resolved.run.deviceKey,
      parsed.data.entries,
    );
    const touched = await deps.crawlRunsService.touch(agent.orgId, runId, parsed.data.cursor, {
      seen: parsed.data.entries.length,
    });
    if (touched === 0) {
      // The run went terminal between resolveRun and touch: the entries were
      // written (idempotently — a retry is safe) but the cursor and stats were
      // not. Reporting success here would silently lose the agent's cursor.
      return c.json({ error: 'run not active' }, 409);
    }
    return c.json(result);
  });

  app.post('/runs/:runId/complete', async (c) => {
    const parsed = completeSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: 'invalid request' }, 400);
    const agent = c.get('agent');
    const runId = c.req.param('runId');
    if (!z.uuid().safeParse(runId).success) return c.json({ error: 'not found' }, 404);
    const result = await deps.crawlRunsService.finish(
      agent.orgId,
      runId,
      agent.deviceId,
      {
        complete: parsed.data.complete,
        stats: parsed.data.stats,
        errorReason: parsed.data.error,
      },
    );
    if ('notFound' in result) return c.json({ error: 'not found' }, 404);
    // A retried complete (lost response) is answered idempotently; the
    // tombstone sweep already ran on the first attempt — and so did any job
    // creation, so this path must NOT re-ensure one.
    if ('alreadyFinished' in result) return c.json({ tombstoned: 0, alreadyFinished: true });

    // W3 complete-hook: a genuinely fresh, successful finish nudges
    // productized ingest into motion. Job creation must NEVER fail (or even
    // slow down the wire contract of) the agent's complete response — every
    // failure mode here is caught and logged, never surfaced.
    if (parsed.data.complete) {
      try {
        if ((await deps.getSettings(agent.orgId)).contentEnabled) {
          const run = await deps.crawlRunsService.getById(agent.orgId, runId);
          await deps.ingestJobs.ensureJob(agent.orgId, {
            sourceId: run?.sourceId ?? null,
            crawlRunId: runId,
            trigger: 'crawl_complete',
          });
        }
      } catch (error) {
        deps.log(
          'error',
          `workspace ingest job creation failed run=${runId} org=${agent.orgId}: ${errorDetail(error)}`,
        );
      }
    }

    return c.json({ tombstoned: result.tombstoned });
  });

  app.post('/sources/:id/events', async (c) => {
    const agent = c.get('agent');
    const sourceId = c.req.param('id');
    const decoded = await parseBody(c.req.raw);
    if (!decoded.ok) {
      if (decoded.status === 400) logBodyRejected(agent, `events source=${sourceId}`, decoded.kind);
      return c.json(
        { error: decoded.status === 413 ? 'batch too large' : 'invalid request' },
        decoded.status,
      );
    }
    // Same 413-before-Zod rule as the batch route; this pre-check must track
    // eventsSchema's field names.
    if (typeof decoded.value === 'object' && decoded.value !== null) {
      const body = decoded.value as Record<string, unknown>;
      if (
        (Array.isArray(body.upserts) && body.upserts.length > MAX_BATCH_ENTRIES) ||
        (Array.isArray(body.deletes) && body.deletes.length > MAX_BATCH_ENTRIES)
      ) {
        return c.json({ error: 'batch too large' }, 413);
      }
    }
    const parsed = eventsSchema.safeParse(decoded.value);
    if (!parsed.success) return c.json({ error: 'invalid request' }, 400);
    const source = (await visibleSources(agent)).find((candidate) => (
      candidate.id === sourceId && candidate.kind === 'local_profile'
    ));
    if (!source) return c.json({ error: 'not found' }, 404);
    const upserted = await deps.batchUpsertService.upsertBatch(
      agent.orgId,
      sourceId,
      agent.deviceId,
      parsed.data.upserts,
    );
    const tombstoned = await deps.batchUpsertService.tombstonePaths(
      agent.orgId,
      sourceId,
      agent.deviceId,
      parsed.data.deletes,
    );
    return c.json({ ...upserted, tombstoned });
  });

  return app;
}
