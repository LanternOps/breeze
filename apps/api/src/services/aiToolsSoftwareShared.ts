/**
 * Shared helpers for the W12 software, fleet-finding and custom-field tools
 * (full-control W12, #6782). The W11 helpers (`auditToolWrite`, `bounded`,
 * `notFound`, `orgWideWriteDenied`, ...) are re-used as-is; this module adds
 * the two rules W12 needs on top:
 *
 *  - `verifiedUserIdOrNull` (W12-D3): every users-FK column a W12 write fills
 *    (`software_deployments.created_by`, `software_policies.created_by`,
 *    config-policy `created_by` / `assigned_by`, `fleet_findings.acknowledged_by`
 *    / `dismissed_by`) is nullable. The tool writes the caller's id only when it
 *    IS a `users` row and NULL otherwise (an agent principal), so an approved
 *    agent proposal releases under the agent's OWN auth (its site / device
 *    ceiling holds) and can never fail a release with a 23503. The AI actor is
 *    in the audit row either way.
 *  - `httpResult`: the extracted route services return `{ status, body }`; a
 *    2xx body goes to the model as-is (bounded), anything else becomes the
 *    tool's coded error without leaking a raw status.
 */
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { users } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { bounded, jsonError } from './aiToolsSecurityPolicyShared';

export {
  auditToolWrite, bounded, clip, defined, deviceBoundDenied, json, jsonError, notFound, orgWideWriteDenied,
  requireFields, str, thrown,
} from './aiToolsSecurityPolicyShared';

/** W12-D3: the caller's id when it is a `users` row, else NULL (agent principals, synthetic flow ids). */
export async function verifiedUserIdOrNull(auth: Pick<AuthContext, 'user'>): Promise<string | null> {
  const candidate = auth.user?.id;
  if (!candidate) return null;
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, candidate)).limit(1);
      return row?.id ?? null;
    }),
  );
}

const STATUS_CODES: Readonly<Record<number, string>> = {
  400: 'VALIDATION_ERROR',
  403: 'ACCESS_DENIED',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'VALIDATION_ERROR',
  503: 'UNAVAILABLE',
};

/** Map an extracted route service's `{ status, body }` to the tool's answer. */
export function httpResult(result: { status: number; body: unknown }): string {
  if (result.status >= 200 && result.status < 300) return bounded(result.body);
  const body = result.body as { error?: unknown } | null;
  const message = typeof body?.error === 'string' ? body.error : `Request failed (${result.status})`;
  return jsonError(message, STATUS_CODES[result.status] ?? 'FAILED');
}

/** Clamp a model-supplied limit into [1, max], defaulting to `fallback`. */
export function clampLimit(value: unknown, fallback: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

export function clampOffset(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
