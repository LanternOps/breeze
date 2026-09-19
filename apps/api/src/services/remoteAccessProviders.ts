import { eq } from 'drizzle-orm';
import type { InheritableRemoteAccessSettings, RemoteAccessProvider } from '@breeze/shared';
import { db } from '../db';
import { readWithPartnerAxisVisibility } from '../db/partnerAxisRead';
import { organizations, partners } from '../db/schema';

/**
 * The only shape of a remote-access provider that may leave the API.
 *
 * `RemoteAccessProvider` also carries `urlTemplate`, `customFieldKey` and
 * `password`. Those are the launcher's inputs and are stored inside the
 * encrypted `partners.settings` blob — they must never reach a client. This
 * type exists so the projection is enforced by the compiler rather than by
 * remembering to delete fields at each call site.
 */
export interface RemoteAccessProviderSummary {
  id: string;
  name: string;
  enabled: boolean;
}

export interface RemoteAccessDirectory {
  providers: RemoteAccessProviderSummary[];
  defaultProviderId: string | null;
}

type PartnerSettingsShape = {
  remoteAccessProviders?: InheritableRemoteAccessSettings;
};

/**
 * Read the remote-access settings of the partner that owns `orgId`.
 *
 * **This needs a real privilege escalation and gets one.** `partners`' SELECT
 * policy is `breeze_has_partner_access(id)`, which tests
 * `breeze.accessible_partner_ids` — and `computeAccessiblePartnerIds` returns
 * `[]` for `scope === 'organization'`. An org-scoped technician therefore
 * cannot see the partner row under their own context, and a *bare*
 * `withSystemDbAccessContext` would not help: it delegates to
 * `withDbAccessContext`, which early-returns when a context store already
 * exists, so inside a request it silently retains the caller's scope. Only
 * exiting the ALS store first opens a genuinely system-scoped transaction.
 * `readWithPartnerAxisVisibility` (db/partnerAxisRead.ts) is that escape,
 * plus the availability skip: a caller that is ALREADY system-scoped reads in
 * its own transaction instead of borrowing a SECOND pooled connection while
 * the first is still held (#2776 round 4). That skip matters more since
 * #3419 put this read on GET /devices/:id, which is a hot path.
 *
 * Escalating past RLS is only defensible here because every caller projects
 * the result through `toProviderSummaries` before it leaves the process, or
 * (the launcher) consumes it in-process and returns one substituted URL. Do
 * not return the raw settings from a route.
 *
 * The lookup stays keyed on `orgId` alone. Escaping RLS here widens which
 * COLUMNS of the owning partner are legible; it must never widen WHICH
 * partner row can be selected, so callers must pass an org id that was
 * already resolved under the caller's own RLS context (both current callers
 * pass one that came out of an RLS-filtered device/route lookup) — never a
 * raw client-supplied id.
 */
export async function readPartnerRemoteAccessSettings(
  orgId: string,
): Promise<InheritableRemoteAccessSettings | undefined> {
  const settings = await readWithPartnerAxisVisibility(async () => {
    const [row] = await db
      .select({ settings: partners.settings })
      .from(partners)
      .innerJoin(organizations, eq(organizations.partnerId, partners.id))
      .where(eq(organizations.id, orgId))
      .limit(1);
    return (row?.settings ?? {}) as PartnerSettingsShape;
  });
  return settings.remoteAccessProviders;
}

/** Same read, when the partner is already known (partner-scoped callers). */
export async function readRemoteAccessSettingsForPartner(
  partnerId: string,
): Promise<InheritableRemoteAccessSettings | undefined> {
  const settings = await readWithPartnerAxisVisibility(async () => {
    const [row] = await db
      .select({ settings: partners.settings })
      .from(partners)
      .where(eq(partners.id, partnerId))
      .limit(1);
    return (row?.settings ?? {}) as PartnerSettingsShape;
  });
  return settings.remoteAccessProviders;
}

/**
 * Project to the client-safe shape. Field-by-field on purpose: a spread would
 * silently start leaking any credential-bearing field added to
 * `RemoteAccessProvider` later.
 */
export function toProviderSummaries(
  settings: InheritableRemoteAccessSettings | undefined,
): RemoteAccessDirectory {
  const raw: RemoteAccessProvider[] = Array.isArray(settings?.providers) ? settings.providers : [];

  const providers = raw
    .filter((p): p is RemoteAccessProvider => !!p && typeof p.id === 'string' && p.id.length > 0)
    .map((p) => ({
      id: p.id,
      name: typeof p.name === 'string' ? p.name : '',
      enabled: p.enabled === true,
    }));

  // Only report a default the caller can actually see. A dangling id (#3401)
  // would otherwise render as a selected option that does not exist.
  const defaultId = settings?.defaultProviderId;
  const defaultProviderId =
    typeof defaultId === 'string' && providers.some((p) => p.id === defaultId) ? defaultId : null;

  return { providers, defaultProviderId };
}
