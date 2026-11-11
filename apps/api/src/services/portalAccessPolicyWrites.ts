import { isNotNull } from 'drizzle-orm';
import {
  PORTAL_ACCESS_POLICY_ERROR_CODES,
  PORTAL_ACCESS_POLICY_FIELDS,
  portalAccessPolicyPatchSchema,
  type PortalAccessPolicyErrorCode,
  type PortalAccessPolicyField,
  type PortalAccessPolicyRowValues,
  type PortalAccessPolicyView,
  type PortalPolicySource,
  type PortalSignInCapabilities,
} from '@breeze/shared';
import { db, withDbTransaction } from '../db';
import { portalAccessPolicies } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { canManagePartnerWidePolicies, PartnerWideWriteDeniedError } from './partnerWideAccess';
import {
  getPortalSignInCapabilities,
  pickEffectivePortalAccessPolicy,
  readPortalAccessPolicyRows,
  toPortalAccessPolicyRowValues,
  type PortalPolicyOrgFacts,
} from './portalAccessPolicy';
import { findProvenEntraTenantForOrg } from './portalEntraTenantProof';
import {
  clearPasswordsForSsoOnly,
  lockSsoOnlyImpact,
  ssoOnlyImpactDigest,
  type LockedSsoOnlyImpact,
  type SsoOnlyOrgImpact,
  type SsoOnlyPolicyOwner,
} from './portalSsoOnly';

/**
 * Settings views and validated writes for portal_access_policies (portal
 * registration W3 #11380; spec §4, §5.3). The only writer of the table.
 *
 * Validation is a save-time courtesy, never the authority: two concurrent
 * writes (org and partner) can each pass against the other's old row. The
 * resolver's mask and `sso_only` fallback (portalAccessPolicy.ts) keep every
 * stored combination safe at use.
 *
 * Runs under the caller's DB context (routes hold a request context). The
 * partner-wide write gate sits here, not only in the route, because
 * partner-wide-write-coverage.test.ts scans services as well as routes.
 *
 * W4 (#11381) plan D12: each update runs in ONE `withDbTransaction`. A save
 * that moves some org from effective `allowed` to effective `sso_only`
 * recomputes that impact inside it over the account rows it locks
 * (lockSsoOnlyImpact), refuses with {@link PortalAccessPolicyConfirmRequiredError}
 * unless the caller acknowledged exactly that impact (its digest), and then
 * clears exactly the locked identity accounts it counted, in the same savepoint
 * as the upsert. A concurrent self-link waits for the commit instead of being
 * cleared unacknowledged. A refusal, or any failure, rolls both back (and
 * releases the locks); the caller catches OUTSIDE this call
 * (docs/agents/tenancy-rls.md).
 */

/** Re-exported (one class): the route maps it to 403 PARTNER_WIDE_WRITE_DENIED_MESSAGE. */
export { PartnerWideWriteDeniedError };

type PartnerWriteAuth = Pick<AuthContext, 'scope' | 'partnerOrgAccess'>;
type PolicyPatch = Partial<PortalAccessPolicyRowValues>;

/** What this save did under D12: the orgs it flipped to `sso_only` and the hashes it cleared. */
export interface PortalAccessPolicySsoOnlyOutcome {
  orgIds: string[];
  passwordsCleared: number;
  /** For the caller's post-commit session purge (cleanup; the epoch bump is the control). */
  clearedUserIds: string[];
}

export interface PortalAccessPolicyWriteResult {
  view: PortalAccessPolicyView;
  changedFields: PortalAccessPolicyField[];
  /** Null unless this save flipped some org to effective `sso_only`. */
  ssoOnly: PortalAccessPolicySsoOnlyOutcome | null;
}

export interface PortalAccessPolicyWriteOptions {
  /**
   * The `impactDigest` the caller was shown (`?acknowledge=` on the PATCH).
   * Absent or stale while the save flips some org → ConfirmRequired.
   */
  acknowledgeSsoOnly?: string | null;
}

export interface PortalAccessPolicySsoOnlyImpact {
  flips: SsoOnlyOrgImpact[];
  impactDigest: string;
}

export class PortalAccessPolicyValidationError extends Error {
  constructor(
    readonly code: PortalAccessPolicyErrorCode,
    readonly field: PortalAccessPolicyField,
    message: string,
  ) {
    super(message);
    this.name = 'PortalAccessPolicyValidationError';
  }
}

/**
 * D12: the save flips some org to effective `sso_only` and carried no
 * acknowledgement, or one for a different impact. Carries the FRESH impact, so
 * the caller can show it and retry with its digest. The route maps it to 409.
 */
export class PortalAccessPolicyConfirmRequiredError extends Error {
  readonly code = PORTAL_ACCESS_POLICY_ERROR_CODES.SSO_ONLY_CONFIRM_REQUIRED;

  constructor(readonly impact: PortalAccessPolicySsoOnlyImpact) {
    super('Turning off password sign-in changes existing portal accounts. Review the impact and confirm to save.');
    this.name = 'PortalAccessPolicyConfirmRequiredError';
  }
}

const BLANK_ROW: PortalAccessPolicyRowValues = Object.freeze<PortalAccessPolicyRowValues>({
  entraEnabled: null,
  googleEnabled: null,
  passwordMode: null,
  selfRegistrationMode: null,
  ssoNewPersonMode: null,
  ssoSessionMaxHours: null,
});

function definedOnly(patch: PolicyPatch): PolicyPatch {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as PolicyPatch;
}

function inheritedSource(source: PortalPolicySource): Exclude<PortalPolicySource, 'org'> {
  // The field is blanked before the pick, so 'org' cannot come back.
  if (source === 'org') throw new Error('portal access policy: inherited value resolved from the owner row');
  return source;
}

/**
 * The org facts a policy owner is judged with (W4 D2). A partner owner is judged
 * as if the tenant were proven: its default means "on wherever a tenant is proven".
 */
function factsFor(owner: PortalAccessPolicyView['owner'], entraTenantProven: boolean | null): PortalPolicyOrgFacts {
  return { entraTenantProven: owner.kind === 'partner' ? true : entraTenantProven === true };
}

/** Org owners only: whether the org's Entra tenant is proven, under the caller's context. */
async function isOrgEntraTenantProven(orgId: string): Promise<boolean> {
  return (await findProvenEntraTenantForOrg(orgId)) !== null;
}

function buildView(
  owner: PortalAccessPolicyView['owner'],
  ownRow: PortalAccessPolicyRowValues | null,
  partnerRow: PortalAccessPolicyRowValues | null,
  caps: PortalSignInCapabilities,
  canEdit: boolean,
  /** Org owner: whether its tenant is proven. Partner owner: null. */
  entraTenantProven: boolean | null,
): PortalAccessPolicyView {
  const values = ownRow ?? BLANK_ROW;
  const facts = factsFor(owner, entraTenantProven);
  // An org owner sits on top of its partner default; a partner owner sits on the built-in defaults.
  const resolve = (row: PortalAccessPolicyRowValues) => (owner.kind === 'org'
    ? pickEffectivePortalAccessPolicy(row, partnerRow, caps, facts)
    : pickEffectivePortalAccessPolicy(null, row, caps, facts));
  const resolved = resolve(values);
  // What one field resolves to when this owner leaves it blank, the rest of its row as stored
  // (so the capability mask and the sso_only fallback apply exactly as they would at use).
  const blanked = (field: PortalAccessPolicyField) =>
    resolve({ ...values, [field]: null } as PortalAccessPolicyRowValues).effective;
  const asInherited = <T>(picked: { value: T; source: PortalPolicySource }) =>
    ({ value: picked.value, source: inheritedSource(picked.source) });
  return {
    owner,
    values: { ...values },
    inherited: {
      entraEnabled: asInherited(blanked('entraEnabled').entraEnabled),
      googleEnabled: asInherited(blanked('googleEnabled').googleEnabled),
      passwordMode: asInherited(blanked('passwordMode').passwordMode),
      selfRegistrationMode: asInherited(blanked('selfRegistrationMode').selfRegistrationMode),
      ssoNewPersonMode: asInherited(blanked('ssoNewPersonMode').ssoNewPersonMode),
      ssoSessionMaxHours: asInherited(blanked('ssoSessionMaxHours').ssoSessionMaxHours),
    },
    effective: resolved.effective,
    passwordModeFallback: resolved.passwordModeFallback,
    capabilities: caps,
    canEdit,
    entraTenantProven: owner.kind === 'org' ? entraTenantProven === true : null,
  };
}

function methodUnavailable(field: PortalAccessPolicyField, message: string): PortalAccessPolicyValidationError {
  return new PortalAccessPolicyValidationError(PORTAL_ACCESS_POLICY_ERROR_CODES.METHOD_UNAVAILABLE, field, message);
}

/** A patch may not set anything the deployment cannot run yet. Turning a method off or clearing it is always allowed. */
function assertMethodsAvailable(patch: PolicyPatch, caps: PortalSignInCapabilities): void {
  const anySsoCapability = caps.entra || caps.google;
  if (patch.entraEnabled === true && !caps.entra) {
    throw methodUnavailable('entraEnabled', 'Microsoft sign-in is not available on this server yet.');
  }
  if (patch.googleEnabled === true && !caps.google) {
    throw methodUnavailable('googleEnabled', 'Google sign-in is not available on this server yet.');
  }
  if (patch.selfRegistrationMode != null && patch.selfRegistrationMode !== 'off' && !caps.selfRegistration) {
    throw methodUnavailable('selfRegistrationMode', 'Self-registration is not available on this server yet.');
  }
  if (patch.ssoNewPersonMode != null && !anySsoCapability) {
    throw methodUnavailable('ssoNewPersonMode', 'Microsoft or Google sign-in must be available on this server before this can be set.');
  }
  if (patch.ssoSessionMaxHours != null && !anySsoCapability) {
    throw methodUnavailable('ssoSessionMaxHours', 'Microsoft or Google sign-in must be available on this server before this can be set.');
  }
}

/**
 * An org override may not turn Microsoft on before the org's tenant is proven
 * (W4 D2). An inherited `true` is masked by the resolver instead, never refused.
 */
function assertEntraTenantProven(patch: PolicyPatch, entraTenantProven: boolean): void {
  if (patch.entraEnabled !== true || entraTenantProven) return;
  throw new PortalAccessPolicyValidationError(
    PORTAL_ACCESS_POLICY_ERROR_CODES.TENANT_NOT_PROVEN,
    'entraEnabled',
    "Prove the organization's Microsoft tenant before turning on Microsoft sign-in.",
  );
}

/** `sso_only` is refused unless the would-be effective policy for this owner has an SSO method on. */
function assertSsoOnlyHasSso(patch: PolicyPatch, wouldBe: ReturnType<typeof pickEffectivePortalAccessPolicy>): void {
  if (patch.passwordMode !== 'sso_only') return;
  if (wouldBe.effective.entraEnabled.value || wouldBe.effective.googleEnabled.value) return;
  throw new PortalAccessPolicyValidationError(
    PORTAL_ACCESS_POLICY_ERROR_CODES.SSO_ONLY_NEEDS_SSO,
    'passwordMode',
    'Turn on Microsoft or Google sign-in before turning password sign-in off.',
  );
}

/** Patched keys whose stored value actually changes, in field order. */
function changedFieldsOf(patch: PolicyPatch, before: PortalAccessPolicyRowValues): PortalAccessPolicyField[] {
  return PORTAL_ACCESS_POLICY_FIELDS.filter((f) => f in patch && (patch[f] ?? null) !== before[f]);
}

function parsePatch(patch: PolicyPatch): PolicyPatch {
  return definedOnly(portalAccessPolicyPatchSchema.parse(patch));
}

/**
 * D12, on the write transaction: the orgs this save flips to `sso_only`,
 * recomputed here from the account rows it locks, never taken from the
 * preview. Throws ConfirmRequired unless `ack` is the digest of exactly this
 * impact. No flip → no ack needed (and nothing locked).
 */
async function requireAcknowledgedSsoOnlyFlips(
  owner: SsoOnlyPolicyOwner,
  fields: PolicyPatch,
  ack: string | null | undefined,
): Promise<LockedSsoOnlyImpact> {
  const impact = await lockSsoOnlyImpact(owner, fields);
  if (impact.flips.length === 0) return impact;
  const impactDigest = ssoOnlyImpactDigest(impact.flips);
  if (ack !== impactDigest) throw new PortalAccessPolicyConfirmRequiredError({ flips: impact.flips, impactDigest });
  return impact;
}

/** After the upsert, same transaction: clear exactly the locked identity accounts the acknowledged impact counted. */
async function clearForFlips(impact: LockedSsoOnlyImpact): Promise<PortalAccessPolicySsoOnlyOutcome | null> {
  if (impact.flips.length === 0) return null;
  const { clearedUserIds } = await clearPasswordsForSsoOnly(db, { portalUserIds: impact.clearableUserIds });
  return { orgIds: impact.flips.map((f) => f.orgId), passwordsCleared: clearedUserIds.length, clearedUserIds };
}

export async function getOrgPortalAccessPolicyView(org: { id: string; partnerId: string }): Promise<PortalAccessPolicyView> {
  const rows = await readPortalAccessPolicyRows({ orgId: org.id, partnerId: org.partnerId });
  const entraTenantProven = await isOrgEntraTenantProven(org.id);
  return buildView({ kind: 'org', id: org.id }, rows.org, rows.partner, getPortalSignInCapabilities(), true, entraTenantProven);
}

export async function getPartnerPortalAccessPolicyView(auth: PartnerWriteAuth, partnerId: string): Promise<PortalAccessPolicyView> {
  const rows = await readPortalAccessPolicyRows({ orgId: null, partnerId });
  return buildView(
    { kind: 'partner', id: partnerId }, rows.partner, null, getPortalSignInCapabilities(),
    canManagePartnerWidePolicies(auth), null,
  );
}

/**
 * Upsert the org override; a `null` field clears it (inherit). Caller resolves
 * org access and holds a DB context. D12: see the module header.
 */
export async function updateOrgPortalAccessPolicy(
  org: { id: string; partnerId: string },
  patch: PolicyPatch,
  opts: PortalAccessPolicyWriteOptions = {},
): Promise<PortalAccessPolicyWriteResult> {
  const fields = parsePatch(patch);
  const caps = getPortalSignInCapabilities();
  assertMethodsAvailable(fields, caps);
  return withDbTransaction(async () => {
    const entraTenantProven = await isOrgEntraTenantProven(org.id);
    assertEntraTenantProven(fields, entraTenantProven);
    const rows = await readPortalAccessPolicyRows({ orgId: org.id, partnerId: org.partnerId });
    const before = rows.org ?? BLANK_ROW;
    const owner = { kind: 'org' as const, id: org.id };
    assertSsoOnlyHasSso(fields, pickEffectivePortalAccessPolicy(
      { ...before, ...fields }, rows.partner, caps, factsFor(owner, entraTenantProven),
    ));

    const changedFields = changedFieldsOf(fields, before);
    if (changedFields.length === 0) {
      return { view: buildView(owner, rows.org, rows.partner, caps, true, entraTenantProven), changedFields, ssoOnly: null };
    }
    const impact = await requireAcknowledgedSsoOnlyFlips(
      { kind: 'org', orgId: org.id, partnerId: org.partnerId }, fields, opts.acknowledgeSsoOnly,
    );
    const [row] = await db.insert(portalAccessPolicies).values({ orgId: org.id, partnerId: null, ...fields })
      .onConflictDoUpdate({
        target: portalAccessPolicies.orgId,
        targetWhere: isNotNull(portalAccessPolicies.orgId),
        set: { ...fields, updatedAt: new Date() },
      })
      .returning();
    if (!row) throw new Error('portal access policy: org upsert returned no row');
    const ssoOnly = await clearForFlips(impact);
    return {
      view: buildView(owner, toPortalAccessPolicyRowValues(row), rows.partner, caps, true, entraTenantProven),
      changedFields,
      ssoOnly,
    };
  });
}

/**
 * Upsert the partner default; a `null` field clears it (built-in default).
 * Refused with {@link PartnerWideWriteDeniedError} unless the caller has full
 * partner access (canManagePartnerWidePolicies) — checked before anything is read.
 *
 * D12: the flips cover every org of the partner the caller's context reaches.
 * The gate admits only a full-partner admin, whose request context holds every
 * active/trial org of the partner, so the impact and the clear see the same
 * orgs with no system escalation (portalSsoOnly.ts header).
 */
export async function updatePartnerPortalAccessPolicy(
  auth: PartnerWriteAuth,
  partnerId: string,
  patch: PolicyPatch,
  opts: PortalAccessPolicyWriteOptions = {},
): Promise<PortalAccessPolicyWriteResult> {
  if (!canManagePartnerWidePolicies(auth)) throw new PartnerWideWriteDeniedError();
  const fields = parsePatch(patch);
  const caps = getPortalSignInCapabilities();
  assertMethodsAvailable(fields, caps);
  return withDbTransaction(async () => {
    const rows = await readPortalAccessPolicyRows({ orgId: null, partnerId });
    const before = rows.partner ?? BLANK_ROW;
    const owner = { kind: 'partner' as const, id: partnerId };
    assertSsoOnlyHasSso(fields, pickEffectivePortalAccessPolicy(null, { ...before, ...fields }, caps, factsFor(owner, null)));

    const changedFields = changedFieldsOf(fields, before);
    if (changedFields.length === 0) {
      return { view: buildView(owner, rows.partner, null, caps, true, null), changedFields, ssoOnly: null };
    }
    const impact = await requireAcknowledgedSsoOnlyFlips({ kind: 'partner', partnerId }, fields, opts.acknowledgeSsoOnly);
    const [row] = await db.insert(portalAccessPolicies).values({ partnerId, orgId: null, ...fields })
      .onConflictDoUpdate({
        target: portalAccessPolicies.partnerId,
        targetWhere: isNotNull(portalAccessPolicies.partnerId),
        set: { ...fields, updatedAt: new Date() },
      })
      .returning();
    if (!row) throw new Error('portal access policy: partner upsert returned no row');
    const ssoOnly = await clearForFlips(impact);
    return { view: buildView(owner, toPortalAccessPolicyRowValues(row), null, caps, true, null), changedFields, ssoOnly };
  });
}
