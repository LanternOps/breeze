/**
 * Shared helpers for the W18 org-admin and identity read tools (full-control
 * W18, #6789). Inputs are validated against the same `.strict()` zod schemas
 * the MCP / Agent SDK surfaces are declared from. The SDK registers `.shape`,
 * which is not strict on its own: dispatch (`validateToolInput`) and the
 * handler's `parseInput` are what reject an unknown key, so keep both.
 */
import { z } from 'zod';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { jsonError } from './aiToolsSecurityPolicyShared';

export { bounded, deviceBoundDenied, jsonError, notFound, thrown } from './aiToolsSecurityPolicyShared';

/** The chat definition's input schema, rendered from the zod schema. */
export function orgAdminInputSchema(schema: z.ZodType): AiTool['definition']['input_schema'] {
  const { $schema: _schema, ...body } = z.toJSONSchema(schema, { io: 'input' });
  return body as AiTool['definition']['input_schema'];
}

/** Parse a tool input, or the VALIDATION_ERROR result naming the first problem. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): { ok: true; value: z.infer<S> } | { ok: false; error: string } {
  const parsed = schema.safeParse(input ?? {});
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  return { ok: false, error: jsonError(`${where}${issue?.message ?? 'Invalid input'}`, 'VALIDATION_ERROR') };
}

/** Organization summary, readiness and portal users are partner (or system) reads on REST. */
export function partnerScopeDenied(auth: AuthContext, what: string): string | null {
  return auth.scope !== 'partner' && auth.scope !== 'system'
    ? jsonError(`${what} is read at partner scope; an organization-scoped session cannot read it`, 'PARTNER_SCOPE_REQUIRED')
    : null;
}

/**
 * Full-control W16 PR B (#6786): a site- or device-restricted session is refused
 * outright. Stricter than `canMutateOrgWideGovernance`, which ignores `allowedSiteIds`
 * on a partner-scoped session: the Fleet Design routes refuse any permission set
 * carrying a site list, whatever its scope, and a release rebuilds that list live.
 */
export function restrictedSessionDenied(auth: AuthContext, what: string): string | null {
  return Array.isArray(auth.allowedSiteIds) || auth.allowedDeviceIds !== undefined
    ? jsonError(`${what} applies beyond one site or device; a site- or device-restricted session cannot use it`, 'ACCESS_DENIED')
    : null;
}

/** First `limit` rows plus the counts the model needs to know it saw a slice. */
export function capped<T>(rows: readonly T[], limit: number): { rows: T[]; showing: number; total: number; truncated: boolean } {
  const slice = rows.slice(0, limit);
  return { rows: slice, showing: slice.length, total: rows.length, truncated: rows.length > limit };
}
