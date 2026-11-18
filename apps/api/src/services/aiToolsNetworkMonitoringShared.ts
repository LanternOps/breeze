/**
 * Shared helpers for the W09 SNMP / network-monitoring tools (full-control W09, #6779).
 *
 * Every tool is a thin adapter over the SAME exported services the REST routes
 * call. This module owns the three things each adapter needs:
 *  - `mfaDenied`: what substitutes for the routes' `requireMfa()` on a write
 *    (QW4 — permission parity is not MFA parity; MCP keys carry no MFA claim);
 *  - `restrictedCallerDenied`: a site- or device-restricted caller may not change
 *    org-wide shared state (SNMP templates), W09-D3;
 *  - `thrown` / `bounded`: a thrown error never reaches the model raw, and no
 *    single result may flood its context.
 */
import { hasSatisfiedMfa, type AuthContext } from '../middleware/auth';
import { sanitizeThrownToolError } from './aiToolErrors';
import { siteAllowlistOf } from './aiToolsSiteScope';
import { json, jsonError } from './aiToolsTicketOpsShared';

export { json, jsonError };

/** The most one result of these tools may hand the model. */
export const NETWORK_TOOL_MAX_BYTES = 96 * 1024;

/**
 * The write routes behind these tools all carry `requireMfa()`. Chat is MFA-gated at session entry; an MCP key has
 * no MFA claim, so a tier-2 write would otherwise be a bypass (see the MFA note in aiGuardrails.ts).
 * Returns an error result, or null when the session satisfies the effective MFA policy.
 */
export function mfaDenied(auth: AuthContext): string | null {
  return hasSatisfiedMfa(auth) ? null : jsonError('MFA required', 'MFA_REQUIRED');
}

/**
 * True when the caller is narrowed by site or by exact device. Org-wide shared rows (an SNMP template is read by
 * every device on it, in every site) are not theirs to edit — stricter than the REST route, by design (W09-D3).
 */
export function isRestrictedCaller(auth: AuthContext): boolean {
  return siteAllowlistOf(auth) !== undefined || auth.allowedDeviceIds !== undefined;
}

export function restrictedCallerDenied(auth: AuthContext, what: string): string | null {
  return isRestrictedCaller(auth)
    ? jsonError(`${what} is shared by every site in the organization; a site- or device-restricted session cannot change it`, 'ACCESS_DENIED')
    : null;
}

/** Map a thrown error to a result: logged once with the sanitizer, generic to the model. */
export function thrown(label: string, error: unknown): string {
  console.error(`[${label}]`, sanitizeThrownToolError(label, error));
  return jsonError('Operation failed. Check server logs for details.');
}

/** Serialise a read result, refusing one that would flood the model's context. */
export function bounded(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > NETWORK_TOOL_MAX_BYTES
    ? jsonError('Result too large; narrow the request (a smaller time range, fewer OIDs, or a search term).', 'result_too_large')
    : text;
}

/** Stored or device-supplied error text is data for the model, not a channel for whole vendor bodies: bound it. */
export function clip(value: unknown, max = 240): string | null {
  if (typeof value !== 'string' || value === '') return null;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Drop undefined keys so a shared schema sees only what the caller supplied. */
export function defined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** First missing required field, as a validation error result (or null). */
export function requireFields(input: Record<string, unknown>, fields: readonly string[], action: string): string | null {
  const missing = fields.filter((field) => input[field] === undefined || input[field] === null || input[field] === '');
  return missing.length
    ? jsonError(`${missing.join(', ')} required for ${action}`, 'VALIDATION_ERROR')
    : null;
}
