import { eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { organizations, partners } from '../../db/schema';

// Settings rule 9 home for "customer org admins receive connection health
// notices" (spec 2026-10-15 §6, W5 plan). Partner default → org override, ORG
// WINS, then off. Stored at `settings.connectionHealth.customerAdminsNotified`
// on partners (absent = off) and organizations (absent = inherit). Deliberately
// not routed through getEffectiveOrgSettings: that model makes the partner win
// and lock, the wrong direction for an inherit-with-override setting.

export type CustomerAdminsNotifiedSource = 'org' | 'partner' | 'default';

export type ResolvedCustomerAdminsNotified = {
  enabled: boolean;
  source: CustomerAdminsNotifiedSource;
  /** What the org would get with no override: drives the "Inherit (…)" label. */
  inheritedEnabled: boolean;
  inheritedSource: Exclude<CustomerAdminsNotifiedSource, 'org'>;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The stored boolean, or null when unset. Anything that is not a boolean is
 * treated as unset (it can only arrive through the system-scope wholesale
 * settings PATCH, which skips validation) and falls through to the next level.
 */
export function readStoredCustomerAdminsNotified(settings: unknown, where?: string): boolean | null {
  if (!isRecord(settings)) return null;
  const block = settings.connectionHealth;
  if (!isRecord(block) || !('customerAdminsNotified' in block)) return null;
  const v = block.customerAdminsNotified;
  if (typeof v === 'boolean') return v;
  if (v !== null && v !== undefined) {
    console.warn(JSON.stringify({
      event: 'connection_health_setting_invalid',
      key: 'customerAdminsNotified',
      where: where ?? 'unknown',
    }));
  }
  return null;
}

export function resolveCustomerAdminsNotifiedFrom(
  partnerSettings: unknown,
  orgSettings: unknown,
): ResolvedCustomerAdminsNotified {
  const partner = readStoredCustomerAdminsNotified(partnerSettings, 'partner');
  const inheritedEnabled = partner ?? false;
  const inheritedSource = partner === null ? 'default' : 'partner';
  const org = readStoredCustomerAdminsNotified(orgSettings, 'organization');
  return org === null
    ? { enabled: inheritedEnabled, source: inheritedSource, inheritedEnabled, inheritedSource }
    : { enabled: org, source: 'org', inheritedEnabled, inheritedSource };
}

/**
 * Resolved setting per org, in one query. Runs in the CALLER's DB context and
 * must be called from system scope (the notifier and the digest): the partners
 * row is partner-axis. An org that no longer exists resolves off, which is the
 * W1–W3 behaviour.
 */
export async function loadCustomerAdminsNotified(orgIds: readonly string[]): Promise<Map<string, boolean>> {
  const ids = [...new Set(orgIds)];
  const out = new Map<string, boolean>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ orgId: organizations.id, orgSettings: organizations.settings, partnerSettings: partners.settings })
    .from(organizations)
    .innerJoin(partners, eq(partners.id, organizations.partnerId))
    .where(inArray(organizations.id, ids));
  for (const id of ids) out.set(id, false);
  for (const r of rows) out.set(r.orgId, resolveCustomerAdminsNotifiedFrom(r.partnerSettings, r.orgSettings).enabled);
  return out;
}

/** Single-org form of loadCustomerAdminsNotified (same context rule). */
export async function resolveCustomerAdminsNotified(orgId: string): Promise<boolean> {
  return (await loadCustomerAdminsNotified([orgId])).get(orgId) ?? false;
}
