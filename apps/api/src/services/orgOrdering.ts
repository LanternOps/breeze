// Server-side sort helper for the organization list. Reads the partner's
// preferred order (an array of org IDs persisted on partners.settings) and
// returns the orgs in that order; any orgs missing from the preferred order
// are appended at the end in their original relative order (which the caller
// is expected to pre-sort by createdAt).

import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { partners } from '../db/schema';
import { encryptColumnValueForWrite } from './encryptedColumnRegistry';

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

/**
 * Drop `orgId` from `partners.settings.organizationOrder`, if present. Called
 * post-commit after an org is permanently destroyed (org merge, Task 4) so a
 * dead id doesn't linger in the partner's saved order forever.
 *
 * Purely cosmetic, by design: `applyOrganizationOrder` already tolerates a
 * stale id (it's simply never matched, same as any other id an org list no
 * longer contains), so leaving this unfixed would never break the UI — it
 * would just keep a phantom entry in the persisted array. Never scoped by
 * `isNull(partners.deletedAt)`: a partner mid-erasure of its own should not
 * make this throw, and the caller treats the whole call as best-effort
 * anyway (its own try/catch).
 *
 * No-op (no write) when the partner has no saved order or the id isn't in
 * it, so a merge under a partner that never set a custom order costs nothing
 * beyond the one read.
 */
export async function removeOrgFromPartnerOrder(partnerId: string, orgId: string): Promise<void> {
  await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [current] = await db
        .select({ settings: partners.settings })
        .from(partners)
        .where(eq(partners.id, partnerId))
        .limit(1);
      if (!current) return;

      const currentSettings = (current.settings as Record<string, unknown> | null) ?? {};
      const order = currentSettings.organizationOrder;
      if (!Array.isArray(order) || !order.includes(orgId)) return;

      const newSettings = {
        ...currentSettings,
        organizationOrder: order.filter((id) => id !== orgId),
      };

      await db
        .update(partners)
        .set({
          settings: encryptColumnValueForWrite('partners', 'settings', newSettings),
          updatedAt: new Date(),
        })
        .where(eq(partners.id, partnerId));
    }),
  );
}
