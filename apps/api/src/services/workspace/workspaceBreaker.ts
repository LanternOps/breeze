/**
 * Execution plane W04 (R5, spec §9) — a per-backend circuit breaker over
 * sandbox CREATE.
 *
 * Scope is deliberately narrow: create failures only. An `exec` that fails is
 * the model's problem and is already a typed tool error; a `create` that
 * fails means the PROVIDER is unavailable, and every run admitted during that
 * window burns tokens orienting itself before dying at its first workspace
 * call. Five consecutive failures open the breaker for ten minutes and
 * admission refuses up front (`workspace_unavailable`).
 *
 * CONSECUTIVE, not cumulative: a single success deletes the counter, so a
 * healthy backend never drifts into the open state.
 *
 * Redis-backed because the decision has to be shared across every API worker
 * — a per-process counter would need five failures PER PROCESS. Every
 * function here is best-effort: with Redis down `isWorkspaceBreakerOpen`
 * reports NOT open, because the breaker is an availability optimisation and a
 * Redis outage must not take analysis down on its own. `WorkspaceService.
 * ensure()` still refuses for real if the provider really is broken.
 */
import { getRedis } from '../redis';
import { captureMessage } from '../sentry';

export const WORKSPACE_BREAKER_THRESHOLD = 5;
export const WORKSPACE_BREAKER_OPEN_SECONDS = 600;

function openKey(backend: string): string { return `breeze:ai:workspace:breaker:${backend}`; }
function failureKey(backend: string): string { return `${openKey(backend)}:failures`; }

function resolveDefaultBackend(): string {
  const raw = (process.env.AI_WORKSPACE_BACKEND ?? 'vercel').trim().toLowerCase();
  return raw.length > 0 ? raw : 'vercel';
}

export async function isWorkspaceBreakerOpen(backend = resolveDefaultBackend()): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    return (await redis.get(openKey(backend))) !== null;
  } catch (error) {
    console.warn('[workspaceBreaker] open check failed; treating as closed', { backend, error });
    return false;
  }
}

/** One create failure (`create_failed` or a provider quota refusal). */
export async function recordWorkspaceCreateFailure(backend: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    const failures = await redis.incr(failureKey(backend));
    // The counter itself expires, so an isolated failure a day apart never
    // accumulates into an open breaker.
    await redis.expire(failureKey(backend), WORKSPACE_BREAKER_OPEN_SECONDS);
    if (failures < WORKSPACE_BREAKER_THRESHOLD) return;
    await redis.set(openKey(backend), String(Date.now()), 'EX', WORKSPACE_BREAKER_OPEN_SECONDS);
    // Paged, not logged: an open breaker means NO analysis run can start in
    // this region, which is a customer-visible outage of the feature.
    captureMessage(
      `[workspaceBreaker] sandbox backend "${backend}" circuit opened after ${failures} consecutive create failures`,
      { eventCode: 'ai_workspace_breaker_open' },
    );
  } catch (error) {
    console.warn('[workspaceBreaker] failure record failed (non-fatal)', { backend, error });
  }
}

/** A successful create — clears the consecutive-failure run. */
export async function recordWorkspaceCreateSuccess(backend: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(failureKey(backend));
  } catch (error) {
    console.warn('[workspaceBreaker] success record failed (non-fatal)', { backend, error });
  }
}
