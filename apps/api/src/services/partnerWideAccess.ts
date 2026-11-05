/**
 * Partner-wide administration capability (epic #2135).
 *
 * Partner-wide ("all organizations") state — configuration policies, software
 * policy templates, and every future dual-ownership table — pushes config to
 * EVERY org under the partner, including orgs created later. Only full-partner
 * admins (partner_users.org_access = 'all') and system scope may create or
 * modify it.
 *
 * This is a deliberately dependency-free leaf module (types only) so routes,
 * services, workers, and AI tools can all import the ONE capability check
 * without pulling in the configurationPolicy service graph — test files that
 * mock db/schema stay unaffected. configurationPolicy re-exports these for
 * back-compat.
 */
import type { AuthContext } from '../middleware/auth';

/**
 * True when the caller may create/modify partner-wide state. Contexts that
 * never resolved a partner membership (org scope, agent, helper, MCP keys)
 * have no partnerOrgAccess and fail closed (MCP stops offering the tools this
 * makes dead: PARTNER_WIDE_ONLY_TOOLS below, #10930). Deliberately NOT derivable from
 * accessibleOrgIds: a 'selected' user whose selection happens to cover every
 * current org still must not administer partner-wide state.
 */
export function canManagePartnerWidePolicies(
  auth: Pick<AuthContext, 'scope' | 'partnerOrgAccess'>
): boolean {
  return auth.scope === 'system' || (auth.scope === 'partner' && auth.partnerOrgAccess === 'all');
}

/**
 * Returned by every `canManagePartnerWidePolicies` gate, so it is deliberately
 * resource-agnostic: the gate also guards partner-wide state that is not a policy —
 * partner login branding (`routes/partnerLoginBranding.ts`) returns it today, and more
 * non-policy surfaces will. A route that wants resource-specific wording should return
 * its own string rather than widening this one.
 */
export const PARTNER_WIDE_WRITE_DENIED_MESSAGE =
  'Managing partner-wide state requires full partner org access (orgAccess must be "all")';

/**
 * Returned by partner-wide READ models gated on `canManagePartnerWidePolicies`
 * (the partner settings inheritance counts and drill-down, #9170). The write
 * message above describes a write, so a fleet-analysis read gets its own.
 */
export const PARTNER_WIDE_READ_DENIED_MESSAGE =
  'Viewing the organization breakdown requires full partner org access (orgAccess must be "all")';

/**
 * AI tools whose handler refuses EVERY invocation unless
 * `canManagePartnerWidePolicies(auth)` holds (#10930). An MCP credential's
 * context (`buildAuthFromApiKey`) never carries `partnerOrgAccess`, by design,
 * so over MCP these tools are dead: `tools/list` does not offer them and
 * `tools/call` refuses them before the handler with
 * {@link PARTNER_WIDE_UNAVAILABLE_OVER_MCP_MESSAGE}. The handler's own gate
 * stays the authority; this list only stops advertising a tool it would refuse.
 *
 * - `any_scope`: refused for every caller without full partner access
 *   (an org-scope caller is refused too, by scope or by the gate).
 * - `partner_scope`: the gate applies only at partner scope; an org-scope
 *   caller has its own path through the tool.
 *
 * A tool with only SOME partner-wide actions or rows (manage_patches approve,
 * manage_update_rings create) is not listed here: its other actions work.
 * partnerWideOnlyTools.contract.test.ts runs every registered handler and
 * fails when this list and the handlers disagree, in either direction.
 */
export const PARTNER_WIDE_ONLY_TOOLS: ReadonlyMap<string, 'any_scope' | 'partner_scope'> = new Map([
  ['get_partner_settings_inheritance', 'any_scope'],
  ['get_pax8_status', 'any_scope'],
  ['manage_pax8_subscriptions', 'any_scope'],
  ['manage_accounting_sync', 'any_scope'],
  ['manage_known_guests', 'any_scope'],
  ['get_unifi_status', 'any_scope'],
  ['trigger_unifi_sync', 'any_scope'],
  ['manage_ticket_inbox', 'any_scope'],
  ['manage_ticket_response_templates', 'any_scope'],
  ['sync_edr_data', 'any_scope'],
  ['manage_access_reviews', 'partner_scope'],
]);

/** True when this caller can never get past `toolName`'s partner-wide gate (see {@link PARTNER_WIDE_ONLY_TOOLS}). */
export function partnerWideGateRefusesTool(
  toolName: string,
  auth: Pick<AuthContext, 'scope' | 'partnerOrgAccess'>,
): boolean {
  const applies = PARTNER_WIDE_ONLY_TOOLS.get(toolName);
  if (!applies || canManagePartnerWidePolicies(auth)) return false;
  return applies === 'any_scope' || auth.scope === 'partner';
}

/**
 * The one refusal an MCP caller gets for partner-wide state (#10930): the
 * pre-handler refusal of a {@link PARTNER_WIDE_ONLY_TOOLS} tool, and the
 * rewrite of a mixed tool's partner-wide refusal. It names the connection as
 * the reason, because the other messages ("orgAccess must be \"all\"") send a
 * full-access partner admin looking for access they already have.
 */
export const PARTNER_WIDE_UNAVAILABLE_OVER_MCP_MESSAGE =
  'Partner-wide state is not available over MCP or API-key connections: they never carry full partner org access, '
  + 'whatever access your own account has. Use the Breeze web app AI assistant, signed in as a user with full partner org access.';

/** Thrown by service mutators when a partner-wide row is visible to the caller but not administrable. Routes map it to 403. */
export class PartnerWideWriteDeniedError extends Error {
  constructor() {
    super(PARTNER_WIDE_WRITE_DENIED_MESSAGE);
    this.name = 'PartnerWideWriteDeniedError';
  }
}

/**
 * Identity a partner-wide READ gate needs. Deliberately structural (scope as a
 * plain string) so route-local AuthContext shapes — e.g.
 * `routes/policyManagement/schemas.ts` — can pass without a cast.
 */
export type PartnerWideReadAuth = {
  scope: string;
  partnerId: string | null;
};

/**
 * True when `auth` may READ partner-wide rows (org_id NULL) owned by
 * `ownerPartnerId`.
 *
 * Org-scoped tokens carry a partnerId (`middleware/auth.ts` feeds it into
 * `DbAccessContext.currentPartnerId` for every org user), so an app-layer
 * condition of the shape `org_id IS NULL AND partner_id = auth.partnerId`
 * matches for a plain org user. RLS does NOT catch that: the partner-wide
 * SELECT branch (`org_id IS NULL AND partner_id =
 * breeze_current_partner_id()`) deliberately makes those rows readable from an
 * org context — it is load-bearing for agent config delivery. On background
 * worker paths the read is system-scoped and unfiltered anyway.
 *
 * So on these paths the app-layer gate is the ONLY authorization control on
 * the partner axis, not a redundant second one (#4952). Use it wherever a
 * dual-axis read decides what a caller may act on, and mirror it on the loaded
 * row where the consequence is execution rather than display.
 *
 * `null`/absent auth means "no request identity" — the background/system path,
 * which is genuinely allowed to see partner-wide rows.
 */
export function canReadPartnerWideRows(
  auth: PartnerWideReadAuth | null | undefined,
  ownerPartnerId: string | null | undefined
): boolean {
  if (!auth) return true;
  if (auth.scope === 'system') return true;
  return (
    auth.scope === 'partner' &&
    !!auth.partnerId &&
    !!ownerPartnerId &&
    auth.partnerId === ownerPartnerId
  );
}
