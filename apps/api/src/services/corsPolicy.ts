/**
 * The app's CORS policy (moved out of index.ts so it is testable — B-W03
 * #6157, D-B23) plus the MCP `Origin` check.
 *
 * MCP Streamable HTTP requires an invalid `Origin` to be refused with 403.
 * The stateless `2026-07-28` era enforces that; the legacy era only counts it
 * this wave (Open Decision 4, default A: log-only, enforce in a follow-up
 * once 30 days of counts show which browser-hosted legacy clients exist).
 */
import type { Context } from 'hono';
import type { cors } from 'hono/cors';
import { createCorsOriginResolver } from './corsOrigins';

export const resolveCorsOrigin = createCorsOriginResolver({
  configuredOriginsRaw: process.env.CORS_ALLOWED_ORIGINS,
  nodeEnv: process.env.NODE_ENV,
});

export const CORS_ALLOW_HEADERS: readonly string[] = Object.freeze([
  'Content-Type',
  'Authorization',
  'X-Requested-With',
  'X-API-Key',
  'X-Breeze-CSRF',
  // MCP Streamable HTTP (both eras) + SEP-2243 routing headers.
  'MCP-Protocol-Version',
  'Mcp-Session-Id',
  'Mcp-Method',
  'Mcp-Name',
]);

export const CORS_EXPOSE_HEADERS: readonly string[] = Object.freeze([
  'Content-Length',
  'X-Request-Id',
  // Legacy MCP clients read the minted session id; OAuth clients read the
  // step-up challenge.
  'Mcp-Session-Id',
  'WWW-Authenticate',
]);

export const CORS_MIDDLEWARE_OPTIONS: Parameters<typeof cors>[0] = {
  origin: (origin) => resolveCorsOrigin(origin),
  credentials: true,
  allowHeaders: [...CORS_ALLOW_HEADERS],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  exposeHeaders: [...CORS_EXPOSE_HEADERS],
  maxAge: 86400,
};

// Legacy-era disallowed-Origin counter: one aggregated log line per window.
const LEGACY_ORIGIN_LOG_WINDOW_MS = 60_000;
let legacyRejectTotal = 0;
let legacyWindowStart = 0;
let legacyWindowCount = 0;

function countLegacyOriginReject(): void {
  legacyRejectTotal += 1;
  const now = Date.now();
  if (now - legacyWindowStart < LEGACY_ORIGIN_LOG_WINDOW_MS) {
    legacyWindowCount += 1;
    return;
  }
  // At most one line per window while it is happening; the running total is
  // what the "30 days of zero" enforcement decision reads from logs.
  console.warn('[MCP] legacy-era request with a disallowed Origin (log-only; enforcement is a follow-up)', {
    previousWindowCount: legacyWindowCount,
    totalSinceBoot: legacyRejectTotal,
  });
  legacyWindowStart = now;
  legacyWindowCount = 1;
}

/** Process-lifetime count of legacy-era requests whose Origin would be refused. */
export function mcpLegacyOriginRejectCount(): number {
  return legacyRejectTotal;
}

/**
 * Returns a 403 response for a stateless-era request whose present `Origin`
 * the app's CORS policy rejects; otherwise null. Legacy era: never refuses,
 * only counts.
 */
export function checkMcpOrigin(c: Context, era: 'legacy' | 'modern'): Response | null {
  const origin = c.req.header('Origin');
  if (!origin || resolveCorsOrigin(origin)) return null;
  if (era === 'legacy') {
    countLegacyOriginReject();
    return null;
  }
  // Id-less JSON-RPC error body, per the transport spec.
  return c.json({ jsonrpc: '2.0', error: { code: -32600, message: 'Origin not allowed' } }, 403);
}

/** Test-only. */
export function __resetMcpOriginCountersForTests(): void {
  legacyRejectTotal = 0;
  legacyWindowStart = 0;
  legacyWindowCount = 0;
}
