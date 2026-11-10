import { createHash } from 'node:crypto';
import { and, eq, isNotNull, isNull, or } from 'drizzle-orm';
import {
  PORTAL_ACCESS_POLICY_FIELDS,
  type PortalAccessPolicyRowValues,
  type PortalAccessPolicyValues,
  type PortalAccessPolicyView,
  type PortalPolicySource,
  type PortalSignInCapabilities,
} from '@breeze/shared';
import { getPortalEntraConfig } from '../config/portalEntra';
import { db, hasDbAccessContext, withSystemDbAccessContext } from '../db';
import { clientAiTenantMappings, organizations, portalAccessPolicies } from '../db/schema';

/**
 * Portal access policy resolver (portal registration W3 #11380; spec §4, §5.3).
 *
 * Partner default → org override, field by field, then masked by what the
 * deployment can run, then (W4 #11381, plan D2) Microsoft masked for an org
 * without a PROVEN Entra tenant, then the `sso_only` fallback. This module is
 * the ONLY resolver: portal auth calls {@link resolvePortalAccessPolicy} on
 * every session request, login, forgot-password and capability-token consume,
 * and the settings views/writes (portalAccessPolicyWrites.ts) build on the
 * same pick.
 *
 * No cache (plan D1): one indexed read over at most two rows per org, so a
 * policy write — or a tenant proof gained or lost — takes effect on the next
 * request on every API instance.
 */

/** Built-in defaults (spec §4): today's behaviour — password allowed, every new method off. */
export const PORTAL_ACCESS_POLICY_DEFAULTS: Readonly<PortalAccessPolicyValues> = Object.freeze<PortalAccessPolicyValues>({
  entraEnabled: false,
  googleEnabled: false,
  passwordMode: 'allowed',
  selfRegistrationMode: 'off',
  ssoNewPersonMode: 'approval',
  ssoSessionMaxHours: 12,
});

let capabilityOverride: PortalSignInCapabilities | null = null;

/**
 * What this deployment can run, read at call time:
 * - `entra`: the portal Entra app is configured (config/portalEntra.ts, W4). It
 *   returns null — never throws — while the client id or secret is unset; a
 *   malformed configured value fails boot (config/validate.ts), not a request.
 * - `google` (W7) and `selfRegistration` (W6) flip their own key.
 * The NODE_ENV=test override ({@link __testOnly}) takes precedence.
 */
export function getPortalSignInCapabilities(): PortalSignInCapabilities {
  if (capabilityOverride) return { ...capabilityOverride };
  return {
    entra: getPortalEntraConfig() !== null,
    google: false,
    selfRegistration: false,
  };
}

/** Test seam for the capability masks. Refuses outside NODE_ENV=test so production can never widen them. */
export const __testOnly = {
  setCapabilities(caps: PortalSignInCapabilities | null): void {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('portalAccessPolicy.__testOnly.setCapabilities is only available when NODE_ENV=test');
    }
    capabilityOverride = caps ? { ...caps } : null;
  },
};

export type PortalAccessPolicyEffective = PortalAccessPolicyView['effective'];

/**
 * Facts about the org that the policy rows cannot carry (W4 #11381, plan D2).
 * Partner views and partner would-be-effective computations pass
 * `{ entraTenantProven: true }`: the partner default means "on wherever a
 * tenant is proven".
 */
export interface PortalPolicyOrgFacts {
  /** The org's Entra tenant mapping carries a proof (spec §5.4). Microsoft is masked off without it. */
  entraTenantProven: boolean;
}

export interface ResolvedPortalAccessPolicy {
  orgId: string;
  partnerId: string;
  effective: PortalAccessPolicyEffective;
  passwordModeFallback: boolean;
  /**
   * sha256 hex of the canonical JSON of the effective values and the proven
   * tenant id (W6 binds self-registration tokens to it, so they die when the
   * policy or the proven tenant changes).
   */
  fingerprint: string;
  /** The org's PROVEN Entra tenant, or null (W4 D2; Entra sessions are pinned to it, D9). */
  entraTenant: { tenantId: string; provenAt: string } | null;
}

interface Picked<T> { value: T; source: PortalPolicySource }

function pickValue<T>(org: T | null | undefined, partner: T | null | undefined, fallback: T): Picked<T> {
  // `!= null`, not truthiness: an org `false` is a value that beats a partner `true`.
  if (org != null) return { value: org, source: 'org' };
  if (partner != null) return { value: partner, source: 'partner' };
  return { value: fallback, source: 'default' };
}

/**
 * Canonical form: the six effective values in PORTAL_ACCESS_POLICY_FIELDS order,
 * then the proven tenant id (null when none). Sources are not policy.
 */
function fingerprintOf(effective: PortalAccessPolicyEffective, entraTenantId: string | null): string {
  const canonical = JSON.stringify({
    ...Object.fromEntries(PORTAL_ACCESS_POLICY_FIELDS.map((f) => [f, effective[f].value])),
    entraTenantId,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Pure field-by-field inheritance (exported for unit tests and the settings views).
 * 1. pick: org beats partner beats default, with `!= null`;
 * 2. mask what the deployment cannot run (the source stays the picked source);
 * 3. mask Microsoft for an org whose Entra tenant is not proven (W4 D2; source kept);
 * 4. `sso_only` holds only while an SSO method is effectively on, else `allowed`
 *    with `passwordModeFallback` (spec §4).
 *
 * The facts carry no tenant id, so this fingerprint is the no-tenant one;
 * {@link resolvePortalAccessPolicy} adds the proven tenant id to its own.
 */
export function pickEffectivePortalAccessPolicy(
  org: PortalAccessPolicyRowValues | null,
  partner: PortalAccessPolicyRowValues | null,
  caps: PortalSignInCapabilities,
  facts: PortalPolicyOrgFacts,
): Pick<ResolvedPortalAccessPolicy, 'effective' | 'passwordModeFallback' | 'fingerprint'> {
  const d = PORTAL_ACCESS_POLICY_DEFAULTS;
  const entra = pickValue(org?.entraEnabled, partner?.entraEnabled, d.entraEnabled);
  const google = pickValue(org?.googleEnabled, partner?.googleEnabled, d.googleEnabled);
  const password = pickValue(org?.passwordMode, partner?.passwordMode, d.passwordMode);
  const selfRegistration = pickValue(org?.selfRegistrationMode, partner?.selfRegistrationMode, d.selfRegistrationMode);
  const ssoNewPersonMode = pickValue(org?.ssoNewPersonMode, partner?.ssoNewPersonMode, d.ssoNewPersonMode);
  const ssoSessionMaxHours = pickValue(org?.ssoSessionMaxHours, partner?.ssoSessionMaxHours, d.ssoSessionMaxHours);

  const entraEnabled = { value: entra.value && caps.entra && facts.entraTenantProven, source: entra.source };
  const googleEnabled = { value: google.value && caps.google, source: google.source };
  const selfRegistrationMode = {
    value: caps.selfRegistration ? selfRegistration.value : 'off' as const,
    source: selfRegistration.source,
  };

  const anySso = entraEnabled.value || googleEnabled.value;
  const passwordMode = {
    value: password.value === 'sso_only' && anySso ? 'sso_only' as const : 'allowed' as const,
    source: password.source,
  };
  const passwordModeFallback = password.value === 'sso_only' && !anySso;

  const effective: PortalAccessPolicyEffective = {
    entraEnabled, googleEnabled, passwordMode, selfRegistrationMode, ssoNewPersonMode, ssoSessionMaxHours,
  };
  return { effective, passwordModeFallback, fingerprint: fingerprintOf(effective, null) };
}

type PolicyRowLike = { [K in keyof PortalAccessPolicyRowValues]?: PortalAccessPolicyRowValues[K] | null | undefined };

/** The six policy fields of a stored row (anything absent reads as null = inherit). */
export function toPortalAccessPolicyRowValues(row: PolicyRowLike): PortalAccessPolicyRowValues {
  return {
    entraEnabled: row.entraEnabled ?? null,
    googleEnabled: row.googleEnabled ?? null,
    passwordMode: row.passwordMode ?? null,
    selfRegistrationMode: row.selfRegistrationMode ?? null,
    ssoNewPersonMode: row.ssoNewPersonMode ?? null,
    ssoSessionMaxHours: row.ssoSessionMaxHours ?? null,
  };
}

export interface PortalAccessPolicyOwnerRows {
  org: PortalAccessPolicyRowValues | null;
  partner: PortalAccessPolicyRowValues | null;
}

/**
 * The org override (when `orgId` is given) and the partner default, in ONE query,
 * under whatever DB context the caller holds. RLS lets an org-scoped context read
 * its partner's default through `portal_access_policies_org_member_select` (D7).
 */
export async function readPortalAccessPolicyRows(args: { orgId: string | null; partnerId: string }): Promise<PortalAccessPolicyOwnerRows> {
  const partnerDefault = and(isNull(portalAccessPolicies.orgId), eq(portalAccessPolicies.partnerId, args.partnerId));
  const rows = await db.select({
    orgId: portalAccessPolicies.orgId,
    partnerId: portalAccessPolicies.partnerId,
    entraEnabled: portalAccessPolicies.entraEnabled,
    googleEnabled: portalAccessPolicies.googleEnabled,
    passwordMode: portalAccessPolicies.passwordMode,
    selfRegistrationMode: portalAccessPolicies.selfRegistrationMode,
    ssoNewPersonMode: portalAccessPolicies.ssoNewPersonMode,
    ssoSessionMaxHours: portalAccessPolicies.ssoSessionMaxHours,
  }).from(portalAccessPolicies)
    .where(args.orgId ? or(eq(portalAccessPolicies.orgId, args.orgId), partnerDefault) : partnerDefault);
  const org = args.orgId ? rows.find((r) => r.orgId === args.orgId) : undefined;
  const partner = rows.find((r) => r.orgId === null && r.partnerId === args.partnerId);
  return {
    org: org ? toPortalAccessPolicyRowValues(org) : null,
    partner: partner ? toPortalAccessPolicyRowValues(partner) : null,
  };
}

/** The org does not exist, or the held DB context cannot see it. Portal auth treats this as a refused session. */
export class PortalAccessPolicyOrgNotFoundError extends Error {
  constructor(readonly orgId: string) {
    super('Organization not found for portal access policy');
    this.name = 'PortalAccessPolicyOrgNotFoundError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The effective portal access policy for one org.
 *
 * Reads `organizations.partner_id` (no `deleted_at` filter: the org gates own
 * that decision) with the org's PROVEN tenant mapping LEFT JOINed on (W4 D2:
 * no extra round trip, and not joined onto the policy-rows query, which returns
 * nothing for an org without rows), then both policy rows in one query. With no
 * DB context held (public portal routes, the session middleware's post-hydration
 * checks) it opens its own system context; otherwise it reads under the held
 * context, which RLS lets see both rows (D7) and the org's own mapping (shape 1).
 * It never leaves a held context.
 */
export async function resolvePortalAccessPolicy(orgId: string): Promise<ResolvedPortalAccessPolicy> {
  // A malformed id would raise 22P02 and poison a held transaction; it names no org.
  if (!UUID_RE.test(orgId)) throw new PortalAccessPolicyOrgNotFoundError(orgId);

  const read = async () => {
    const [org] = await db.select({
      partnerId: organizations.partnerId,
      entraTenantId: clientAiTenantMappings.entraTenantId,
      entraTenantProvenAt: clientAiTenantMappings.provenAt,
    })
      .from(organizations)
      .leftJoin(clientAiTenantMappings, and(
        eq(clientAiTenantMappings.orgId, organizations.id),
        isNotNull(clientAiTenantMappings.provenAt),
      ))
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) throw new PortalAccessPolicyOrgNotFoundError(orgId);
    const rows = await readPortalAccessPolicyRows({ orgId, partnerId: org.partnerId });
    return { org, rows };
  };
  const { org, rows } = hasDbAccessContext()
    ? await read()
    : await withSystemDbAccessContext(read, 'portalAccessPolicy.resolve');

  const entraTenant = org.entraTenantId && org.entraTenantProvenAt
    ? { tenantId: org.entraTenantId, provenAt: org.entraTenantProvenAt.toISOString() }
    : null;
  const picked = pickEffectivePortalAccessPolicy(
    rows.org, rows.partner, getPortalSignInCapabilities(), { entraTenantProven: entraTenant !== null },
  );
  return {
    orgId,
    partnerId: org.partnerId,
    effective: picked.effective,
    passwordModeFallback: picked.passwordModeFallback,
    fingerprint: fingerprintOf(picked.effective, entraTenant?.tenantId ?? null),
    entraTenant,
  };
}

export type PortalSignInMethod = 'password' | 'entra' | 'google';

/** Whether the effective policy lets `method` sign in at all (the account's own gates are separate). */
export function isSignInMethodAllowed(
  policy: Pick<ResolvedPortalAccessPolicy, 'effective'>,
  method: PortalSignInMethod,
): boolean {
  switch (method) {
    case 'password': return policy.effective.passwordMode.value === 'allowed';
    case 'entra': return policy.effective.entraEnabled.value;
    case 'google': return policy.effective.googleEnabled.value;
    // Unknown runtime value (a forged or future session method): fail closed.
    default: return false;
  }
}
