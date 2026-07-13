import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { oauthGrants } from '../db/schema';
import { getGrantBreezeMeta } from './adapter';
import { getPartnerScopePolicy } from './partnerScopePolicy';
import { ERROR_IDS, logOauthError } from './log';

const asSystem = <T>(fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn));

// Master list of MCP scopes this provider knows how to issue. The single
// source of truth lives here (not provider.ts) so this module never has to
// import provider.ts — provider.ts imports it back and re-exports it for
// backward compatibility. Any scope added here must also be added to the
// `scopes:` array in provider.ts's Provider config.
export const ALL_MCP_SCOPES = ['mcp:read', 'mcp:write', 'mcp:execute'] as const;

export interface OAuthGrantContext {
  grantId: string;
  partnerId: string;
  orgId: string | null;
}

/**
 * A Grant row exists but carries no durable partner tenancy. This can only
 * legitimately happen for a brief instant between `Grant.save()` and the
 * consent route's `setGrantBreezeMeta()` write completing — any resolution
 * attempted after that point (in particular a resource-server scope
 * calculation for token mint or refresh) must fail closed rather than mint
 * a token with unknown/unbounded tenancy. This is the MCP-OAUTH-02 bug.
 */
export class GrantTenancyError extends Error {
  constructor(message = 'OAuth grant has no durable partner tenancy') {
    super(message);
    this.name = 'GrantTenancyError';
  }
}

/**
 * The single authoritative source of a Grant's durable tenancy.
 *
 * Fast path: the in-memory `grantBreezeMeta` cache populated by the consent
 * route (same-process, warm). On a cache miss (e.g. a different process, or
 * an API restart between consent and the next token/refresh exchange) this
 * loads the `oauth_grants` row directly — that row is written durably by
 * `setGrantBreezeMeta` before the consent route ever resumes the
 * interaction, so it is authoritative regardless of process lifetime.
 *
 * Returns `null` only when the grant row itself does not exist (e.g. it was
 * cleaned up / never created — not a tenancy failure). Throws
 * `GrantTenancyError` when the row exists but its `partner_id` column is
 * NULL — that state means tenancy was never durably recorded, and callers
 * (token/refresh minting) MUST fail closed rather than treat it as "no
 * partner restriction" (the -02 bug: a null partner silently granted every
 * MCP scope after a restart cleared the process-local cache).
 */
export async function resolveGrantContext(grantId: string): Promise<OAuthGrantContext | null> {
  const cached = getGrantBreezeMeta(grantId);
  if (cached) {
    return { grantId, partnerId: cached.partner_id, orgId: cached.org_id };
  }

  let row: { partnerId: string | null; orgId: string | null } | undefined;
  try {
    row = await asSystem(async () => {
      const [r] = await db
        .select({ partnerId: oauthGrants.partnerId, orgId: oauthGrants.orgId })
        .from(oauthGrants)
        .where(eq(oauthGrants.id, grantId))
        .limit(1);
      return r;
    });
  } catch (err) {
    logOauthError({
      errorId: ERROR_IDS.OAUTH_GRANT_META_LOOKUP_FAILED,
      message: 'DB lookup for Grant tenancy failed in resolveGrantContext',
      err,
      context: { grantId },
    });
    throw err;
  }

  if (!row) return null;

  if (!row.partnerId) {
    logOauthError({
      errorId: ERROR_IDS.OAUTH_GRANT_TENANCY_MISSING,
      message: 'OAuth grant exists but has no durable partner tenancy; refusing to compute scopes',
      err: new Error(`grant ${grantId} has NULL partner_id`),
      context: { grantId },
    });
    throw new GrantTenancyError(`OAuth grant ${grantId} has no durable partner tenancy`);
  }

  return { grantId, partnerId: row.partnerId, orgId: row.orgId };
}

/**
 * The single authoritative effective-MCP-scope calculation. Intersects:
 *
 *   1. `ALL_MCP_SCOPES` (every scope this provider knows how to issue);
 *   2. `requested` (the client's/grant's own scope set — callers passing no
 *      `displayed` set must pass an already-authoritative set here, not a
 *      raw untrusted request parameter);
 *   3. `displayed`, when provided (what the consent UI actually showed the
 *      user — never grant more than what was displayed); and
 *   4. the selected partner's current `mcp_allowed_scopes` policy.
 *
 * Fail-closed rules (design §Error Handling):
 *   - `partnerId === null` with `hasGrant === true` throws `GrantTenancyError`
 *     — an existing grant's tenancy must always be resolvable; "unknown"
 *     must never silently mean "all scopes".
 *   - `partnerId === null` with `hasGrant === false` is the documented
 *     legacy behavior for a grantless, client-only flow (e.g. the initial
 *     `/oauth/auth` resource-indicator check before any Grant exists) — no
 *     partner policy applies, so the result is simply the provider ∩
 *     requested ∩ displayed intersection.
 *   - A partner policy lookup failure (`getPartnerScopePolicy` rejecting)
 *     propagates to the caller rather than being swallowed into a scope
 *     fallback. (In practice `getPartnerScopePolicy` itself fails closed by
 *     returning `{ mcp_allowed_scopes: [] }` on a DB error rather than
 *     throwing — this function must not add a second, looser safety net on
 *     top of that by catching and reinterpreting a thrown error.)
 */
export async function computeEffectiveMcpScopes(args: {
  requested: string[];
  displayed?: string[];
  partnerId: string | null;
  hasGrant: boolean;
}): Promise<string[]> {
  const { requested, displayed, partnerId, hasGrant } = args;

  if (partnerId === null) {
    if (hasGrant) {
      throw new GrantTenancyError(
        'OAuth grant is present but partner tenancy could not be resolved; refusing to compute MCP scopes',
      );
    }
    // Grantless client-only flow with no partner context resolvable at all
    // (documented legacy behavior — see design §1): no policy to apply.
    const base = displayed === undefined ? requested : requested.filter((s) => displayed.includes(s));
    return ALL_MCP_SCOPES.filter((s) => base.includes(s));
  }

  const policy = await getPartnerScopePolicy(partnerId);
  const whitelist = policy.mcp_allowed_scopes;

  let allowed = ALL_MCP_SCOPES.filter((s) => requested.includes(s));
  if (displayed !== undefined) allowed = allowed.filter((s) => displayed.includes(s));
  if (whitelist) allowed = allowed.filter((s) => whitelist.includes(s));
  return allowed;
}
