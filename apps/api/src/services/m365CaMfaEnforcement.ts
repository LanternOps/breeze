// Pure evaluator: does one stored Microsoft 365 Conditional Access policy enforce MFA for everyone?
// Field names follow the Graph `conditionalAccessPolicy` resource, which m365_ca_policies stores verbatim
// (conditions / grant_controls are the raw Graph objects). Unknown shapes are "no", never an error: an
// unrecognised policy must not turn into a published "MFA enforced" claim.

/** Emergency-access (break-glass) accounts are conventionally excluded from an all-users MFA policy. */
export const CA_MAX_EXCLUDED_USERS = 5;
export const CA_MAX_EXCLUDED_GROUPS = 1;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A missing list is empty; a present non-array is malformed (null = reject). */
function stringList(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return null;
  return v as string[];
}

/** True when a Graph condition value actually narrows scope (non-null, non-empty list, or object with a narrowing member). */
function narrows(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isRecord(v)) return Object.values(v).some(narrows);
  if (typeof v === 'string') return v.length > 0 && v.toLowerCase() !== 'none';
  return true;
}

const hasAll = (list: string[] | null, token: string): boolean =>
  !!list && list.some((x) => x.toLowerCase() === token);

export function caPolicyEnforcesMfaForAllUsers(p: {
  state: string | null;
  isStale: boolean;
  conditions: unknown;
  grantControls: unknown;
}): boolean {
  try {
    if (p.state !== 'enabled' || p.isStale) return false;
    if (!isRecord(p.conditions) || !isRecord(p.grantControls)) return false;

    const users = p.conditions.users;
    if (!isRecord(users)) return false;
    if (!hasAll(stringList(users.includeUsers), 'all')) return false;
    const excludeUsers = stringList(users.excludeUsers);
    const excludeGroups = stringList(users.excludeGroups);
    const excludeRoles = stringList(users.excludeRoles);
    if (!excludeUsers || !excludeGroups || !excludeRoles) return false;
    if (excludeUsers.length > CA_MAX_EXCLUDED_USERS) return false;
    if (excludeGroups.length > CA_MAX_EXCLUDED_GROUPS) return false;
    if (excludeRoles.length > 0) return false;

    // Fail closed: any condition that limits WHEN or for WHOM the policy applies means it is not blanket MFA.
    if (narrows(users.excludeGuestsOrExternalUsers)) return false;

    const apps = p.conditions.applications;
    if (!isRecord(apps) || !hasAll(stringList(apps.includeApplications), 'all')) return false;
    if (narrows(apps.excludeApplications) || narrows(apps.includeUserActions) || narrows(apps.includeAuthenticationContextClassReferences)) return false;
    const c = p.conditions;
    if (narrows(c.signInRiskLevels) || narrows(c.userRiskLevels) || narrows(c.insiderRiskLevels)) return false;
    if (narrows(c.platforms) || narrows(c.devices) || narrows(c.clientApplications) || narrows(c.authenticationFlows)) return false;
    if (isRecord(c.locations)) {
      if (narrows(c.locations.excludeLocations)) return false;
      const inc = stringList(c.locations.includeLocations);
      if (!inc || (inc.length > 0 && !hasAll(inc, 'all'))) return false;
    } else if (narrows(c.locations)) return false;

    // Absent/empty clientAppTypes means "any client"; otherwise it must name `all`.
    const clients = stringList(p.conditions.clientAppTypes);
    if (!clients) return false;
    if (clients.length > 0 && !hasAll(clients, 'all')) return false;

    const builtIn = stringList(p.grantControls.builtInControls);
    if (!builtIn) return false;
    // OR with another control (e.g. compliantDevice) lets a user satisfy the policy without MFA.
    const alternatives = builtIn.filter((x) => x !== 'mfa').length + (narrows(p.grantControls.customAuthenticationFactors) ? 1 : 0)
      + (narrows(p.grantControls.termsOfUse) ? 1 : 0);
    const orSafe = p.grantControls.operator === 'AND' || alternatives === 0;
    if (isRecord(p.grantControls.authenticationStrength)) return orSafe;
    return builtIn.includes('mfa') && orSafe;
  } catch {
    return false;
  }
}
