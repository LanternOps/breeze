// Server-side sort helper for the organization list. Reads the partner's
// preferred order (an array of org IDs persisted on partners.settings) and
// returns the orgs in that order; any orgs missing from the preferred order
// are appended at the end in their original relative order (which the caller
// is expected to pre-sort by createdAt).

export interface OrderableOrg {
  id: string;
}

export function applyOrganizationOrder<T extends OrderableOrg>(
  orgs: T[],
  preferredOrder: string[] | undefined | null,
): T[] {
  if (!preferredOrder || preferredOrder.length === 0) return orgs;

  const indexById = new Map<string, number>();
  for (let i = 0; i < preferredOrder.length; i++) {
    const id = preferredOrder[i];
    if (typeof id === 'string' && id.length > 0 && !indexById.has(id)) {
      indexById.set(id, i);
    }
  }

  const ordered: T[] = [];
  const trailing: T[] = [];
  for (const org of orgs) {
    if (indexById.has(org.id)) ordered.push(org);
    else trailing.push(org);
  }
  ordered.sort((a, b) => (indexById.get(a.id) ?? 0) - (indexById.get(b.id) ?? 0));
  return [...ordered, ...trailing];
}

// Sanitize a client-supplied order array against the partner's actual
// non-deleted org IDs. Removes unknown/duplicate entries; preserves the
// caller's order for the IDs that are valid.
export function sanitizeOrganizationOrder(
  requestedOrder: string[],
  validOrgIds: string[],
): string[] {
  const valid = new Set(validOrgIds);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of requestedOrder) {
    if (typeof id !== 'string') continue;
    if (!valid.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
