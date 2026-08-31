// Write-side helpers for the partner's preferred organization order (an array
// of org IDs persisted on partners.settings).
//
// The READ side — turning that array into the list endpoint's sort — is
// `routes/orgs.listQuery.ts`, and it is SQL, not JavaScript. An in-JS sort
// applied to an already-selected page could only permute that page, so a
// cross-page order was inexpressible (#4004); the ordering now has to be part
// of the ORDER BY that LIMIT/OFFSET walks. Do not reintroduce a post-pagination
// sort helper here.

import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { partners } from '../db/schema';
import { encryptColumnValueForWrite } from './encryptedColumnRegistry';

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
