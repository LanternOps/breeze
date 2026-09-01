/**
 * apps/api/src/worker.ts — `BREEZE_ROLE=worker` entrypoint (wave 3.5d-b, #4086).
 *
 * No static route imports. Almost every heavier dependency below — the DB
 * module, Redis, the migration-parity waiter, the extension loader, the
 * worker registry, the event-dispatch/event-bus modules, the AI-agent
 * enqueuer, the durable event-subscriber registry — is loaded via a dynamic
 * `await import(...)` inside `main()` rather than a static top-of-file
 * import. This isn't just style: several of those modules' own *static*
 * transitive closures used to reach into `routes/` several hops down —
 * `services/eventSubscribers.ts` → `jobs/automationWorker.ts` →
 * `services/automationRuntime.ts` → `services/scriptDispatch.ts` →
 * `routes/agentWs.ts`, and `extensions/builtinExtensions.ts` →
 * `extensions/stageExtension.ts` → `services/aiTools.ts` →
 * `services/aiToolsBackup.ts` → `services/commandQueue.ts` →
 * `routes/agentWs.ts`. Both are fixed now (the automation-worker subscriber's
 * handler lazily imports `automationWorker.ts` on first fire;
 * `stageExtension.ts` imports the reserved-tool-name check from the leaf
 * module `services/aiToolNames.ts` instead of the full `aiTools.ts` hub).
 *
 * The dynamic `await import(...)` boundary above is NOT by itself a
 * guarantee of a clean closure — a module loaded that way can still
 * statically drag in `routes/` once IT loads, exactly as the two chains
 * above did. The real, load-bearing guarantee is
 * `services/workerEntrypointClosure.contract.test.ts`'s SEEDED walk: it reads
 * this file's own `await import(...)` specifiers, resolves each to a file,
 * and walks every one of them statically, asserting the union reaches no
 * `routes/` file. One residue remains, explicitly allowlisted there with a
 * reviewer-facing justification rather than silently accepted:
 * `jobs/aiAgentEnqueuer.ts` → `services/aiAgents/runService.ts` →
 * `services/aiAgents/agentAuthContext.ts` → `middleware/auth.ts` →
 * `routes/auth/schemas.ts` — an inert schemas/env-flag module, not
 * socket-local dispatch; breaking it means extracting `ENABLE_2FA` out of
 * `middleware/auth.ts`, which needs its own reviewed change.
 *
 * `services/workerRegistry.ts` is deliberately EXCLUDED as a seed from that
 * walk — its own 104 `load()` thunks are lazy by design and must stay
 * unfollowed (see that file's header).
 *
 * Only genuinely leaf modules stay as static top-of-file imports:
 * `config/env` (just `breezeRole`), `config/validate`, `services/sentry`,
 * `services/readiness` (zero imports of its own), `services/shutdownPhases`
 * (zero imports of its own), `utils/envInt` (zero imports of its own), and
 * `services/rejectionSuppressions` (zero imports of its own) — each
 * independently verified importable without pulling in the route graph.
 *
 * #4143 added four more, all held to the same bar: `services/eventLoopMonitor`
 * (`node:perf_hooks` only), `services/eventLoopStarvationReporter` (the
 * monitor only), `services/postgresConnectTimeout` (leaves only), and the two
 * metrics leaves `services/metricsRegistry` (`prom-client` only) and
 * `services/metricsScrapeAuth` (`node:crypto` only). `services/metricsRuntime`
 * and `db/dbPoolHealthMonitor` are deliberately NOT static — their graphs
 * reach `postgres`, and the health server must be listening before that loads.
 *
 * Boot order (the contract, see the plan doc's Task 6):
 *   1. dotenv + role guard (fail closed — this binary runs ONLY as worker).
 *   2. validateConfig(); initSentry().
 *   2b. #3022/#3214/#4143 observability: event-loop lag monitor +
 *      CONNECT_TIMEOUT classifier immediately after initSentry (so a stall is
 *      observable for the whole life of the process), and a `breeze_role`
 *      Sentry tag set inside initSentry so this container's events are
 *      distinguishable from the api container's.
 *   3. Slim raw-node:http health server, started FIRST (before DB/Redis). It
 *      serves `/health`, `/health/ready` and — auth-gated by the same rules as
 *      the api role's `/api/metrics/scrape` — `/metrics`.
 *   4. DB reachability probe, then `waitForMigrationParity()` — NEVER
 *      `autoMigrate()`. A worker-role process never applies migrations. Then
 *      `initializeDatabaseForStartup({ autoMigrateEnabled: false, production })`
 *      — with migrations disabled this runs ONLY `assertRequestDatabaseRoleSafe()`,
 *      the same production role check index.ts performs, so a worker-role
 *      process can never serve tenant-scoped queries through a SUPERUSER/
 *      BYPASSRLS pool.
 *   5. Redis mandatory — exit non-zero if unreachable (no limp mode).
 *   6. Extension runtime in `mode: 'worker'` (parity-check-never-apply,
 *      publish tenancy, stage, validate, seed state, activate registry; no
 *      web-asset registration — there is no HTTP server to serve it from).
 *   7. Register the AI-agent enqueuer + durable event subscribers.
 *   8. Start the registry's `global`-placement workers, then the
 *      event-dispatch consumer (its own phase-2 special, same as index.ts) —
 *      no relay consumer (socket-owner, stays on api/all).
 *   8b. Pool-health watchdog (after validateConfig and after the classifier —
 *      see the call site for both ordering constraints), plus the runtime
 *      metric series that publish its verdict and the event-loop lag.
 *   9. Signal handlers → phased shutdown. The preamble stops both monitors,
 *      then the phases run (drain → workers → queues → eventbus → redis → db →
 *      sentry), mirroring index.ts's Part A semantics.
 */
import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { sql } from 'drizzle-orm';
import { breezeRole } from './config/env';
import { validateConfig } from './config/validate';
import {
  captureException,
  captureMessage,
  flushSentry,
  initSentry,
  setConnectTimeoutClassifier,
} from './services/sentry';
import {
  getEventLoopStarvationThresholdMs,
  startEventLoopMonitor,
  stopEventLoopMonitor,
} from './services/eventLoopMonitor';
import { createStarvationReporter } from './services/eventLoopStarvationReporter';
import {
  getConnectTimeoutStarvationThresholdMs,
  safeDiagnoseConnectTimeout,
} from './services/postgresConnectTimeout';
import { metricsRegistry } from './services/metricsRegistry';
import {
  directPeerAddress,
  evaluateMetricsScrapeAuth,
  parseMetricsScrapeIpAllowlist,
  resolveMetricsScrapeToken,
} from './services/metricsScrapeAuth';
import {
  computeWorkersHealthy,
  createReadinessEvaluator,
  type WorkerInitPhase,
} from './services/readiness';
import { runShutdownPhases } from './services/shutdownPhases';
import { envInt } from './utils/envInt';
import { isBenignRejection, isRecoverablePostgresConnectionTeardown } from './services/rejectionSuppressions';

if (breezeRole() !== 'worker') {
  // This binary runs ONLY as the worker role — mirrors index.ts's inverse
  // guard (BREEZE_ROLE=worker refuses to boot dist/index.cjs).
  console.error('[boot] dist/worker.cjs requires BREEZE_ROLE=worker — got a different role, refusing to start.');
  process.exit(78); // EX_CONFIG
}

// ---------------------------------------------------------------------------
// Module-level boot state. Mirrors index.ts's shape (workerStatus,
// workerInitPhase, shutdownInProgress) so `computeWorkersHealthy` — shared
// with index.ts — sees the same input contract.
// ---------------------------------------------------------------------------

const workerStatus: Record<string, boolean> = {};
let workerInitPhase: WorkerInitPhase = 'pending';
let shuttingDown = false;
/** Flips true once `waitForMigrationParity()` resolves (step 4). Before that,
 *  `/health/ready` reports a fixed reason rather than consulting the live
 *  evaluator, whose db/redis probes aren't wired up with real handles yet. */
let migrationParityAchieved = false;
let healthServer: Server | null = null;
let auditRetryInterval: NodeJS.Timeout | null = null;

/**
 * Set once `services/metricsRuntime` has been dynamically imported (#4143).
 *
 * That module is NOT a static import: its own graph reaches
 * `db/dbPoolHealthMonitor` and therefore `postgres`, and the health server has
 * to be listening before any of that loads (boot step 3). Until it is wired,
 * `/metrics` still answers — it renders whatever the registry holds and simply
 * omits the runtime series, which is the honest reading of "this process has
 * not registered them yet". It never 500s and never fabricates a zero.
 */
let refreshRuntimeMetrics: (() => void) | null = null;

// Assigned once the dynamically-imported db/redis modules are available
// (start of main(), before any readiness probe can actually be reached).
let probeDb: () => Promise<boolean> = async () => false;
let probeRedis: () => Promise<boolean> = async () => false;

/**
 * Readiness cache TTL / probe timeout. Duplicated from index.ts rather than
 * imported: index.ts's own module pulls in the entire route graph at its
 * top, which this file must never do (see the header comment). Same values,
 * same clamping — see index.ts's `READINESS_CACHE_TTL_MS` for the rationale.
 */
const READINESS_CACHE_TTL_MAX_MS = 30_000;
const readinessTtlRaw = envInt('READINESS_CACHE_TTL_MS', 5_000);
const READINESS_CACHE_TTL_MS = Math.min(Math.max(readinessTtlRaw, 0), READINESS_CACHE_TTL_MAX_MS);
const READINESS_PROBE_TIMEOUT_MS = Math.max(envInt('READINESS_PROBE_TIMEOUT_MS', 3_000), 100);

const readiness = createReadinessEvaluator({
  checkDb: () => probeDb(),
  checkRedis: () => probeRedis(),
  workersHealthy: (redisOk) =>
    computeWorkersHealthy({ phase: workerInitPhase, workerStatus, redisOk, shuttingDown }),
  isShuttingDown: () => shuttingDown,
  // ALWAYS true for a worker: `REQUIRE_REDIS_ON_STARTUP` is an api/all-role
  // knob (index.ts:1354-1359's `skipped-no-redis` limp mode is deliberately
  // NOT available here) — every tracked worker is BullMQ-backed, so a
  // worker process with no Redis has no reason to exist.
  requireRedis: true,
  ttlMs: READINESS_CACHE_TTL_MS,
  probeTimeoutMs: READINESS_PROBE_TIMEOUT_MS,
  onProbeFailure: (probeName, error) => {
    console.error(`[worker][ready] ${probeName} probe failed:`, error);
    captureException(error instanceof Error ? error : new Error(String(error)));
  },
});

// ---------------------------------------------------------------------------
// Slim health server (raw node:http — no Hono, no route graph).
// ---------------------------------------------------------------------------

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function currentPhaseLabel(): string {
  return shuttingDown ? 'shutting-down' : workerInitPhase;
}

/**
 * `/health/ready`. Structured 503 bodies with a single `reason`:
 * `'migrations-pending' | 'db' | 'redis' | 'workers-pending' | 'shutting-down'`.
 * Before migration parity is reached, this answers directly (the live
 * evaluator's db/redis probes aren't meaningful yet); afterward it delegates
 * to `readiness.get()` and translates the snapshot into one reason.
 */
async function handleReadyRequest(res: ServerResponse): Promise<void> {
  if (shuttingDown) {
    writeJson(res, 503, { ready: false, reason: 'shutting-down' });
    return;
  }
  if (!migrationParityAchieved) {
    writeJson(res, 503, { ready: false, reason: 'migrations-pending' });
    return;
  }
  try {
    const snapshot = await readiness.get();
    if (snapshot.ready) {
      writeJson(res, 200, { role: 'worker', ...snapshot });
      return;
    }
    const reason = !snapshot.db ? 'db' : !snapshot.redis ? 'redis' : 'workers-pending';
    writeJson(res, 503, { reason, role: 'worker', ...snapshot });
  } catch (error) {
    console.error('[worker][ready] readiness evaluation failed:', error);
    captureException(error instanceof Error ? error : new Error(String(error)));
    writeJson(res, 503, { ready: false, reason: 'db' });
  }
}

/**
 * `/metrics` (#4143) — the worker role's Prometheus scrape endpoint.
 *
 * Before this existed, a droplet in split mode published NOTHING from the
 * container running the relocated BullMQ workers: the registry was private to
 * `routes/metrics.ts`, which a worker-role process must never import, so every
 * series that process could have produced was absent rather than stale. No
 * `up`, no event-loop lag, no pool-health verdict — on the exact process where
 * #3022 and #3214 were loudest.
 *
 * The gate is the SAME three rules the api role applies on
 * `/api/metrics/scrape`, shared via `services/metricsScrapeAuth` rather than
 * reimplemented: configured token (else 503), optional source-IP allowlist
 * (else 403), constant-time bearer compare (else 401). One difference is
 * deliberate and documented on `directPeerAddress`: the allowlist here matches
 * the DIRECT PEER and ignores forwarded headers, because this port has no
 * trusted-proxy configuration to validate them against.
 *
 * Env is read per-request, not cached at module load, so an operator can fix a
 * missing `METRICS_SCRAPE_TOKEN` without the token resolution having been
 * frozen at boot. At Prometheus scrape intervals the cost is irrelevant.
 */
async function handleMetricsRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ipAllowlist = parseMetricsScrapeIpAllowlist();
  const denial = evaluateMetricsScrapeAuth({
    token: resolveMetricsScrapeToken(),
    ipAllowlist,
    authHeader: req.headers.authorization,
    clientIp: ipAllowlist.size > 0 ? directPeerAddress(req.socket) : undefined,
  });
  if (denial) {
    writeJson(res, denial.status, { error: denial.error });
    return;
  }

  try {
    // Refresh the read-on-scrape series (event-loop lag, pool-health verdict)
    // before rendering, exactly as the api role's `metricsResponse` does.
    refreshRuntimeMetrics?.();
    const body = await metricsRegistry.metrics();
    res.writeHead(200, {
      'Content-Type': metricsRegistry.contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    res.end(body);
  } catch (error) {
    // A render fault must not take the process down, and must not be silent:
    // Prometheus sees a 500 (so `up` stays 1 while the scrape fails, which is
    // the distinguishable state) and the fault is reported.
    console.error('[worker][metrics] Failed to render metrics:', error);
    captureException(error instanceof Error ? error : new Error(String(error)));
    writeJson(res, 500, { error: 'Failed to render metrics' });
  }
}

function startHealthServer(port: number): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const pathName = (req.url ?? '/').split('?')[0];
    if (pathName === '/health') {
      // Always 200 once listening — basic liveness, mirrors index.ts's
      // `/health/live`. Never reflects DB/Redis/worker state.
      writeJson(res, 200, { status: 'ok', role: 'worker', phase: currentPhaseLabel() });
      return;
    }
    if (pathName === '/health/ready') {
      void handleReadyRequest(res);
      return;
    }
    if (pathName === '/metrics') {
      void handleMetricsRequest(req, res);
      return;
    }
    writeJson(res, 404, { error: 'not found' });
  });
  // Covers EADDRINUSE (and other listen-time failures) before the global
  // uncaughtException/unhandledRejection handlers are installed later in
  // bootWorker() — without this, a port conflict throws asynchronously with
  // no handler yet attached and the process dies with an opaque stack trace
  // instead of a clear, actionable log line.
  server.on('error', (error) => {
    console.error(`[worker] Health server failed to start on :${port}:`, error);
    process.exit(1);
  });
  server.listen(port, () => {
    console.log(`[worker] health server listening on :${port}`);
  });
  return server;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * The full boot pipeline (steps 2-9; step 1's role guard runs at module load,
 * above). Exported (rather than an anonymous IIFE) so `worker.boot.test.ts`
 * can invoke it directly against mocked heavy dependencies and a mocked
 * `process.exit` — see that file for the test-seam rationale.
 */
export async function bootWorker(): Promise<void> {
  console.log('[worker] Breeze worker process starting...');

  // Step 2.
  initSentry();

  // #3022/#4143 — start measuring event-loop lag immediately after Sentry and
  // before any DB/Redis work, mirroring index.ts, so a stall is observable for
  // the whole life of the process. This matters MORE here than on the api
  // role: the loudest signature in the original incident was the patch
  // scheduler, and in split mode that runs in THIS container. The monitor is a
  // native histogram plus one unref'd interval — it holds nothing open.
  const eventLoopMonitor = startEventLoopMonitor({
    onSample: createStarvationReporter({
      thresholdMs: getEventLoopStarvationThresholdMs,
      capture: (message, tags) =>
        captureMessage(message, { eventCode: 'event_loop_starvation', tags }),
    }),
  });
  if (eventLoopMonitor) {
    console.log(
      `[worker][event-loop] Lag monitor started (interval ${eventLoopMonitor.intervalMs}ms, `
      + `warn threshold ${getEventLoopStarvationThresholdMs()}ms, `
      + `CONNECT_TIMEOUT attribution threshold ${getConnectTimeoutStarvationThresholdMs()}ms)`,
    );
    if (eventLoopMonitor.intervalMs > getEventLoopStarvationThresholdMs()) {
      console.warn(
        `[worker][event-loop] EVENT_LOOP_MONITOR_INTERVAL_MS (${eventLoopMonitor.intervalMs}ms) exceeds the `
        + `starvation threshold (${getEventLoopStarvationThresholdMs()}ms). Stalls shorter than one `
        + `sampling interval cannot be observed, so CONNECT_TIMEOUT causes will report "unknown" (#3022).`,
      );
    }
  } else {
    console.warn(
      '[worker][event-loop] Lag monitor DISABLED via EVENT_LOOP_MONITOR_DISABLED — Postgres '
      + 'CONNECT_TIMEOUT errors will report cause "unknown" because starvation can be '
      + 'neither ruled in nor out (#3022).',
    );
  }

  // Injected rather than imported by services/sentry.ts, which must stay a leaf
  // — same inversion index.ts performs. Must follow startEventLoopMonitor:
  // before the monitor runs every diagnosis correctly reports 'unknown' rather
  // than guessing. The SAFE variant specifically — this runs on error paths and
  // a throw here would cost the original report.
  setConnectTimeoutClassifier(safeDiagnoseConnectTimeout);

  const config = validateConfig();
  console.log(`[worker] Validated config: NODE_ENV=${config.NODE_ENV}`);

  // Step 3 — slim health server FIRST, before any DB/Redis/extension work.
  const port = envInt('API_PORT', 3001);
  healthServer = startHealthServer(port);

  // Everything below is dynamically imported — see the header comment for
  // why (several of these modules' own static closures reach `routes/`).
  const dbModule = await import('./db');
  const { getRedis, closeRedis } = await import('./services/redis');
  const { waitForMigrationParity } = await import('./db/migrationParity');
  const { loadBuiltinExtensions } = await import('./extensions/builtinExtensions');
  const { extensionContributionRegistry } = await import('./extensions/contributionRegistry');
  const { createExtensionStateStore } = await import('./extensions/stateStore');
  const { registerAiAgentEnqueuer } = await import('./jobs/aiAgentEnqueuer');
  const { registerAllEventSubscribers } = await import('./services/eventSubscribers');
  const { buildWebhookFanoutDeps } = await import('./services/webhookFanoutDeps');
  const { startRegisteredWorkers, buildWorkerShutdownTasks } = await import('./services/workerRegistry');
  const { initializeEventDispatchWorker, shutdownEventDispatchWorker } = await import('./jobs/eventDispatchWorker');
  const { shutdownEventDispatcher } = await import('./services/eventDispatcher');
  const { shutdownEventDispatchQueue } = await import('./services/eventDispatchQueue');
  const { getEventBus } = await import('./services/eventBus');
  const { drainAuditRetryQueue } = await import('./services/auditService');
  const {
    getDbPoolHealthMinTimeouts,
    getDbPoolHealthWindowMs,
    startDbPoolHealthMonitor,
    stopDbPoolHealthMonitor,
  } = await import('./db/dbPoolHealthMonitor');
  // Registers the role-agnostic runtime series onto the shared registry and
  // binds the CONNECT_TIMEOUT counter recorder. Dynamic because its graph
  // reaches `db/dbPoolHealthMonitor` -> `postgres`; the health server above is
  // already listening, so this cannot delay liveness.
  const { updateRuntimeMetrics } = await import('./services/metricsRuntime');
  refreshRuntimeMetrics = updateRuntimeMetrics;

  // #3214/#4143 — pool-health watchdog. Ordering matches index.ts's two
  // constraints: after setConnectTimeoutClassifier (nothing is counted until
  // that is wired, so an earlier start only gives it an empty window) and
  // after validateConfig (its probe builds a connection URL straight from the
  // environment, so starting first lets a short interval fire a probe against
  // unvalidated config and report the misconfiguration as a database fault).
  const dbPoolHealthIntervalMs = startDbPoolHealthMonitor();
  if (dbPoolHealthIntervalMs === null) {
    console.warn(
      '[worker][db-pool-health] Watchdog DISABLED via DB_POOL_HEALTH_DISABLED — a poisoned '
      + 'postgres.js pool will decay silently until someone notices the jobs stop (#3214).',
    );
  } else {
    console.log(
      `[worker][db-pool-health] Watchdog started (interval ${dbPoolHealthIntervalMs}ms, `
      + `window ${getDbPoolHealthWindowMs()}ms, probe threshold `
      + `${getDbPoolHealthMinTimeouts()} CONNECT_TIMEOUT(s) per window)`,
    );
  }

  const { db, withSystemDbAccessContext } = dbModule;
  const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
    return typeof withSystemDbAccessContext === 'function' ? withSystemDbAccessContext(fn) : fn();
  };

  probeDb = async () => {
    try {
      await runWithSystemDbAccess(async () => {
        await db.execute(sql`select 1`);
      });
      return true;
    } catch (error) {
      console.error('[worker][startup] Database connectivity check failed:', error);
      return false;
    }
  };
  probeRedis = async () => {
    try {
      const redis = getRedis();
      if (!redis) return false;
      await redis.ping();
      return true;
    } catch (error) {
      console.error('[worker][startup] Redis connectivity check failed:', error);
      return false;
    }
  };

  // Step 4: DB reachability, then migration parity wait. NEVER autoMigrate —
  // a worker-role process is not the one that applies migrations.
  const dbOk = await probeDb();
  if (!dbOk) {
    console.error('[worker] Database is required at startup but is unreachable — exiting.');
    process.exit(1);
    // `process.exit` never returns in production; the explicit `return` is
    // belt-and-braces for a test environment where it's mocked as a no-op.
    return;
  }
  try {
    await waitForMigrationParity({ log: (message: string) => console.log(message) });
  } catch (error) {
    console.error('[worker] Migration parity wait failed:', error);
    captureException(error instanceof Error ? error : new Error(String(error)));
    process.exit(1);
    return;
  }
  migrationParityAchieved = true;

  // Production DB-role verification. `autoMigrateEnabled: false` means this
  // call runs ONLY `assertRequestDatabaseRoleSafe()` (rejects a request pool
  // running as SUPERUSER/BYPASSRLS) — a worker-role process never migrates,
  // but it still must never serve tenant-scoped queries through a role that
  // bypasses RLS. Mirrors index.ts's `initializeDatabaseForStartup` call and
  // its `NODE_ENV === 'production'` gate.
  try {
    await (await import('./db/databaseStartup')).initializeDatabaseForStartup({
      autoMigrateEnabled: false,
      production: config.NODE_ENV === 'production',
    });
  } catch (error) {
    console.error('[worker] Database role verification failed:', error);
    captureException(error instanceof Error ? error : new Error(String(error)));
    process.exit(1);
    return;
  }

  // Step 5: Redis mandatory — never the `skipped-no-redis` limp mode.
  const redisOk = await probeRedis();
  if (!redisOk) {
    console.error('[worker] Redis is required for a worker-role process but is unreachable — exiting.');
    process.exit(1);
    return;
  }

  // Step 6: extension runtime, worker-safe mode (no web-asset registration —
  // there is no HTTP server here to serve it from).
  const extensionStateStore = createExtensionStateStore();
  await loadBuiltinExtensions({
    registry: extensionContributionRegistry,
    stateStore: extensionStateStore,
    mode: 'worker',
  });

  // Step 7 — must run before step 8 so a job enqueued mid-worker-boot (or any
  // event published during it) always finds a registered enqueuer/subscriber.
  registerAiAgentEnqueuer();
  registerAllEventSubscribers(buildWebhookFanoutDeps());

  // Step 8: the registry's `global`-placement workers, then the event-dispatch
  // consumer (its own phase-2 special, mirroring index.ts). No relay consumer
  // — that stays `socket-owner` (api/all only).
  await startRegisteredWorkers('worker', {
    onResult: (name, ok, error) => {
      workerStatus[name] = ok;
      if (!ok) {
        console.error(`[CRITICAL][worker] Failed to initialize ${name}:`, error);
        captureException(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });

  try {
    await initializeEventDispatchWorker();
    workerStatus['eventDispatch'] = true;
  } catch (error) {
    workerStatus['eventDispatch'] = false;
    console.error('[CRITICAL][worker] Failed to initialize eventDispatch:', error);
    captureException(error instanceof Error ? error : new Error(String(error)));
  }

  workerInitPhase = 'started';
  readiness.invalidate();

  const failed = Object.entries(workerStatus).filter(([, ok]) => !ok).map(([n]) => n);
  if (failed.length === 0) {
    console.log('[worker] All workers initialized');
  } else {
    console.error(`[worker] ${failed.length} worker(s) failed to initialize: ${failed.join(', ')}`);
  }

  // Same 30s shape as index.ts's audit-retry drain.
  auditRetryInterval = setInterval(() => {
    void drainAuditRetryQueue().catch((err) => {
      console.error('[worker][audit-retry] drain failed:', err);
    });
  }, 30_000);
  auditRetryInterval.unref?.();

  // Step 9: signal handlers → phased shutdown.
  let shutdownStarted = false;
  const shutdownRuntime = async (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    shuttingDown = true;
    console.log(`[worker][shutdown] Received ${signal}, shutting down gracefully...`);

    // Both samplers are already unref'd, so stopping them is tidiness rather
    // than a requirement — but it keeps a winding-down process from emitting
    // starvation warnings about itself, and stops the watchdog opening a fresh
    // probe connection while the pool drains (which would report
    // `database-unreachable` about a process that is simply shutting down).
    stopEventLoopMonitor();
    stopDbPoolHealthMonitor();

    if (auditRetryInterval) {
      clearInterval(auditRetryInterval);
      auditRetryInterval = null;
    }

    // Close the health server in the preamble — readiness already flipped
    // not-ready above (`shuttingDown = true`) before we stop accepting probes.
    if (healthServer) {
      const server = healthServer;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const boundedAuditDrainTask = async () => {
      await Promise.race([
        drainAuditRetryQueue().then(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    };

    // Sourced from the registry — same losslessness contract as index.ts's
    // shutdown path (services/workerRegistry.ts's `runEntries` registers a
    // shutdown as soon as a module LOADS, before init() runs).
    const workerShutdownTasks = await buildWorkerShutdownTasks('worker');

    const dbCloseTask = async () => {
      const closeDb = dbModule.closeDb;
      if (typeof closeDb === 'function') {
        await closeDb();
      }
    };

    const report = await runShutdownPhases([
      // 1. Final local drains that need DB/Redis still up.
      { name: 'drain', tasks: [boundedAuditDrainTask] },
      // 2. Every worker/consumer close — concurrent, guaranteed to fully
      //    settle before shared infrastructure goes away.
      { name: 'workers', tasks: workerShutdownTasks },
      // 3. Producer queues + dispatchers. No relay shutdown — never started here.
      {
        name: 'queues',
        tasks: [shutdownEventDispatcher, shutdownEventDispatchWorker, shutdownEventDispatchQueue],
      },
      // 4. Event bus releases its borrowed connection reference.
      { name: 'eventbus', tasks: [async () => getEventBus().close()] },
      // 5. The ONLY owner of the Redis quits.
      { name: 'redis', tasks: [closeRedis] },
      // 6. DB pool.
      { name: 'db', tasks: [dbCloseTask] },
      // 7. Sentry flush (bounded internally at 2s).
      { name: 'sentry', tasks: [() => flushSentry()], timeoutMs: 5_000 },
    ]);

    const timedOutSuffix = report.timedOutPhases.length > 0
      ? ` (timed-out phase(s): ${report.timedOutPhases.join(', ')})`
      : '';
    const failedShutdown = report.failures.length > 0;
    if (failedShutdown) {
      console.error(`[worker][shutdown] Completed with ${report.failures.length} failure(s)${timedOutSuffix}`);
    } else {
      console.log(`[worker][shutdown] Complete${timedOutSuffix}`);
    }
    process.exit(failedShutdown ? 1 : 0);
  };

  const onSignal = (signal: NodeJS.Signals) => {
    // Second signal while a graceful shutdown is running: force-exit now,
    // identical to index.ts's semantics.
    process.once(signal, () => {
      console.error(`[worker][shutdown] Second ${signal} — forcing exit`);
      process.exit(130);
    });
    void shutdownRuntime(signal);
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    if (isBenignRejection(reason)) {
      const message = reason instanceof Error ? reason.message : String(reason);
      console.warn('[SDK] Suppressed benign unhandled rejection (session already closed):', message);
      return;
    }
    if (isRecoverablePostgresConnectionTeardown(reason)) {
      console.error('[db] Suppressed postgres connection-teardown write race; pool will reconnect (#1105):',
        reason instanceof Error ? reason.message : String(reason));
      captureException(reason instanceof Error ? reason : new Error(String(reason)));
      return;
    }
    console.error('[worker][FATAL] Unhandled rejection:', reason);
    captureException(reason instanceof Error ? reason : new Error(String(reason)));
  });
  process.on('uncaughtException', (err) => {
    if (isBenignRejection(err)) {
      console.warn('[SDK] Suppressed benign uncaught exception:', err.message);
      return;
    }
    if (isRecoverablePostgresConnectionTeardown(err)) {
      console.error('[db] Suppressed postgres connection-teardown write race; pool will reconnect (#1105):', err.message);
      captureException(err);
      return;
    }
    console.error('[worker][FATAL] Uncaught exception:', err);
    captureException(err);
    void flushSentry().finally(() => process.exit(1));
  });
}

// ---------------------------------------------------------------------------
// Test seams (worker.boot.test.ts). Not for production use.
// ---------------------------------------------------------------------------

/** @internal test seam — the health server's live handle, once started. */
export function _getHealthServerForTest(): Server | null {
  return healthServer;
}

/** @internal test seam — current boot-phase state, without an HTTP round-trip. */
export function _getWorkerInitPhaseForTest(): WorkerInitPhase {
  return workerInitPhase;
}

/** @internal test seam — the live readiness evaluator, for direct `.get()` calls. */
export function _getReadinessForTest(): ReturnType<typeof createReadinessEvaluator> {
  return readiness;
}

// The guard at the top of this file already exits (or, in a test with
// `process.exit` mocked as a no-op, would fall through) when the role is
// wrong — re-checking here means a mocked-exit test environment never
// actually starts the boot pipeline against the wrong role, instead of
// relying on the mock's behavior to stop it.
if (breezeRole() === 'worker') {
  void bootWorker().catch((error) => {
    console.error('[worker][CRITICAL] Worker startup failed:', error);
    process.exit(1);
  });
}
