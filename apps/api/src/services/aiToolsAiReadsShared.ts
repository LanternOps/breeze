/**
 * Shared helpers for the W10 AI-agent read tools (full-control W10, #6780).
 *
 * Every tool is a thin adapter over the same exported services the REST
 * routes call. Three rules live here so no adapter can drift from them:
 *  - a miss, a foreign-org id, a hidden-site device and a malformed id are ONE
 *    answer with ONE body (W10-D6): the routes' 403 vs 404 split would let a
 *    caller fingerprint ids;
 *  - org-wide records (operator tasks, fleet designs) are refused to a site- or
 *    device-restricted session (W10-D5, quorum QW2);
 *  - a thrown error never reaches the model raw, and no single result may
 *    flood its context.
 */
import type { AuthContext } from '../middleware/auth';
import { bounded, clip, isRestrictedCaller, json, jsonError, thrown } from './aiToolsNetworkMonitoringShared';

export { bounded, clip, json, jsonError, thrown };

/** The single "not found" answer, identical for every reason the row is unreachable. */
export function notFound(what: string): string {
  return jsonError(`${what} not found or access denied`, 'NOT_FOUND');
}

/**
 * Operator tasks and Fleet Designs describe the whole organization (a task's
 * device targets and a design's device functions span every site), so a
 * site- or device-restricted session gets none of it. Stricter than REST, by
 * design (plan facts 5 and 6).
 */
export function restrictedReadDenied(auth: AuthContext, what: string): string | null {
  return isRestrictedCaller(auth)
    ? jsonError(`${what} cover the whole organization; a site- or device-restricted session cannot read them`, 'ACCESS_DENIED')
    : null;
}

/** Clamp a model-supplied integer into [1, max], defaulting when absent or not a finite number. */
export function clampInt(raw: unknown, def: number, max: number): number {
  const n = Math.trunc(Number(raw));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
