/**
 * B-W04 (#6158) runtime knobs for Tier-3 over MCP via action intents, read
 * per call. Kept out of config/env.ts on purpose: a dozen routes/mcpServer*
 * test suites replace that module with a narrow literal mock, and these are
 * read on the MCP request path. The parsing is identical to config/env's
 * envFlag / positiveIntEnv (same accepted vocabulary, same fallbacks);
 * config/validate.ts validates the raw values at boot.
 *
 * B-W06 (#6160) adds the Tasks flag and knobs here for the same reasons.
 */
import { mcpStatelessEnabled } from './mcpProtocol';

function mcpEnvFlag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function mcpPositiveIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw || !/^\d+$/.test(raw.trim())) return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/**
 * B-W04 (#6158, D-B37): kill switch for Tier-3 over MCP via action intents.
 * Off (the default in the release that ships it): Tier-3 tools/call keeps
 * today's MCP_APPROVAL_REQUIRED refusal byte-for-byte, nothing new is listed,
 * and a queued `mcp_api` intent is refused at release (`mcp_intents_disabled`).
 * get_action_status / cancel_action keep working either way. Read per call.
 */
export function mcpTier3IntentsEnabled(): boolean {
  return mcpEnvFlag('MCP_TIER3_INTENTS_ENABLED', false);
}

// positiveIntEnv treats 0 as invalid (falls back), so the wait knobs have a
// floor of 1 rather than 0; "no wait" is not expressible through the env.

/** Max live approval intents per MCP credential, across orgs (default 20). Read per call. */
export function mcpIntentMaxLivePerPrincipal(): number {
  return mcpPositiveIntEnv('MCP_INTENT_MAX_LIVE_PER_PRINCIPAL', 20, 1, 1_000);
}

/** Intent creations per MCP credential per hour (default 60). Read per call. */
export function mcpIntentCreatesPerHour(): number {
  return mcpPositiveIntEnv('MCP_INTENT_CREATES_PER_HOUR', 60, 1, 10_000);
}

/** Intent creations per requesting human per hour, across all their credentials (default 60). Read per call. */
export function mcpIntentCreatesPerUserPerHour(): number {
  return mcpPositiveIntEnv('MCP_INTENT_CREATES_PER_USER_PER_HOUR', 60, 1, 10_000);
}

/** Bounded wait (ms) for an approval outcome on a URL-elicitation retry (default 20000). Read per call. */
export function mcpApprovalWaitMs(): number {
  return mcpPositiveIntEnv('MCP_APPROVAL_WAIT_MS', 20_000, 1, 120_000);
}

/** Concurrent bounded approval waits per MCP credential (default 2). Read per call. */
export function mcpApprovalWaitsPerPrincipal(): number {
  return mcpPositiveIntEnv('MCP_APPROVAL_WAITS_PER_PRINCIPAL', 2, 1, 50);
}

/**
 * The Breeze web app origin approval links point at (`<APP>/approvals#intent-<id>`).
 * Same resolution as services/reportDelivery.ts.
 */
export function mcpAppBaseUrl(): string {
  return (process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL || 'http://localhost:4321').replace(/\/+$/, '');
}

/**
 * B-W06 (#6160, D-B55): the Tasks extension flag (default OFF). On its own it
 * does nothing — see mcpTasksEffective().
 */
export function mcpTasksEnabled(): boolean {
  return mcpEnvFlag('MCP_TASKS_ENABLED', false);
}

/**
 * B-W06 (#6160, D-B55): Tasks exist only in the stateless `2026-07-28` era, so
 * they are effective only when MCP_STATELESS_ENABLED is on too. Gates the
 * `server/discover` advertisement, `tasks/*` dispatch and the SEP-2243
 * `Mcp-Name` rule for `tasks/*`. Creating a task additionally needs
 * mcpTier3IntentsEnabled(); existing tasks stay readable and cancellable when
 * only intents are switched off. Read per call. config/validate.ts warns at
 * boot when the flag is on without stateless (a silent no-op otherwise).
 */
export function mcpTasksEffective(): boolean {
  return mcpTasksEnabled() && mcpStatelessEnabled();
}

/** Base poll interval (ms) for a task still waiting for approval (default 30000). Read per call. */
export function mcpTaskPendingPollIntervalMs(): number {
  return mcpPositiveIntEnv('MCP_TASK_PENDING_POLL_INTERVAL_MS', 30_000, 1_000, 600_000);
}

/** Base poll interval (ms) for an approved / executing task (default 5000). Read per call. */
export function mcpTaskPollIntervalMs(): number {
  return mcpPositiveIntEnv('MCP_TASK_POLL_INTERVAL_MS', 5_000, 1_000, 60_000);
}

/** Added to the approval window to form a task's ttlMs (default 1 h). Read per call. */
export function mcpTaskTtlGraceMs(): number {
  return mcpPositiveIntEnv('MCP_TASK_TTL_GRACE_MS', 3_600_000, 60_000, 86_400_000);
}

/**
 * The per-credential MCP message budget (`mcp:msg:<principal>`, default 120 /
 * min). The ONE reader: routes/mcpServer.ts's limiter and the Tasks poll-interval
 * budget (D-B52) both call it, so they can never disagree. Parsed exactly as
 * routes/mcpServer.ts's local envInt always parsed it (parseInt, fallback when
 * absent/empty/non-numeric), so moving the call site changes nothing. Read per call.
 */
export function mcpMessageRateLimitPerMinute(): number {
  const raw = process.env.MCP_MESSAGE_RATE_LIMIT_PER_MINUTE;
  if (!raw) return 120;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 120;
}
