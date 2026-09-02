import 'dotenv/config';
// Canonicalize NODE_ENV before any module reads it (some routes/services gate
// on `NODE_ENV === 'production'` at import time). Must stay directly after
// dotenv so .env is loaded first. See #917 (L-6).
import './config/normalizeNodeEnv';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { prettyJSON } from 'hono/pretty-json';
import { secureHeaders } from 'hono/secure-headers';

import { securityMiddleware } from './middleware/security';
import { requestPathLogger } from './middleware/requestPathLogger';
import { createGlobalBodyLimitMiddleware } from './middleware/bodyLimitGate';
import { globalRateLimit } from './middleware/globalRateLimit';
import { authRoutes } from './routes/auth';
import { accountDeletionAdminRoutes } from './routes/auth/accountDeletion';
import { configRoutes } from './routes/config';
import { externalServicesRoutes } from './routes/externalServices';
import { agentRoutes } from './routes/agents';
import { deviceRoutes } from './routes/devices';
import { pamRoutes } from './routes/pam';
import { scriptRoutes } from './routes/scripts';
import { scriptLibraryRoutes } from './routes/scriptLibrary';
import { automationRoutes, automationWebhookRoutes } from './routes/automations';
import { alertRoutes } from './routes/alerts';
import { alertTemplateRoutes } from './routes/alertTemplates';
import { ticketsRoutes } from './routes/tickets';
import { mailboxRoutes } from './routes/tickets/mailboxConnect';
import { catalogRoutes } from './routes/catalog';
import { emailWebhookRoutes } from './routes/tickets/emailWebhook';
import { invoiceRoutes } from './routes/invoices';
import { quoteRoutes } from './routes/quotes';
import { quotesPublicRoutes } from './routes/quotesPublic';
import { invoicesPublicRoutes } from './routes/invoicesPublic';
import { stripeConnectRoutes } from './routes/stripeConnect';
import { stripeWebhookRoutes } from './routes/webhooks/stripe';
import { quickbooksWebhookRoutes } from './routes/webhooks/quickbooks';
import { invoiceAssemblyRoutes } from './routes/invoices/assembly';
import { invoiceSettingsRoutes } from './routes/invoices/settings';
import { contractRoutes } from './routes/contracts';
import { timeEntriesRoutes } from './routes/timeEntries';
import { ticketCategoriesRoutes } from './routes/ticketCategories';
import { ticketConfigRoutes } from './routes/ticketConfig';
import { ticketResponseTemplateRoutes } from './routes/tickets/ticketResponseTemplates';
import { ticketFormRoutes } from './routes/tickets/forms';
import { tenantVariableRoutes } from './routes/tenantVariables';
import { orgRoutes } from './routes/orgs';
import { orgMergeRoutes } from './routes/orgMerge';
import { orgArchiveRoutes } from './routes/orgArchive';
import { oauthRoutes } from './routes/oauth';
import { wellKnownRoutes } from './routes/oauthWellKnown';
import { oauthInteractionRoutes } from './routes/oauthInteraction';
import { connectedAppsRoutes } from './routes/connectedApps';
import { userRoutes } from './routes/users';
import { roleRoutes } from './routes/roles';
import { permissionsCatalogRoutes } from './routes/permissionsCatalog';
import { auditLogRoutes } from './routes/auditLogs';
import { backupRoutes } from './routes/backup';
import { reportRoutes } from './routes/reports';
import { incidentRoutes } from './routes/incidents';
import { searchRoutes } from './routes/search';
import { logsRoutes } from './routes/logs';
import { remoteRoutes } from './routes/remote';
import { apiKeyRoutes } from './routes/apiKeys';
import { servicePrincipalRoutes } from './routes/servicePrincipals';
import { partnerServicePrincipalRoutes } from './routes/partnerServicePrincipals';
import { partnerApiRoutes } from './routes/partnerApi';
import { enrollmentKeyRoutes, publicEnrollmentRoutes, publicShortLinkRoutes } from './routes/enrollmentKeys';
import { installerRoutes } from './routes/installer';
import { supportPublicRoutes } from './routes/supportPublic';
import { ssoRoutes } from './routes/sso';
import { partnerLoginBrandingRoutes } from './routes/partnerLoginBranding';
import { docsRoutes } from './routes/docs';
import { accessReviewRoutes } from './routes/accessReviews';
import { webhookRoutes } from './routes/webhooks';
import { policyRoutes } from './routes/policyManagement';
import { configPolicyRoutes } from './routes/configurationPolicies';
import { psaRoutes } from './routes/psa';
import { patchRoutes } from './routes/patches/index';
import { thirdPartyCatalogRoutes } from './routes/thirdPartyCatalog';
import { patchPolicyRoutes } from './routes/patchPolicies';
import { updateRingRoutes } from './routes/updateRings';
import { mobileRoutes } from './routes/mobile';
import { approvalRoutes } from './routes/approvals';
import { actionIntentsRoutes } from './routes/actionIntents';
import { authenticatorRoutes, approverDevicesRoutes } from './routes/authenticator';
import { lifecycleRoutes, lifecycleAdminRoutes } from './routes/lifecycle';
import { mobileDeviceBlockedMiddleware } from './middleware/mobileDeviceBlocked';
import { analyticsRoutes } from './routes/analytics';
import { fleetFindingsRoutes } from './routes/fleetFindings';
import { discoveryRoutes } from './routes/discovery';
import { networkBaselineRoutes } from './routes/networkBaselines';
import { networkChangeRoutes } from './routes/networkChanges';
import { portalRoutes } from './routes/portal';
import { clientAiRoutes } from './routes/clientAi';
import { officeAddinRoutes } from './routes/officeAddin';
import { pluginRoutes } from './routes/plugins';
import { maintenanceRoutes } from './routes/maintenance';
import { securityRoutes } from './routes/security';
import { cisHardeningRoutes } from './routes/cisHardening';
import { reliabilityRoutes } from './routes/reliability';
import { userRiskRoutes } from './routes/userRisk';
import { snmpRoutes } from './routes/snmp';
import { monitorRoutes } from './routes/monitors';
import { monitoringRoutes } from './routes/monitoring';
import { auditBaselineRoutes } from './routes/auditBaselines';
import { softwareRoutes } from './routes/software';
import { softwarePoliciesRoutes } from './routes/softwarePolicies';
import { vulnerabilityRoutes, vulnerabilitySyncRoutes } from './routes/vulnerabilities';
import { systemRoutes } from './routes/system';
import { systemToolsRoutes } from './routes/systemTools';
import { notificationRoutes } from './routes/notifications';
import { metricsRoutes, metricsMiddleware } from './routes/metrics';
import { groupRoutes } from './routes/groups';
import { integrationRoutes } from './routes/integrations';
import { partnerRoutes } from './routes/partner';
import { networkKnownGuestsRoutes } from './routes/networkKnownGuests';
import { tagRoutes } from './routes/tags';
import { customFieldRoutes } from './routes/customFields';
import { filterRoutes } from './routes/filters';
import { deploymentRoutes } from './routes/deployments';
import { createAgentWsRoutes } from './routes/agentWs';
import { createTerminalWsRoutes } from './routes/terminalWs';
import { createDesktopWsRoutes } from './routes/desktopWs';
import { createTunnelWsRoutes } from './routes/tunnelWs';
import { tunnelHttpRoutes } from './routes/tunnelHttp';
import { createEventWsRoutes, createEventWsTicketRoute } from './routes/eventWs';
import { tunnelRoutes, vncExchangeRoutes, vncViewerRoutes } from './routes/tunnels';
import { agentVersionRoutes } from './routes/agentVersions';
import { viewerRoutes } from './routes/viewers';
import { aiRoutes } from './routes/ai';
import { aiProviderRoutes } from './routes/aiProvider';
import { aiAgentsRoutes } from './routes/aiAgents';
import { aiAgentSchedulesRoutes } from './routes/aiAgentSchedules';
import { scriptAiRoutes } from './routes/scriptAi';
import { mcpServerRoutes, initMcpBootstrapForStartup } from './routes/mcpServer';
import { mountInviteLandingRoutes } from './modules/mcpInvites';
import { devPushRoutes } from './routes/devPush';
import { helperRoutes } from './routes/helper';
import { playbookRoutes } from './routes/playbooks';
import { remediationSuggestionRoutes } from './routes/remediationSuggestions';
import { seedBuiltInPlaybooks } from './services/builtInPlaybooks';
import { ensureSystemLibraryScripts } from './services/systemScriptLibrary';
import { seedDefaultAuditBaselines } from './services/auditBaselineService';
import { changesRoutes } from './routes/changes';
import { dnsSecurityRoutes } from './routes/dnsSecurity';
import { sentinelOneRoutes } from './routes/sentinelOne';
import { softwareInventoryRoutes } from './routes/softwareInventory';
import { huntressRoutes } from './routes/huntress';
import { pax8Routes } from './routes/pax8';
import { pax8OrderRoutes } from './routes/pax8Orders';
import { unifiRoutes } from './routes/unifi';
import { accountingRoutes } from './routes/accounting';
import { sensitiveDataRoutes } from './routes/sensitiveData';
import { peripheralControlRoutes } from './routes/peripheralControl';
import { browserSecurityRoutes } from './routes/browserSecurity';
import { c2cRoutes, m365CallbackRoute } from './routes/c2c';
import { googleRoutes } from './routes/google';
import { m365ActionsConsentCallbackRoutes, m365ConsentCallbackRoutes } from './routes/m365ConsentCallback';
import { m365CustomerGraphActionsRoutes } from './routes/m365CustomerGraphActions';
import { m365CustomerGraphReadRoutes } from './routes/m365CustomerGraphRead';
import { m365Routes } from './routes/m365';
import { onedriveRoutes } from './routes/onedrive';
import { drRoutes } from './routes/dr';
import { adminRoutes } from './routes/admin';
import { extensionsAdminRoutes } from './routes/extensionsAdmin';
import { extensionsWebRoutes } from './routes/extensionsWeb';
import { internalSyntheticRoutes } from './routes/internal/synthetic';
import { bootstrapPlatformAdmins } from './services/platformAdminBootstrap';
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
import {
  getDbPoolHealthMinTimeouts,
  getDbPoolHealthWindowMs,
  startDbPoolHealthMonitor,
  stopDbPoolHealthMonitor,
} from './db/dbPoolHealthMonitor';
import { isBenignRejection, isRecoverablePostgresConnectionTeardown } from './services/rejectionSuppressions';
import { partnerGuard } from './middleware/partnerGuard';
import { API_VERSION } from './version';

// Workers
//
// wave 3.5d-b (#4086): the 104 static `initialize*`/`shutdown*` imports that
// used to live here are gone — `services/workerRegistry.ts` lazy-loads each
// one's module only when its entry is actually selected for the running
// role, so this file's own import closure no longer has to pull in the
// entire worker-module graph. The handful of imports below are the
// "phase 2 specials" that stay directly in index.ts (not registry entries):
// the webhook-delivery singleton (`shutdownRuntime`'s preamble calls
// `getWebhookWorker().stop()` before any other shutdown phase runs), and the
// event-dispatch/relay consumers, which have their own role gating distinct
// from the registry's placement filter.
import { getWebhookWorker } from './workers/webhookDelivery';
import { startRegisteredWorkers, buildWorkerShutdownTasks } from './services/workerRegistry';
import { registerAiAgentEnqueuer } from './jobs/aiAgentEnqueuer';
import { backfillC2cConnectionSecrets } from './services/c2cSecrets';
import { registerAllEventSubscribers } from './services/eventSubscribers';
import { buildWebhookFanoutDeps } from './services/webhookFanoutDeps';
import { closeRedis, getRedis, isRedisAvailable } from './services/redis';
import { shutdownEventDispatcher } from './services/eventDispatcher';
import { initializeEventDispatchWorker, shutdownEventDispatchWorker } from './jobs/eventDispatchWorker';
import { shutdownEventDispatchQueue } from './services/eventDispatchQueue';
import {
  initializeAgentCommandRelayWorker,
  shutdownAgentCommandRelayWorker,
} from './jobs/agentCommandRelayWorker';
import { breezeRole } from './config/env';
import { getEventBus } from './services/eventBus';
import { writeAuditEvent } from './services/auditEvents';
import { drainAuditRetryQueue } from './services/auditService';
import { runShutdownPhases } from './services/shutdownPhases';
import { drainLlmEgressQueue } from './services/llm/llmEgressRecorder';
import { createCorsOriginResolver } from './services/corsOrigins';
import { validateConfig } from './config/validate';
import { initializeDatabaseForStartup } from './db/databaseStartup';
import { loadBuiltinExtensions } from './extensions/builtinExtensions';
import { extensionContributionRegistry } from './extensions/contributionRegistry';
import { mountExtensionGateway } from './extensions/gateway';
import { createExtensionStateStore } from './extensions/stateStore';
import { createEnabledGate } from './extensions/enabledGate';
import {
  attributeExtensionError,
  extensionRootsSnapshot,
} from './extensions/faultAttribution';
import { syncBinaries } from './services/binarySync';
import * as dbModule from './db';
import { deviceGroups, devices, securityThreats, webhookDeliveries } from './db/schema';
import { eq, ne, sql } from 'drizzle-orm';
import { envInt } from './utils/envInt';
import {
  computeWorkersHealthy,
  createReadinessEvaluator,
  type WorkerInitPhase
} from './services/readiness';
import { createReadinessHandler } from './routes/readiness';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return defaultValue;

  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

const REQUIRE_DB_ON_STARTUP = envFlag('REQUIRE_DB_ON_STARTUP', true);
const REQUIRE_REDIS_ON_STARTUP = envFlag(
  'REQUIRE_REDIS_ON_STARTUP',
  (process.env.NODE_ENV ?? 'development') === 'production'
);

const app = new Hono();

/**
 * Boot-time connectivity results. These drive the startup fail-fast gate and
 * the decision to start Redis-backed workers. They deliberately do NOT answer
 * `/ready` — that used to be exactly the bug (#2974): the snapshot was taken
 * once during boot, and whichever way the race with worker registration landed
 * was latched for the process lifetime.
 */
const startupChecks = {
  dbOk: false,
  redisOk: false
};

/** How far boot-time worker initialisation has progressed. */
let workerInitPhase: WorkerInitPhase = 'pending';

/**
 * Readiness cache lifetime.
 *
 * `/ready` is unauthenticated and exempt from the global rate limiter
 * (`SKIP_PATHS` in `middleware/globalRateLimit.ts`, so load-balancer probes
 * aren't throttled). An uncached live check would therefore let any anonymous
 * caller drive one Postgres `select 1` plus one Redis `PING` per request. The
 * TTL bounds that to a single probe pair per window regardless of request rate,
 * while staying far below any realistic uptime-check interval so a genuine
 * outage still surfaces within seconds.
 *
 * Clamped rather than trusted: a negative value would silently disable the
 * amplification defence, and an over-large one would re-create #2974 in slow
 * motion by latching the answer for minutes.
 */
const READINESS_CACHE_TTL_MAX_MS = 30_000;
const readinessTtlRaw = envInt('READINESS_CACHE_TTL_MS', 5_000);
const READINESS_CACHE_TTL_MS = Math.min(Math.max(readinessTtlRaw, 0), READINESS_CACHE_TTL_MAX_MS);
if (READINESS_CACHE_TTL_MS !== readinessTtlRaw) {
  console.warn(
    `[ready] READINESS_CACHE_TTL_MS=${readinessTtlRaw} out of range, clamped to ${READINESS_CACHE_TTL_MS}ms`
  );
}

/**
 * Per-probe deadline. postgres.js has a connect timeout but no pool-acquire
 * timeout, so a saturated pool can leave `select 1` queued indefinitely.
 * Without a deadline that evaluation would never settle and the evaluator's
 * single-flight slot would never clear, silencing `/ready` for the rest of the
 * process. Kept well under a typical load-balancer probe timeout.
 */
const READINESS_PROBE_TIMEOUT_MS = Math.max(envInt('READINESS_PROBE_TIMEOUT_MS', 3_000), 100);

/**
 * One-shot guard for the "Redis came back but boot never started the workers"
 * state. It is terminal until restart and its payload
 * (`{db:true, redis:true, workers:false}`) is indistinguishable from #2974, so
 * the explanation has to reach logs and Sentry rather than only a 503 body.
 */
let warnedWorkersNeverStarted = false;

const readiness = createReadinessEvaluator({
  checkDb: () => checkDatabaseConnectivity(),
  checkRedis: () => checkRedisConnectivity(),
  workersHealthy: (redisOk) => {
    if (redisOk && workerInitPhase === 'skipped-no-redis' && !warnedWorkersNeverStarted) {
      warnedWorkersNeverStarted = true;
      const message =
        'Redis is reachable again, but this process skipped worker startup because Redis was down at boot. ' +
        'No queues are being consumed and /ready will stay not-ready until the API restarts.';
      console.error(`[ready] ${message}`);
      captureException(new Error(`[ready] ${message}`));
    }

    return computeWorkersHealthy({
      phase: workerInitPhase,
      workerStatus,
      redisOk,
      shuttingDown: shutdownInProgress
    });
  },
  isShuttingDown: () => shutdownInProgress,
  requireRedis: REQUIRE_REDIS_ON_STARTUP,
  ttlMs: READINESS_CACHE_TTL_MS,
  probeTimeoutMs: READINESS_PROBE_TIMEOUT_MS,
  onProbeFailure: (probeName, error) => {
    console.error(`[ready] ${probeName} probe failed:`, error);
    captureException(error instanceof Error ? error : new Error(String(error)));
  }
});

// Create WebSocket helpers (must be done before routes are registered)
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
const resolveCorsOrigin = createCorsOriginResolver({
  configuredOriginsRaw: process.env.CORS_ALLOWED_ORIGINS,
  nodeEnv: process.env.NODE_ENV
});

// Global middleware
// FIRST, deliberately: `http_requests_total` / `http_request_duration_seconds`
// are the SOC 2 A1.1 capacity signals, and they should measure the whole
// server-side cost of a request — rate limiting and body-limit rejections
// included — not just the time spent inside a route handler. Registering it here
// is also what fixes the underlying gap: the middleware existed and was tested,
// but was never mounted, so neither series appeared in a production scrape.
app.use('*', metricsMiddleware);
app.use('*', requestPathLogger());
app.use(
  '*',
  secureHeaders({
    // Override defaults to match Breeze security policy:
    // - HSTS: 1 year (secureHeaders default is 180 days / 15552000s)
    strictTransportSecurity: 'max-age=31536000; includeSubDomains; preload',
    // - X-Frame-Options: DENY (default is SAMEORIGIN)
    xFrameOptions: 'DENY',
    // - Referrer-Policy: strict-origin-when-cross-origin (default is no-referrer)
    referrerPolicy: 'strict-origin-when-cross-origin',
  })
);
app.use('*', securityMiddleware());
app.use(
  '*',
  createGlobalBodyLimitMiddleware({
    capture: (message, tags) =>
      captureMessage(message, { eventCode: 'body_limit_rejected', tags }),
  })
);
app.use('*', globalRateLimit());
app.use('*', prettyJSON());
app.use(
  '*',
  cors({
    origin: (origin) => resolveCorsOrigin(origin),
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-API-Key', 'X-Breeze-CSRF'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['Content-Length', 'X-Request-Id'],
    maxAge: 86400
  })
);

const startedAt = Date.now();

// Health check — basic liveness with version and uptime.
// Consumed by Caddy/k8s probes and monitoring. (The agent install.sh pre-flight
// used to grep this for "status":"ok"; it now probes /api/v1/agent-versions
// instead — see routes/agents/download.ts #1470 — so this payload is no longer
// coupled to the installer.)
app.get('/health', (c) => {
  const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);
  return c.json({
    status: 'ok',
    version: API_VERSION,
    uptime: uptimeSeconds
  });
});

// Kubernetes liveness probe — minimal 200 OK
app.get('/health/live', (c) => {
  return c.json({ status: 'ok' });
});

// Full readiness check — live DB + Redis connectivity
app.get('/health/ready', async (c) => {
  const checks: Record<string, string> = {};
  const isProd = process.env.NODE_ENV === 'production';

  // Check database connectivity
  try {
    await runWithSystemDbAccess(async () => {
      await db.execute(sql`select 1`);
    });
    checks.database = 'ok';
  } catch (error) {
    checks.database = isProd
      ? 'error: unavailable'
      : `error: ${error instanceof Error ? error.message : 'unknown'}`;
  }

  // Check Redis connectivity
  try {
    const redis = getRedis();
    if (!redis) {
      checks.redis = isProd ? 'error: unavailable' : 'error: not configured';
    } else {
      await redis.ping();
      checks.redis = 'ok';
    }
  } catch (error) {
    checks.redis = isProd
      ? 'error: unavailable'
      : `error: ${error instanceof Error ? error.message : 'unknown'}`;
  }

  const allOk = Object.values(checks).every((v) => v === 'ok');

  // #3022 — event-loop lag is deliberately NOT reported here. This endpoint is
  // unauthenticated (see HEALTH_CHECK_PATHS in middleware/security.ts), and the
  // lag stats are a live load gradient plus the starvation threshold itself,
  // which would let an unauthenticated prober measure whether its own load is
  // starving the instance. What this endpoint already exposes is binary
  // availability; a tunable pressure readout is a different thing.
  //
  // Nothing is lost by the omission: the same numbers are on the auth-gated
  // /metrics as Prometheus gauges, and the starvation reporter logs to the
  // console unconditionally. Load balancers — the actual consumers here — read
  // the status code, not the body.
  return c.json(
    {
      status: allOk ? 'ready' : 'not_ready',
      checks
    },
    allOk ? 200 : 503
  );
});

// Legacy /ready alias (backward compatibility).
//
// Evaluated live on each request, TTL-cached and single-flighted — see
// `services/readiness.ts`. Response shape is unchanged, except `checkedAt` now
// actually moves; before #2974 it was frozen at the boot-time snapshot.
app.get(
  '/ready',
  createReadinessHandler({
    evaluator: readiness,
    onEvaluationError: (error, c) => {
      console.error('[ready] Readiness evaluation failed:', error);
      captureException(error instanceof Error ? error : new Error(String(error)), c);
    }
  })
);

// Metrics endpoint (for Prometheus scraping at /metrics)
app.route('/metrics', metricsRoutes);

// Short link routes (enrollment short URLs at /s/<code>)
app.route('/s', publicShortLinkRoutes);

// MCP bootstrap invite landing routes (flag-gated). Mount conditional on
// IS_HOSTED so the routes only attach when the feature is on.
// The module is statically imported above — tsup bundles it either way and
// dynamic import broke both CJS production (top-level await) and ESM dev
// (require()). The flag still gates whether the routes actually exist.
// Note: mountActivationRoutes was removed in Phase 4 (activation flow deleted).
if (process.env.IS_HOSTED === 'true') {
  mountInviteLandingRoutes(app);
}

// MCP OAuth routes (flag-gated). Mount conditional on MCP_OAUTH_ENABLED so
// the catch-all only attaches when the feature is on.
if (process.env.MCP_OAUTH_ENABLED === 'true') {
  app.route('/oauth', oauthRoutes);
  app.route('/.well-known', wellKnownRoutes);
  app.route('/api/v1/oauth', oauthInteractionRoutes);
  app.route('/api/v1/settings/connected-apps', connectedAppsRoutes);
}

// API routes
const api = new Hono();

// Blocklist: routes that should NOT get fallback audit events.
// Everything else under /api/v1/ with a mutating method WILL be audited.
const FALLBACK_AUDIT_EXCLUDE_PREFIXES = [
  '/docs',          // read-only OpenAPI docs
  '/search',        // read-only search
  '/metrics',       // read-only Prometheus metrics
  '/agent-ws',      // WebSocket upgrade (not HTTP mutations)
  '/desktop-ws',    // WebSocket upgrade
  '/dev',           // local dev-only push routes
  '/time-entries',  // explicit per-entry audit ownership in route handlers
];

const FALLBACK_AUDIT_EXCLUDE_PATHS: RegExp[] = [
  // Agent telemetry endpoints are high-volume and many already emit explicit audit events.
  /^\/api\/v1\/agents\/[^/]+\/heartbeat$/,
  /^\/api\/v1\/agents\/[^/]+\/security\/status$/,
  /^\/api\/v1\/agents\/[^/]+\/eventlogs$/,
  /^\/api\/v1\/agents\/[^/]+\/logs$/,
  /^\/api\/v1\/agents\/[^/]+\/patches$/,
  /^\/api\/v1\/agents\/[^/]+\/commands\/[^/]+\/result$/,
  /^\/api\/v1\/agents\/[^/]+\/hardware$/,
  /^\/api\/v1\/agents\/[^/]+\/software$/,
  /^\/api\/v1\/agents\/[^/]+\/disks$/,
  /^\/api\/v1\/agents\/[^/]+\/network$/,
  /^\/api\/v1\/agents\/[^/]+\/changes$/,
  /^\/api\/v1\/agents\/[^/]+\/connections$/,
  /^\/api\/v1\/agents\/[^/]+\/reliability$/,
  /^\/api\/v1\/agents\/[^/]+\/registry-state$/,
  /^\/api\/v1\/agents\/[^/]+\/config-state$/,
  /^\/api\/v1\/agents\/[^/]+\/browser-inventory$/,
  /^\/api\/v1\/security\/recommendations\/[^/]+\/(complete|dismiss)$/,
  /^\/api\/v1\/system-tools\/devices\/[^/]+\/processes\/[^/]+\/kill$/,
  /^\/api\/v1\/system-tools\/devices\/[^/]+\/registry\/value$/,
  /^\/api\/v1\/system-tools\/devices\/[^/]+\/registry\/key$/,
  /^\/api\/v1\/system-tools\/devices\/[^/]+\/files\/upload$/,
  // AI chat streaming is high-volume — exclude from fallback audit
  /^\/api\/v1\/helper\/chat\/sessions\/[^/]+\/messages$/,
  // Script builder AI streaming — already audited by route handler
  /^\/api\/v1\/ai\/script-builder\/sessions\/[^/]+\/messages$/,
];

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method);
}

function sanitizeActionSegment(segment: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) {
    return ':id';
  }
  if (/^[0-9]+$/.test(segment)) {
    return ':n';
  }
  if (segment.length > 24 && /^[0-9a-z-]+$/i.test(segment)) {
    return ':id';
  }
  return segment;
}

function isLikelyUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function buildFallbackAction(method: string, apiPath: string): string {
  const cleaned = apiPath.replace(/^\/api\/v1\//, '/');
  const segments = cleaned
    .split('/')
    .filter(Boolean)
    .map(sanitizeActionSegment)
    .slice(0, 4);

  const action = `api.${method.toLowerCase()}.${segments.join('.') || 'unknown'}`;
  return action.length > 100 ? action.slice(0, 100) : action;
}

function getResourceTypeFromPath(apiPath: string): string {
  const cleaned = apiPath.replace(/^\/api\/v1\//, '/');
  const first = cleaned.split('/').filter(Boolean)[0];
  return (first ?? 'system').slice(0, 50);
}

function fallbackAuditEligible(path: string): boolean {
  if (FALLBACK_AUDIT_EXCLUDE_PATHS.some((pattern) => pattern.test(path))) {
    return false;
  }
  if (FALLBACK_AUDIT_EXCLUDE_PREFIXES.some((pfx) => {
    const full = `/api/v1${pfx}`;
    return path === full || path.startsWith(`${full}/`);
  })) {
    return false;
  }
  return path.startsWith('/api/v1/');
}

async function resolveFallbackOrgId(c: Context, path: string): Promise<string | null> {
  const auth = c.get('auth') as { orgId?: string | null; accessibleOrgIds?: string[] } | undefined;
  if (auth?.orgId) {
    return auth.orgId;
  }

  if (auth?.accessibleOrgIds && auth.accessibleOrgIds.length === 1) {
    return auth.accessibleOrgIds[0] ?? null;
  }

  if (path.startsWith('/api/v1/agents/')) {
    const segments = path.split('/').filter(Boolean);
    const agentId = segments[3];
    if (!agentId || agentId === 'enroll') {
      return null;
    }

    try {
      const [device] = await db
        .select({ orgId: devices.orgId })
        .from(devices)
        .where(eq(devices.agentId, agentId))
        .limit(1);
      return device?.orgId ?? null;
    } catch (err) {
      console.error('[audit] Failed to resolve orgId from path:', err);
      return null;
    }
  }

  if (path.startsWith('/api/v1/devices/')) {
    const segments = path.split('/').filter(Boolean);
    const entity = segments[3];
    if (!entity) {
      return null;
    }

    if (entity === 'groups') {
      const groupId = segments[4];
      if (!groupId || !isLikelyUuid(groupId)) {
        return null;
      }

      try {
        const [group] = await db
          .select({ orgId: deviceGroups.orgId })
          .from(deviceGroups)
          .where(eq(deviceGroups.id, groupId))
          .limit(1);
        return group?.orgId ?? null;
      } catch (err) {
        console.error('[audit] Failed to resolve orgId from device group:', err);
        return null;
      }
    }

    if (!isLikelyUuid(entity)) {
      return null;
    }

    try {
      const [device] = await db
        .select({ orgId: devices.orgId })
        .from(devices)
        .where(eq(devices.id, entity))
        .limit(1);
      return device?.orgId ?? null;
    } catch (err) {
      console.error('[audit] Failed to resolve orgId from path:', err);
      return null;
    }
  }

  if (path.startsWith('/api/v1/security/scan/')) {
    const segments = path.split('/').filter(Boolean);
    const deviceId = segments[4];
    if (!deviceId || !isLikelyUuid(deviceId)) {
      return null;
    }

    try {
      const [device] = await db
        .select({ orgId: devices.orgId })
        .from(devices)
        .where(eq(devices.id, deviceId))
        .limit(1);
      return device?.orgId ?? null;
    } catch (err) {
      console.error('[audit] Failed to resolve orgId from path:', err);
      return null;
    }
  }

  if (path.startsWith('/api/v1/security/threats/')) {
    const segments = path.split('/').filter(Boolean);
    const threatId = segments[4];
    if (!threatId || !isLikelyUuid(threatId)) {
      return null;
    }

    try {
      const [threat] = await db
        .select({ orgId: devices.orgId })
        .from(securityThreats)
        .innerJoin(devices, eq(securityThreats.deviceId, devices.id))
        .where(eq(securityThreats.id, threatId))
        .limit(1);
      return threat?.orgId ?? null;
    } catch (err) {
      console.error('[audit] Failed to resolve orgId from path:', err);
      return null;
    }
  }

  if (path.startsWith('/api/v1/system-tools/devices/')) {
    const segments = path.split('/').filter(Boolean);
    const deviceId = segments[4];
    if (!deviceId || !isLikelyUuid(deviceId)) {
      return null;
    }

    try {
      const [device] = await db
        .select({ orgId: devices.orgId })
        .from(devices)
        .where(eq(devices.id, deviceId))
        .limit(1);
      return device?.orgId ?? null;
    } catch (err) {
      console.error('[audit] Failed to resolve orgId from path:', err);
      return null;
    }
  }

  return null;
}

// Generic partner status guard — blocks non-active partners.
// IMPORTANT: every branch MUST `return` the next()/partnerGuard() promise so
// any Response (403 PARTNER_INACTIVE, 403 PARTNER_NOT_FOUND, 503 PARTNER_LOOKUP_UNAVAILABLE)
// propagates back through Hono's compose chain. Discarding the return causes
// Hono to throw "Context is not finalized" and the request collapses to 500.
api.use('*', async (c, next) => {
  const path = c.req.path;
  if (path.startsWith('/api/v1/auth')) return next();
  if (path === '/api/v1/config' || path === '/api/v1/config/') return next();
  if (path.startsWith('/api/v1/users/me')) return next();
  if (path === '/api/v1/partner/me' || path.startsWith('/api/v1/partner/me/')) return next();
  if (path.startsWith('/api/v1/agents/')) return next();
  if (path.startsWith('/api/v1/internal/synthetic/')) return next();   // synthetic test router — self-gated (token + canary latch)
  return partnerGuard(c, next);
});

api.use('*', async (c, next) => {
  await next();

  const method = c.req.method.toUpperCase();
  if (!isMutatingMethod(method)) {
    return;
  }

  const path = c.req.path;
  if (!fallbackAuditEligible(path)) {
    return;
  }

  if (c.res.status === 404) {
    return;
  }

  const orgId = await resolveFallbackOrgId(c, path);
  if (!orgId) {
    return;
  }

  const auth = c.get('auth') as { user?: { id?: string; email?: string }; orgId?: string | null } | undefined;
  const status = c.res.status;

  let result: 'success' | 'denied' | 'failure';
  if (status >= 200 && status < 400) {
    result = 'success';
  } else if (status === 401 || status === 403) {
    result = 'denied';
  } else {
    result = 'failure';
  }

  let actorType: 'user' | 'agent' | 'system';
  if (auth?.user?.id) {
    actorType = 'user';
  } else if (path.startsWith('/api/v1/agents/')) {
    actorType = 'agent';
  } else {
    actorType = 'system';
  }

  writeAuditEvent(c, {
    orgId,
    actorType,
    actorId: auth?.user?.id ?? undefined,
    actorEmail: auth?.user?.email,
    action: buildFallbackAction(method, path),
    resourceType: getResourceTypeFromPath(path),
    details: { path, method, statusCode: status, fallback: true },
    result
  });
});

api.route('/auth', authRoutes);
api.route('/config', configRoutes);
api.route('/', externalServicesRoutes);
api.route('/agents', agentRoutes);
api.route('/devices', deviceRoutes);
api.route('/pam', pamRoutes);
api.route('/scripts', scriptRoutes);
api.route('/script-library', scriptLibraryRoutes);
api.route('/automations/webhooks', automationWebhookRoutes);
api.route('/automations', automationRoutes);
api.route('/alerts', alertRoutes);
api.route('/alert-templates', alertTemplateRoutes);
// M365 mailbox OAuth + connection routes. Mounted as its OWN top-level router
// (NOT under ticketsRoutes) and BEFORE /tickets so its literal /tickets/mailbox/*
// paths win over ticketsRoutes' generic /:id matchers, and — critically — so the
// unauthenticated /tickets/mailbox/callback escapes ticketsRoutes' .use('*',
// authMiddleware) gate (the Microsoft admin-consent redirect carries no Bearer
// token). The callback authenticates via signed state + binding cookie instead.
api.route('/tickets/mailbox', mailboxRoutes);
api.route('/tickets', ticketsRoutes);
api.route('/catalog', catalogRoutes);
// Public, token-gated invoice view-and-pay (no auth) — MUST precede the
// auth-gated /invoices router so the unauthenticated /invoices/public/* sub-path
// isn't swallowed by invoiceRoutes' auth middleware (mirrors /quotes/public).
api.route('/invoices/public', invoicesPublicRoutes);
api.route('/invoices', invoiceRoutes);
// Public, token-gated quote acceptance (no auth) — MUST precede the auth-gated
// /quotes router so the unauthenticated /quotes/public/* sub-path isn't swallowed
// by quoteRoutes' authMiddleware (which it applies internally). partnerGuard
// (the only global api.use) returns next() when there's no Authorization header,
// so this surface stays unauthenticated.
api.route('/quotes/public', quotesPublicRoutes);
api.route('/quotes', quoteRoutes);
api.route('/partner/stripe-connect', stripeConnectRoutes);
api.route('/contracts', contractRoutes);
// Assembly routes nest under the existing /orgs and /tickets namespaces, so they
// mount at the api root: /api/v1/orgs/:orgId/invoices/assemble and
// /api/v1/tickets/:ticketId/invoice. invoiceAssemblyRoutes applies authMiddleware itself.
api.route('/', invoiceAssemblyRoutes);
// Billing settings nest under /partner and /orgs at the api root:
// /api/v1/partner/billing-settings and /api/v1/orgs/:orgId/billing-settings.
// invoiceSettingsRoutes applies authMiddleware itself.
api.route('/', invoiceSettingsRoutes);
api.route('/time-entries', timeEntriesRoutes);
api.route('/ticket-categories', ticketCategoriesRoutes);
api.route('/ticket-config', ticketConfigRoutes);
api.route('/', ticketResponseTemplateRoutes);
api.route('/', ticketFormRoutes);
api.route('/', tenantVariableRoutes);
api.route('/orgs', orgRoutes);
api.route('/orgs', orgMergeRoutes);
api.route('/orgs', orgArchiveRoutes);
api.route('/users', userRoutes);
api.route('/roles', roleRoutes);
api.route('/permissions', permissionsCatalogRoutes);
api.route('/audit-logs', auditLogRoutes);
api.route('/backup', backupRoutes);
api.route('/reports', reportRoutes);
api.route('/incidents', incidentRoutes);
api.route('/search', searchRoutes);
api.route('/logs', logsRoutes);
api.route('/remote/sessions', createTerminalWsRoutes(upgradeWebSocket)); // WebSocket routes first (no auth middleware)
api.route('/desktop-ws', createDesktopWsRoutes(upgradeWebSocket)); // Desktop WebSocket routes (outside /remote to avoid auth middleware)
api.route('/tunnel-ws', createTunnelWsRoutes(upgradeWebSocket)); // Tunnel WebSocket routes (no auth middleware — uses one-time tickets)
api.route('/tunnel-http', tunnelHttpRoutes); // HTTP reverse-proxy (no auth middleware — ticket→scoped-cookie self-auth)
api.route('/events', createEventWsRoutes(upgradeWebSocket)); // Event stream WebSocket (no auth middleware — uses one-time tickets)
api.route('/tunnels', tunnelRoutes);
api.route('/vnc-exchange', vncExchangeRoutes); // No auth — one-time code is the auth
api.route('/vnc-viewer', vncViewerRoutes); // Viewer-token auth (purpose='viewer', scoped to a tunnel sessionId)
api.route('/remote', remoteRoutes);
api.route('/api-keys', apiKeyRoutes);
api.route('/service-principals', servicePrincipalRoutes);
api.route('/partner-service-principals', partnerServicePrincipalRoutes);
api.route('/partner-api', partnerApiRoutes);
api.route('/enrollment-keys', publicEnrollmentRoutes); // Public download (no auth) — must precede auth-protected routes
api.route('/enrollment-keys', enrollmentKeyRoutes);
api.route('/installer', installerRoutes);
// Public Quick Support — the one-time code is the auth (no bearer token).
// Guarded by ~44 bits of code entropy, a 15-minute TTL, per-IP rate limits
// and a single atomic pending->claimed transition.
api.route('/support', supportPublicRoutes);
api.route('/sso', ssoRoutes);
// Mounted directly at /partners (not nested under /orgs' /partners/me or the
// legacy singular /partner router) — final URL /api/v1/partners/me/login-branding
// per Task 11's consumed contract (#2183).
api.route('/partners', partnerLoginBrandingRoutes);
api.route('/docs', docsRoutes);
api.route('/access-reviews', accessReviewRoutes);
api.route('/webhooks', webhookRoutes);
// Inbound email webhook — no session auth, HMAC-gated. partnerGuard passes
// through for requests with no Authorization header (calls next() immediately).
api.route('/webhooks/tickets', emailWebhookRoutes);
// Stripe Connect webhook — no session auth, signature-verified. partnerGuard
// passes through (no Authorization header); the route reads the raw body itself
// via c.req.text(), so no body-consuming middleware sits in front of it.
api.route('/webhooks', stripeWebhookRoutes);
// Intuit QuickBooks webhook — no session auth, HMAC-gated with the app-level
// verifier token. partnerGuard passes through (no Authorization header); the
// route reads the raw body itself via c.req.text(), so no body-consuming
// middleware may sit in front of it. NOT in SELF_MANAGED_DB_CONTEXT_ROUTES:
// there is no ambient auth transaction to opt out of on an unauthenticated route.
api.route('/webhooks', quickbooksWebhookRoutes);
api.route('/policies', policyRoutes);
api.route('/configuration-policies', configPolicyRoutes);
api.route('/psa', psaRoutes);
api.route('/patches', patchRoutes);
api.route('/third-party-catalog', thirdPartyCatalogRoutes);
api.route('/patch-policies', patchPolicyRoutes);
api.route('/update-rings', updateRingRoutes);
// Device-blocked check sits in front of mobile + approvals routes so a
// blocked phone gets a structured 403 from EVERY mobile-app API call,
// not just approval endpoints. The middleware only acts when the
// X-Breeze-Mobile-Device-Id header is present, so non-mobile clients
// (web dashboard, MCP) sail through unchanged.
api.use('/mobile/*', mobileDeviceBlockedMiddleware);
api.route('/mobile', mobileRoutes);
api.route('/mobile/approvals', approvalRoutes);
// Task 8 (tier3-supervised-four-eyes): transport-neutral alias so a web/CLI
// caller doesn't need the `/mobile` prefix to reach the same live-authorized
// pending/decide surface. `/api/v1/mobile/approvals` stays mounted above
// unchanged (mobile app's PREFIX constant, apps/mobile/src/services/approvals.ts).
// Same `approvalRoutes` instance, so its own `authMiddleware` applies
// identically either way — but it sits OUTSIDE `/mobile/*`, so it needs its
// own mobileDeviceBlockedMiddleware registration; otherwise a blocked phone
// could dodge the device-block check entirely by calling this prefix instead
// (same reasoning as the /authenticator and /me/approver-devices mounts
// below).
api.use('/approvals/*', mobileDeviceBlockedMiddleware);
api.route('/approvals', approvalRoutes);
api.route('/action-intents', actionIntentsRoutes);
// /authenticator is where the phone enrols its approver key, so it must be
// behind the same check — a revoked handset registering a signing key is
// exactly the lost-phone case the block is for. It is NOT under /mobile/*,
// so it needs its own mount (#2913). Web/MCP callers sail through: the
// middleware only acts on a device id, which only mobile clients ever carry.
api.use('/authenticator/*', mobileDeviceBlockedMiddleware);
api.route('/authenticator', authenticatorRoutes);
// Same reasoning as /authenticator/*: /me/approver-devices lets a caller
// enumerate and REVOKE the user's approver devices, so a revoked handset
// holding a still-valid token could knock out its owner's second factor.
api.use('/me/approver-devices/*', mobileDeviceBlockedMiddleware);
api.route('/me/approver-devices', approverDevicesRoutes);
api.route('/', lifecycleRoutes);
api.route('/', lifecycleAdminRoutes);
api.route('/analytics', analyticsRoutes);
api.route('/fleet/findings', fleetFindingsRoutes);
api.route('/discovery', discoveryRoutes);
api.route('/network/baselines', networkBaselineRoutes);
api.route('/network/changes', networkChangeRoutes);
api.route('/portal', portalRoutes);
api.route('/client-ai', clientAiRoutes);
api.route('/office-addin', officeAddinRoutes);
api.route('/plugins', pluginRoutes);
api.route('/maintenance', maintenanceRoutes);
api.route('/security', securityRoutes);
api.route('/cis', cisHardeningRoutes);
api.route('/reliability', reliabilityRoutes);
api.route('/user-risk', userRiskRoutes);
api.route('/snmp', snmpRoutes);
api.route('/monitors', monitorRoutes);
api.route('/monitoring', monitoringRoutes);
api.route('/audit-baselines', auditBaselineRoutes);
api.route('/software', softwareRoutes);
api.route('/software-policies', softwarePoliciesRoutes);
// Deeper mount first: isolates the platform-admin sync router from the main
// router's org-scoped `.use('*')` middleware (same-prefix double-mount leaks).
api.route('/vulnerabilities/sync', vulnerabilitySyncRoutes);
api.route('/vulnerabilities', vulnerabilityRoutes);
api.route('/system', systemRoutes);
api.route('/system-tools', systemToolsRoutes);
api.route('/notifications', notificationRoutes);
api.route('/groups', groupRoutes);
api.route('/device-groups', groupRoutes);
api.route('/integrations', integrationRoutes);
api.route('/partner', partnerRoutes);
api.route('/internal/synthetic', internalSyntheticRoutes);
api.route('/partner/known-guests', networkKnownGuestsRoutes);
api.route('/tags', tagRoutes);
api.route('/custom-fields', customFieldRoutes);
api.route('/filters', filterRoutes);
api.route('/deployments', deploymentRoutes);
api.route('/events', createEventWsTicketRoute()); // Event stream ticket endpoint (requires auth)
api.route('/metrics', metricsRoutes);
api.route('/agent-ws', createAgentWsRoutes(upgradeWebSocket));
api.route('/agent-versions', agentVersionRoutes);
api.route('/viewers', viewerRoutes);
api.route('/ai/provider', aiProviderRoutes);
// BEFORE /ai/agents: aiAgentsRoutes owns /:id, which would otherwise capture
// '/schedules' as an agent id (#4189).
api.route('/ai/agents/schedules', aiAgentSchedulesRoutes);
api.route('/ai/agents', aiAgentsRoutes);
api.route('/ai', aiRoutes);
api.route('/ai/script-builder', scriptAiRoutes);
api.route('/mcp', mcpServerRoutes);
api.route('/dev', devPushRoutes);
api.route('/helper', helperRoutes);
api.route('/playbooks', playbookRoutes);
api.route('/remediation-suggestions', remediationSuggestionRoutes);
api.route('/changes', changesRoutes);
api.route('/dns-security', dnsSecurityRoutes);
api.route('/s1', sentinelOneRoutes);
api.route('/huntress', huntressRoutes);
api.route('/pax8', pax8Routes);
api.route('/pax8', pax8OrderRoutes);
api.route('/unifi', unifiRoutes);
api.route('/accounting', accountingRoutes);
api.route('/software-inventory', softwareInventoryRoutes);
api.route('/sensitive-data', sensitiveDataRoutes);
api.route('/peripherals', peripheralControlRoutes);
api.route('/browser-security', browserSecurityRoutes);
api.route('/', m365CallbackRoute); // Public callback (no auth) — must precede c2c group
api.route('/c2c', c2cRoutes);
api.route('/google', googleRoutes);
api.route('/m365', m365ConsentCallbackRoutes); // Public two-phase consent callback; mount before authenticated M365 routes
api.route('/m365', m365ActionsConsentCallbackRoutes); // Public actions-profile callback (/m365/actions-consent/callback); distinct path, same base, no collision
api.route('/m365', m365CustomerGraphReadRoutes);
api.route('/m365/customer-graph-actions', m365CustomerGraphActionsRoutes);
api.route('/m365', m365Routes);
api.route('/onedrive', onedriveRoutes);
api.route('/dr', drRoutes);
// Runtime-extension operations. Mounted BEFORE `/admin` on purpose: it carries
// its own platformAdminMiddleware, and registering the more specific path first
// means adminRoutes' `use('*')` gate never also fires for these requests (which
// would authenticate and audit-log the same request twice).
api.route('/admin/extensions', extensionsAdminRoutes);
api.route('/admin', adminRoutes);
api.route('/admin', accountDeletionAdminRoutes);
// Authenticated (any user) runtime-extension web registry + digest-addressed
// asset serving. Distinct from `/admin/extensions` above (platform-admin
// operations) — this is the tenant-facing surface a browser reads.
api.route('/extensions', extensionsWebRoutes);

// One system-scoped state store, shared by the per-request enabled gate and the
// built-in extension loader. The gate checks installed_extensions.enabled on
// EVERY dispatched extension request (no cache) so an admin disabling an
// extension takes effect fleet-wide on the next request.
const extensionStateStore = createExtensionStateStore();
mountExtensionGateway(
  app,
  extensionContributionRegistry,
  createEnabledGate(extensionStateStore),
);

app.route('/api/v1', api);

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not Found', path: c.req.path }, 404);
});

// Error handler
app.onError((err, c) => {
  // Handle HTTPException properly (e.g., 401, 403, etc.)
  if (err instanceof HTTPException) {
    return c.json(
      {
        error: err.message || 'Request failed',
        message: err.message
      },
      err.status
    );
  }

  // #3022 — say out loud what a CONNECT_TIMEOUT actually means before the raw
  // error is logged. The driver's own message is `write CONNECT_TIMEOUT
  // <host>:<port>`, which reads as a database or network fault and sent the
  // original investigation after both; the loop being blocked produces a
  // byte-identical error. Console-side only (the Sentry tags are set in
  // captureException) so the explanation is present even when Sentry is
  // disabled, which is the self-hosted default.
  //
  // Must be the never-throwing variant: this runs INSIDE onError and ahead of
  // captureException, so a throw here would cost the request its JSON 500 and
  // stop the original error from ever being reported.
  const connectTimeout = safeDiagnoseConnectTimeout(err);
  if (connectTimeout) {
    console.error(connectTimeout.message);
  }

  // Route unhandled errors to Sentry. Per-route `captureException(err, c)`
  // calls only cover routes with explicit try/catch — anything that throws
  // and falls through to onError was previously invisible to Sentry.
  console.error('Error:', err);
  captureException(err, c);
  return c.json(
    {
      error: 'Internal Server Error',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined
    },
    500
  );
});

const port = parseInt(process.env.API_PORT || '3001', 10);

// Initialize background workers (only if Redis is available)
const workerStatus: Record<string, boolean> = {};
// `areWorkersHealthy()` used to be exported here. It had no callers repo-wide
// and, now that readiness is evaluated live, a second copy of the worker-health
// rule could only drift from what `/ready` reports. Use `readiness.get()`.
export function getWorkerStatus(): Record<string, boolean> { return { ...workerStatus }; }

let server: ReturnType<typeof serve> | null = null;
let shutdownInProgress = false;
let auditRetryInterval: NodeJS.Timeout | null = null;

async function initializeWorkers(): Promise<void> {
  if (!startupChecks.redisOk || !isRedisAvailable()) {
    console.warn('[WARN] Redis not available - background workers disabled');
    workerInitPhase = 'skipped-no-redis';
    readiness.invalidate();
    return;
  }

  // wave 3.5d-b (#4086): the 104-entry static array used to live here. It is
  // now the declarative, lazily-loaded `WORKER_REGISTRY` (services/workerRegistry.ts),
  // filtered by role. `startRegisteredWorkers` preserves today's
  // `Promise.allSettled` semantics — one entry's failure never blocks
  // another's, and every outcome (success or failure) is reported here via
  // `onResult`, exactly like the old inline try/catch per entry.
  await startRegisteredWorkers(breezeRole(), {
    onResult: (name, ok, error) => {
      workerStatus[name] = ok;
      if (!ok) {
        console.error(`[CRITICAL] Failed to initialize ${name}:`, error);
        // A failed worker now pins /ready to not-ready for the process
        // lifetime (previously the boot race often hid it), so the reason has
        // to reach Sentry — a stdout line can't explain a permanent 503.
        captureException(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    },
  });

  const failed = Object.entries(workerStatus).filter(([, ok]) => !ok).map(([n]) => n);
  workerInitPhase = 'started';
  // Drop any snapshot taken during the boot race so the next probe sees the
  // real outcome immediately instead of waiting out the TTL.
  readiness.invalidate();

  // Phase 2 (#4085): the event-dispatch worker (router + delivery) starts
  // only AFTER every worker above has settled. registerAllEventSubscribers()
  // already ran synchronously in bootstrap() before initializeWorkers() was
  // even called — this ordering (sync registry -> allSettled inits -> dispatch
  // worker) is what guarantees the dispatch worker never sees a
  // partially-installed subscriber registry (codex Q3 hole #2). Still inside
  // this function, so it inherits the same redis-availability guard at the
  // top that gates the worker array above.
  //
  // wave 3.5d-b (#4086): under an `api`-role process the event-dispatch
  // CONSUMER moves to the worker container (it's a `global`-placement family
  // that `src/worker.ts` starts instead) — gated here so `api` never runs it
  // twice. Under `all` this runs exactly as today (zero behavior change).
  if (breezeRole() !== 'api') {
    try {
      await initializeEventDispatchWorker();
      workerStatus['eventDispatch'] = true;
    } catch (error) {
      workerStatus['eventDispatch'] = false;
      console.error('[CRITICAL] Failed to initialize eventDispatch:', error);
      captureException(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // Wave 3.5b (#4084): the relay CONSUMER only runs on a process that may own
  // agent sockets. In today's BREEZE_ROLE=all topology this is every process
  // (zero behavior change — dispatchCommandToAgent's local-first branch means
  // the relay path is unreachable for an online agent); the 3.5d split
  // (#4086) is what makes a worker-role process actually skip this.
  if (breezeRole() !== 'worker') {
    try {
      await initializeAgentCommandRelayWorker();
      workerStatus['agentCommandRelay'] = true;
    } catch (error) {
      workerStatus['agentCommandRelay'] = false;
      console.error('[CRITICAL] Failed to initialize agentCommandRelay:', error);
      captureException(error instanceof Error ? error : new Error(String(error)));
    }
  }
  readiness.invalidate();

  if (failed.length === 0) {
    console.log('All background workers initialized');
  } else {
    console.error(`[WARN] ${failed.length} worker(s) failed to initialize: ${failed.join(', ')}`);
  }
}

async function checkDatabaseConnectivity(): Promise<boolean> {
  try {
    await runWithSystemDbAccess(async () => {
      await db.execute(sql`select 1`);
    });
    return true;
  } catch (error) {
    console.error('[startup] Database connectivity check failed:', error);
    return false;
  }
}

async function checkRedisConnectivity(): Promise<boolean> {
  try {
    const redis = getRedis();
    if (!redis) {
      return false;
    }

    await redis.ping();
    return true;
  } catch (error) {
    console.error('[startup] Redis connectivity check failed:', error);
    return false;
  }
}

async function runStartupChecks(): Promise<void> {
  const [dbOk, redisOk] = await Promise.all([
    checkDatabaseConnectivity(),
    checkRedisConnectivity()
  ]);

  startupChecks.dbOk = dbOk;
  startupChecks.redisOk = redisOk;

  if (REQUIRE_DB_ON_STARTUP && !dbOk) {
    throw new Error('Database is required at startup but is unreachable');
  }

  if (REQUIRE_REDIS_ON_STARTUP && !redisOk) {
    throw new Error('Redis is required at startup but is unreachable');
  }

  if (envFlag('MCP_OAUTH_ENABLED', false) && !redisOk) {
    throw new Error('Redis is required at startup when MCP OAuth is enabled');
  }
}

async function shutdownRuntime(signal: NodeJS.Signals): Promise<void> {
  if (shutdownInProgress) {
    return;
  }

  shutdownInProgress = true;
  console.log(`[shutdown] Received ${signal}, shutting down gracefully...`);

  getWebhookWorker().stop();
  // The sampler is already unref'd, so this is tidiness rather than a
  // requirement — it just stops starvation warnings from being emitted about a
  // process that is deliberately winding down and no longer serving traffic.
  stopEventLoopMonitor();
  // #3214. Also already unref'd, so this is tidiness — but it additionally stops
  // the watchdog opening a fresh probe connection while the pool is draining,
  // which would report `database-unreachable` about a process that is simply
  // shutting down.
  stopDbPoolHealthMonitor();
  if (auditRetryInterval) {
    clearInterval(auditRetryInterval);
    auditRetryInterval = null;
  }

  // Best-effort final drain of pending audit retries. Bounded by a hard
  // 5s timeout so a stuck DB doesn't block the rest of shutdown.
  const boundedAuditDrainTask = async () => {
    await Promise.race([
      drainAuditRetryQueue().then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  };

  // #3922: the LLM egress audit queue is in-process and fire-and-forget, so
  // anything still pending at SIGTERM is simply lost unless we wait for it.
  // Same 5s ceiling as the audit retry drain above — an unreachable database
  // must not turn a rolling restart into a hang. Runs in the `drain` phase,
  // which fully settles before the `db` phase closes the pool, so a pending
  // write no longer races the teardown; anything still outstanding at the 5s
  // ceiling is swallowed and reported by the recorder rather than failing
  // shutdown.
  const boundedLlmEgressDrainTask = async () => {
    await Promise.race([
      drainLlmEgressQueue(),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  };

  const dbCloseTask = async () => {
    const closeDb = dbModule.closeDb;
    if (typeof closeDb === 'function') {
      await closeDb();
    }
  };

  // wave 3.5d-b (#4086): the manually-curated shutdown list used to live
  // here. It is now sourced from the registry — an entry contributes a
  // shutdown task as soon as its module has been LOADED (registered before
  // its init() runs; see workerRegistry.ts's `runEntries`), so a worker whose
  // init() throws partway still gets torn down here. That matches the
  // pre-refactor static list, which called every one of its ~103 shutdown
  // fns unconditionally regardless of whether that worker's init had
  // succeeded. Only an entry that was never selected for this role (and so
  // never loaded at all) contributes nothing. Tasks still run concurrently
  // via `Promise.allSettled` inside the 'workers' phase below, so relative
  // order within the list carries no runtime significance.
  const workerShutdownTasks = await buildWorkerShutdownTasks(breezeRole());

  // Stop accepting requests BEFORE tearing down workers/Redis/DB. Otherwise a
  // heartbeat that arrives mid-shutdown hits an already-closed Postgres pool,
  // returns HTTP 500, and permanently wedges the agent's heartbeat loop
  // (cause of fleetwide false-offline after a restart).
  if (server) {
    const httpServer = server as unknown as import('http').Server;
    // Make readiness fail so any load balancer stops routing to us. The
    // evaluator short-circuits on `shutdownInProgress` (already set above);
    // dropping the cache too means no probe can be served a stale "ready".
    readiness.invalidate();
    httpServer.close();                 // stop accepting NEW connections
    if (typeof httpServer.closeIdleConnections === 'function') {
      httpServer.closeIdleConnections(); // drop idle keep-alive sockets now
    }
    // Bounded grace for in-flight requests to finish, then force-close stragglers
    // so server.close() can't hang on keep-alive connections.
    await new Promise<void>((resolve) =>
      setTimeout(resolve, envInt('SHUTDOWN_DRAIN_MS', 5000))
    );
    if (typeof httpServer.closeAllConnections === 'function') {
      httpServer.closeAllConnections();
    }
  }

  const report = await runShutdownPhases([
    // 1. Final local drains that need DB/Redis still up.
    { name: 'drain', tasks: [boundedAuditDrainTask, boundedLlmEgressDrainTask] },
    // 2. Every worker/consumer close — concurrent, as today, but now
    //    guaranteed to fully settle before shared infrastructure goes away.
    { name: 'workers', tasks: workerShutdownTasks },
    // 3. Producer queues + dispatchers (they enqueue INTO Redis; workers are gone).
    {
      name: 'queues',
      tasks: [
        shutdownEventDispatcher,
        shutdownEventDispatchWorker,
        shutdownEventDispatchQueue,
        shutdownAgentCommandRelayWorker,
      ],
    },
    // 4. Event bus releases its borrowed connection reference (no quit — Task 2).
    { name: 'eventbus', tasks: [async () => getEventBus().close()] },
    // 5. The ONLY owner of the Redis quits.
    { name: 'redis', tasks: [closeRedis] },
    // 6. DB pool.
    { name: 'db', tasks: [dbCloseTask] },
    // 7. Sentry flush (bounded internally at 2s).
    { name: 'sentry', tasks: [() => flushSentry()], timeoutMs: 5_000 },
  ]);
  const failed = report.failures.length > 0;
  const timedOutSuffix = report.timedOutPhases.length > 0
    ? ` (timed-out phase(s): ${report.timedOutPhases.join(', ')})`
    : '';
  if (failed) {
    console.error(`[shutdown] Completed with ${report.failures.length} failure(s)${timedOutSuffix}`);
  } else {
    console.log(`[shutdown] Complete${timedOutSuffix}`);
  }
  process.exit(failed ? 1 : 0);
}

function installSignalHandlers(): void {
  const onSignal = (signal: NodeJS.Signals) => {
    // Second signal while a graceful shutdown is running: operator (or
    // orchestrator) wants out NOW. Deterministic force-exit beats Node's
    // default handler ambiguity.
    process.once(signal, () => {
      console.error(`[shutdown] Second ${signal} — forcing exit`);
      process.exit(130);
    });
    void shutdownRuntime(signal);
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  // Guard against unhandled rejections from the Claude Agent SDK's
  // fire-and-forget handleControlRequest. When a session is closed while
  // an MCP tool is still in-flight, the SDK tries to write a response to
  // the dead subprocess and throws "ProcessTransport is not ready for writing".
  // This is a benign race condition — log it instead of crashing the process.
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
    // Attribution ADDS a culprit name to the log + Sentry tag ONLY. It does not
    // suppress or resolve the fault — the existing capture/telemetry behavior is
    // unchanged; we simply name the likely extension when its loaded code is in
    // the stack.
    const attributed = attributeExtensionError(reason, extensionRootsSnapshot());
    if (attributed) {
      console.error(`[FATAL] Unhandled rejection attributed to extension "${attributed}":`, reason);
    } else {
      console.error('[FATAL] Unhandled rejection:', reason);
    }
    captureException(
      reason instanceof Error ? reason : new Error(String(reason)),
      undefined,
      attributed ? { extension: attributed } : undefined,
    );
  });

  // #1379 B4 — a synchronous uncaughtException otherwise tears the process
  // down with no telemetry. Capture + flush before exit; reuse the benign
  // suppression list so SDK races don't crash us.
  process.on('uncaughtException', (err) => {
    if (isBenignRejection(err)) {
      console.warn('[SDK] Suppressed benign uncaught exception:', err.message);
      return;
    }
    // A dropped DB connection's orphaned buffered write (postgres@3) throws
    // outside every async frame. The driver already discards the connection
    // and reconnects, so surviving it keeps the API up instead of crash-
    // looping and logging out every active session on restart (#1105).
    if (isRecoverablePostgresConnectionTeardown(err)) {
      console.error('[db] Suppressed postgres connection-teardown write race; pool will reconnect (#1105):', err.message);
      captureException(err);
      return;
    }
    // Attribution ADDS a culprit name/tag ONLY — the crash path below (flush +
    // exit(1)) is preserved exactly so the supervisor still restarts us.
    const attributed = attributeExtensionError(err, extensionRootsSnapshot());
    if (attributed) {
      console.error(`[FATAL] Uncaught exception attributed to extension "${attributed}":`, err);
    } else {
      console.error('[FATAL] Uncaught exception:', err);
    }
    captureException(err, undefined, attributed ? { extension: attributed } : undefined);
    // Best-effort drain, then exit non-zero so the supervisor restarts us.
    void flushSentry().finally(() => process.exit(1));
  });
}

async function bootstrap(): Promise<void> {
  // Fail closed BEFORE any side-effectful step (wave 3.5d-b, #4086): this
  // binary (`dist/index.cjs`) is the api/all entrypoint. A worker-role
  // process must boot via `dist/worker.cjs` instead, which never imports the
  // route graph or agent-socket modules this file pulls in at the top.
  if (breezeRole() === 'worker') {
    console.error('[boot] BREEZE_ROLE=worker cannot run the API entrypoint (dist/index.cjs) — use dist/worker.cjs');
    process.exit(78); // EX_CONFIG
  }

  console.log(`Breeze API starting on port ${port}...`);

  // Initialize error reporting first so failures during the rest of startup
  // (migrations, seeds, self-tests) and the global onError/unhandledRejection
  // handlers are actually captured. No-op unless SENTRY_DSN is set.
  initSentry();

  // #3022 — start measuring event-loop lag immediately after Sentry, and before
  // migrations/startup checks, so a stall is observable for the whole life of
  // the process rather than only once it is serving traffic. The monitor is a
  // native histogram plus one unref'd interval; it holds nothing open and adds
  // no per-request work. Reports go to the console always, and to Sentry on a
  // throttle (a single stall produces a run of breaching samples, and this repo
  // has twice had an unthrottled recurring warning exhaust the event quota).
  const eventLoopMonitor = startEventLoopMonitor({
    onSample: createStarvationReporter({
      thresholdMs: getEventLoopStarvationThresholdMs,
      capture: (message, tags) =>
        captureMessage(message, { eventCode: 'event_loop_starvation', tags }),
    }),
  });
  // Say whether the instance can see its own loop, and at what settings. Without
  // this line a disabled or mistuned monitor is completely silent: every
  // CONNECT_TIMEOUT diagnosis degrades to "unknown" and the only other evidence
  // is a Prometheus series nobody is alerting on yet. Printing the effective
  // interval also makes a misparsed env var (parseInt('2s') === 2) visible.
  if (eventLoopMonitor) {
    // Both thresholds are printed because they can differ: the warn threshold is
    // the operator's knob, while CONNECT_TIMEOUT attribution caps it at the
    // connect budget so a raised warn value cannot mis-attribute a timeout.
    // Printing only the former would advertise 15000ms while diagnosis applied
    // 10000ms.
    console.log(
      `[event-loop] Lag monitor started (interval ${eventLoopMonitor.intervalMs}ms, `
      + `warn threshold ${getEventLoopStarvationThresholdMs()}ms, `
      + `CONNECT_TIMEOUT attribution threshold ${getConnectTimeoutStarvationThresholdMs()}ms)`,
    );
    // A sampling interval coarser than the warn threshold leaves a blind spot
    // one interval wide, which degrades every diagnosis in it to "unknown".
    if (eventLoopMonitor.intervalMs > getEventLoopStarvationThresholdMs()) {
      console.warn(
        `[event-loop] EVENT_LOOP_MONITOR_INTERVAL_MS (${eventLoopMonitor.intervalMs}ms) exceeds the `
        + `starvation threshold (${getEventLoopStarvationThresholdMs()}ms). Stalls shorter than one `
        + `sampling interval cannot be observed, so CONNECT_TIMEOUT causes will report "unknown" (#3022).`,
      );
    }
  } else {
    console.warn(
      '[event-loop] Lag monitor DISABLED via EVENT_LOOP_MONITOR_DISABLED — Postgres '
      + 'CONNECT_TIMEOUT errors will report cause "unknown" because starvation can be '
      + 'neither ruled in nor out (#3022).',
    );
  }

  // Inject the CONNECT_TIMEOUT classifier into the Sentry layer. It is wired
  // here rather than imported by services/sentry.ts so that module stays a leaf
  // — see setConnectTimeoutClassifier for the import-graph reason. Must follow
  // startEventLoopMonitor: before the monitor runs, every diagnosis correctly
  // reports 'unknown' rather than guessing.
  setConnectTimeoutClassifier(safeDiagnoseConnectTimeout);

  // Validate configuration before anything else — fail fast on missing/insecure secrets.
  // The validated config is stored as a singleton; retrieve later via getConfig().
  const config = validateConfig();

  // #3214 — pool-health watchdog.
  //
  // Ordering, both constraints: it must follow setConnectTimeoutClassifier
  // (nothing is counted until that is wired, so an earlier start would only give
  // it an empty window), and it must follow validateConfig — its probe builds a
  // connection URL straight from the environment, so starting first lets a short
  // interval fire a probe against unvalidated config and report the resulting
  // misconfiguration as a database fault.
  //
  // Steady-state cost is one unref'd timer tick; the fresh-connection probe opens
  // a socket only once the timeout rate has already breached the threshold.
  const dbPoolHealthIntervalMs = startDbPoolHealthMonitor();
  if (dbPoolHealthIntervalMs === null) {
    console.warn(
      '[db-pool-health] Watchdog DISABLED via DB_POOL_HEALTH_DISABLED — a poisoned '
      + 'postgres.js pool will decay silently until someone notices the 503s (#3214).',
    );
  } else {
    console.log(
      `[db-pool-health] Watchdog started (interval ${dbPoolHealthIntervalMs}ms, `
      + `window ${getDbPoolHealthWindowMs()}ms, probe threshold `
      + `${getDbPoolHealthMinTimeouts()} CONNECT_TIMEOUT(s) per window)`,
    );
  }

  await initializeDatabaseForStartup({
    autoMigrateEnabled: process.env.AUTO_MIGRATE !== 'false',
    production: config.NODE_ENV === 'production',
  });
  console.log(`[config] Validated: NODE_ENV=${config.NODE_ENV}, port=${config.API_PORT}`);
  if ((process.env.AGENT_BACKUP_SERVER_URL ?? '').trim()) {
    console.log(`[config] AGENT_BACKUP_SERVER_URL active: ${process.env.AGENT_BACKUP_SERVER_URL!.trim()}`);
  }
  // Say which way the break-glass switch actually landed. An operator who set
  // `off` in .env but never threaded it through the deployed compose file gets
  // the empty-string default (= enforce) and is still locked out, with nothing
  // in the logs explaining why. Compose drift is a documented failure mode here.
  if (config.IP_ALLOWLIST_ENFORCEMENT_MODE === 'off') {
    console.warn('[config] IP_ALLOWLIST_ENFORCEMENT_MODE=off — partner IP allowlists are GLOBALLY DISABLED (break-glass).');
  } else {
    console.log('[config] IP allowlist enforcement: enforce');
  }

  // Built-in (first-party, statically imported) extensions — the ONE extension
  // delivery path. Migration -> tenancy -> stage -> validate -> activate -> web
  // asset, with no artifact acquisition/verification: the code ships inside the
  // core image, which is its own supply-chain boundary. Core migrations already
  // ran (initializeDatabaseForStartup above). Any failure aborts boot —
  // built-ins are required code, not optional deployments.
  await loadBuiltinExtensions({
    registry: extensionContributionRegistry,
    stateStore: extensionStateStore,
  });

  try {
    await bootstrapPlatformAdmins();
  } catch (err) {
    console.error('[startup] Platform admin bootstrap failed (non-fatal):', err);
  }

  await runStartupChecks();

  // Initialize MCP bootstrap module. Loads auth tools (send_deployment_invites,
  // configure_defaults) so they are ready before the first request. The unauth
  // tools (create_tenant, verify_tenant, attach_payment_method) were deleted in
  // Phase 3; the IS_HOSTED startup check is also gone.
  await initMcpBootstrapForStartup();

  try {
    await runWithSystemDbAccess(async () => {
      await seedBuiltInPlaybooks();
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('relation "playbook_definitions" does not exist')) {
      console.warn('[startup] Playbook table not yet created — skipping seed (run migrations first)');
    } else {
      console.error('[startup] Failed to seed built-in playbooks:', err);
    }
  }

  try {
    await runWithSystemDbAccess(async () => {
      const ensured = await ensureSystemLibraryScripts();
      if (ensured.created > 0 || ensured.updated > 0) {
        console.log(
          `[startup] System script library ensured: ${ensured.created} created, ${ensured.updated} updated`
        );
      }
    });
  } catch (err) {
    console.error('[startup] Failed to ensure system script library:', err);
  }

  try {
    await runWithSystemDbAccess(async () => {
      const seeded = await seedDefaultAuditBaselines();
      if (seeded.created > 0) {
        console.log(`[startup] Seeded ${seeded.created} audit baseline template(s)`);
      }
    });
  } catch (err) {
    console.error('[startup] Failed to seed audit baseline templates:', err);
  }

  try {
    await runWithSystemDbAccess(async () => {
      const result = await backfillC2cConnectionSecrets();
      if (result.updated > 0) {
        console.log(`[startup] Encrypted C2C secrets for ${result.updated} connection(s)`);
      }
    });
  } catch (err) {
    console.error('[startup] Failed to backfill C2C connection secrets:', err);
  }

  // Register local agent binaries in DB and optionally sync to S3 (BINARY_SOURCE=local only)
  const binarySource = (process.env.BINARY_SOURCE || 'github').trim().toLowerCase();
  try {
    await runWithSystemDbAccess(async () => {
      await syncBinaries();
    });
  } catch (err) {
    if (binarySource === 'local') {
      console.error('[startup] Binary sync failed in BINARY_SOURCE=local mode (fatal):', err);
      throw err;
    }
    console.error('[startup] Binary sync failed (non-fatal in github mode):', err);
  }

  // Boot-time self-test for every deployment that signs its own update
  // manifests: round-trip a synthetic manifest through sign + validate. If this
  // fails, agent updates would silently 409 at runtime (#625). Fail fast so
  // operators see the problem during `docker compose up` rather than after
  // agents are stuck.
  //
  // BINARY_SOURCE=local has always signed locally. BYO signing added a second
  // such path: github mode against an OVERRIDDEN repository re-signs each
  // update manifest with the per-deployment key, so it depends on exactly this
  // machinery too. Without covering it, a BYO deployment with a rotated
  // APP_ENCRYPTION_KEY boots clean, reports healthy, and only fails later when
  // every re-sign throws mid-sync.
  const { isOfficialReleaseSource } = await import('./services/releaseSource');
  const signsOwnManifests =
    (process.env.BINARY_SOURCE || 'github').trim().toLowerCase() === 'local'
    || !isOfficialReleaseSource();
  if (signsOwnManifests) {
    try {
      const { runManifestSelfTest } = await import('./services/binarySync.selftest');
      await runWithSystemDbAccess(async () => {
        await runManifestSelfTest();
      });
    } catch (err) {
      console.error('[startup] Manifest signing self-test failed:', err);
      throw err;
    }
  }

  server = serve({
    fetch: app.fetch,
    port
  });

  injectWebSocket(server);

  console.log(`Breeze API running at http://localhost:${port}`);
  console.log(`WebSocket endpoint available at ws://localhost:${port}/api/v1/agent-ws/:id/ws`);

  // Explicit registration (wave 3.5d-b, #4086): the lazy worker registry only
  // loads `jobs/aiAgentRunner` for a process that runs global workers, so an
  // `api`-role process would never trigger the old module-scope side effect.
  // Must run before routes serve so the manual-trigger route always finds an
  // enqueuer registered, in every role.
  registerAiAgentEnqueuer();

  // Synchronous and MUST run before initializeWorkers(): the durable
  // subscriber registry (webhook fan-out, automation dispatch, notification
  // dispatch, policy alert bridge, DNS threat alerts) has to be fully
  // installed before the queue-mode dispatch worker — or any event published
  // during worker boot — can reach it (codex Q3 hole #2, #4085).
  registerAllEventSubscribers(buildWebhookFanoutDeps());

  await initializeWorkers();

  // Periodically retry failed audit writes. The in-process queue is bounded
  // (10k entries) and per-entry attempts are capped (3) with exponential
  // backoff, so a long DB outage degrades to Sentry-capture rather than
  // OOM. See `drainAuditRetryQueue` / `createAuditLogAsync` in
  // `services/auditService.ts`.
  auditRetryInterval = setInterval(() => {
    void drainAuditRetryQueue().catch((err) => {
      console.error('[audit-retry] drain failed:', err);
    });
  }, 30_000);
  // Don't keep the event loop alive just for this timer.
  auditRetryInterval.unref?.();

  installSignalHandlers();
}

void bootstrap().catch((error) => {
  console.error('[CRITICAL] API startup failed:', error);
  process.exit(1);
});
