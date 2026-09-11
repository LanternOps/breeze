import { eq } from 'drizzle-orm';
import {
  canonicalizeTimezone,
  resolveEffectiveTimezone,
} from '@breeze/shared';
import { db } from '../../db';
import { organizations, partners } from '../../db/schema';

// Org -> partner -> UTC timezone chain (no site axis for org-level portal
// reads), same source-of-truth rules as the report schedule worker's
// timezoneFor / featureConfigResolver's partnerTimezoneFrom.
export function resolveTimezoneFromRows(
  orgSettings: unknown,
  partnerTimezone: string | null,
  partnerSettings: unknown,
): string {
  const orgTz = orgSettings && typeof orgSettings === 'object'
    ? (orgSettings as Record<string, unknown>).timezone
    : null;
  const partnerColumn = canonicalizeTimezone(partnerTimezone);
  const partnerFromSettings = partnerSettings && typeof partnerSettings === 'object'
    ? (partnerSettings as Record<string, unknown>).timezone
    : null;
  const partnerTz = partnerColumn !== null && partnerColumn !== 'UTC'
    ? partnerColumn
    : typeof partnerFromSettings === 'string' && partnerFromSettings.length > 0
      ? partnerFromSettings
      : partnerColumn;

  return resolveEffectiveTimezone({
    siteTz: null,
    orgTz: typeof orgTz === 'string' ? orgTz : null,
    partnerTz,
  });
}

// The lookup deliberately does not open a system context itself: callers are
// responsible for their own DB access scope. `portalAuthMiddleware` calls
// this inside its existing system-context hydration; worker callers already
// run under worker system authority.
export async function resolveOrgTimezone(
  orgId: string,
): Promise<string> {
  const [row] = await db
    .select({
      orgSettings: organizations.settings,
      partnerTimezone: partners.timezone,
      partnerSettings: partners.settings,
    })
    .from(organizations)
    .leftJoin(partners, eq(partners.id, organizations.partnerId))
    .where(eq(organizations.id, orgId))
    .limit(1);

  return resolveTimezoneFromRows(
    row?.orgSettings,
    row?.partnerTimezone ?? null,
    row?.partnerSettings,
  );
}
