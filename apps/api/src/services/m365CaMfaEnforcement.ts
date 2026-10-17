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

    const apps = p.conditions.applications;
    if (!isRecord(apps) || !hasAll(stringList(apps.includeApplications), 'all')) return false;

    // Absent/empty clientAppTypes means "any client"; otherwise it must name `all`.
    const clients = stringList(p.conditions.clientAppTypes);
    if (!clients) return false;
    if (clients.length > 0 && !hasAll(clients, 'all')) return false;

    if (isRecord(p.grantControls.authenticationStrength)) return true;
    const builtIn = stringList(p.grantControls.builtInControls);
    if (!builtIn || !builtIn.includes('mfa')) return false;
    // OR with another control (e.g. compliantDevice) lets a user satisfy the policy without MFA.
    return p.grantControls.operator === 'AND' || builtIn.length === 1;
  } catch {
    return false;
  }
}
