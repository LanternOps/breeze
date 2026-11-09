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
import { db } from '../db';
import { portalAccessPolicies } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { canManagePartnerWidePolicies, PartnerWideWriteDeniedError } from './partnerWideAccess';
import {
  getPortalSignInCapabilities,
  pickEffectivePortalAccessPolicy,
  readPortalAccessPolicyRows,
  toPortalAccessPolicyRowValues,
} from './portalAccessPolicy';

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
 */

/** Re-exported (one class): the route maps it to 403 PARTNER_WIDE_WRITE_DENIED_MESSAGE. */
export { PartnerWideWriteDeniedError };

type PartnerWriteAuth = Pick<AuthContext, 'scope' | 'partnerOrgAccess'>;
type PolicyPatch = Partial<PortalAccessPolicyRowValues>;
export interface PortalAccessPolicyWriteResult {
  view: PortalAccessPolicyView;
  changedFields: PortalAccessPolicyField[];
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

function buildView(
  owner: PortalAccessPolicyView['owner'],
  ownRow: PortalAccessPolicyRowValues | null,
  partnerRow: PortalAccessPolicyRowValues | null,
  caps: PortalSignInCapabilities,
  canEdit: boolean,
): PortalAccessPolicyView {
  const values = ownRow ?? BLANK_ROW;
  // An org owner sits on top of its partner default; a partner owner sits on the built-in defaults.
  const resolve = (row: PortalAccessPolicyRowValues) => (owner.kind === 'org'
    ? pickEffectivePortalAccessPolicy(row, partnerRow, caps)
    : pickEffectivePortalAccessPolicy(null, row, caps));
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

export async function getOrgPortalAccessPolicyView(org: { id: string; partnerId: string }): Promise<PortalAccessPolicyView> {
  const rows = await readPortalAccessPolicyRows({ orgId: org.id, partnerId: org.partnerId });
  return buildView({ kind: 'org', id: org.id }, rows.org, rows.partner, getPortalSignInCapabilities(), true);
}

export async function getPartnerPortalAccessPolicyView(auth: PartnerWriteAuth, partnerId: string): Promise<PortalAccessPolicyView> {
  const rows = await readPortalAccessPolicyRows({ orgId: null, partnerId });
  return buildView(
    { kind: 'partner', id: partnerId }, rows.partner, null, getPortalSignInCapabilities(),
    canManagePartnerWidePolicies(auth),
  );
}

/** Upsert the org override; a `null` field clears it (inherit). Caller resolves org access. */
export async function updateOrgPortalAccessPolicy(
  org: { id: string; partnerId: string },
  patch: PolicyPatch,
): Promise<PortalAccessPolicyWriteResult> {
  const fields = parsePatch(patch);
  const caps = getPortalSignInCapabilities();
  assertMethodsAvailable(fields, caps);
  const rows = await readPortalAccessPolicyRows({ orgId: org.id, partnerId: org.partnerId });
  const before = rows.org ?? BLANK_ROW;
  assertSsoOnlyHasSso(fields, pickEffectivePortalAccessPolicy({ ...before, ...fields }, rows.partner, caps));

  const owner = { kind: 'org' as const, id: org.id };
  const changedFields = changedFieldsOf(fields, before);
  if (changedFields.length === 0) {
    return { view: buildView(owner, rows.org, rows.partner, caps, true), changedFields };
  }
  const [row] = await db.insert(portalAccessPolicies).values({ orgId: org.id, partnerId: null, ...fields })
    .onConflictDoUpdate({
      target: portalAccessPolicies.orgId,
      targetWhere: isNotNull(portalAccessPolicies.orgId),
      set: { ...fields, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error('portal access policy: org upsert returned no row');
  return { view: buildView(owner, toPortalAccessPolicyRowValues(row), rows.partner, caps, true), changedFields };
}

/**
 * Upsert the partner default; a `null` field clears it (built-in default).
 * Refused with {@link PartnerWideWriteDeniedError} unless the caller has full
 * partner access (canManagePartnerWidePolicies) — checked before anything is read.
 */
export async function updatePartnerPortalAccessPolicy(
  auth: PartnerWriteAuth,
  partnerId: string,
  patch: PolicyPatch,
): Promise<PortalAccessPolicyWriteResult> {
  if (!canManagePartnerWidePolicies(auth)) throw new PartnerWideWriteDeniedError();
  const fields = parsePatch(patch);
  const caps = getPortalSignInCapabilities();
  assertMethodsAvailable(fields, caps);
  const rows = await readPortalAccessPolicyRows({ orgId: null, partnerId });
  const before = rows.partner ?? BLANK_ROW;
  assertSsoOnlyHasSso(fields, pickEffectivePortalAccessPolicy(null, { ...before, ...fields }, caps));

  const owner = { kind: 'partner' as const, id: partnerId };
  const changedFields = changedFieldsOf(fields, before);
  if (changedFields.length === 0) {
    return { view: buildView(owner, rows.partner, null, caps, true), changedFields };
  }
  const [row] = await db.insert(portalAccessPolicies).values({ partnerId, orgId: null, ...fields })
    .onConflictDoUpdate({
      target: portalAccessPolicies.partnerId,
      targetWhere: isNotNull(portalAccessPolicies.partnerId),
      set: { ...fields, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error('portal access policy: partner upsert returned no row');
  return { view: buildView(owner, toPortalAccessPolicyRowValues(row), null, caps, true), changedFields };
}
