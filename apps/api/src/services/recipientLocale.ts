import { eq } from 'drizzle-orm';
import { db, getCurrentDbAccessContext } from '../db';
import { readWithPartnerAxisVisibility } from '../db/partnerAxisRead';
import { users, organizations, partners } from '../db/schema';
import { isSupportedLocale, type SupportedLocale } from '@breeze/shared';
import { resolvePartnerDocumentLocale } from './documentLocale';
import { captureMessage } from './sentry';

/**
 * Resolve the display locale for an outbound artifact (email, PDF, notification)
 * that targets a specific recipient.
 *
 * Resolution order (first valid `SupportedLocale` wins):
 *   1. `explicit`    — a locale already stamped on a schedule/channel config
 *   2. `userId`      — `users.preferences.locale`
 *   3. `orgId`       — `organizations.settings.language`
 *   4. `partnerId`   — `partners.settings.language`
 *   5. `'en'`        — hard fallback
 *
 * **Precondition (enforced):** a DB access context must be established —
 * `withDbAccessContext` on request paths or `withSystemDbAccessContext` in
 * workers. Since `0012-tenant-rls-deny-default.sql` an unset `breeze.scope`
 * resolves to `'none'` and every hop returns ZERO rows without raising, so a
 * contextless call would silently render English for everyone. The function
 * throws instead.
 *
 * **Why the reads run in a system context (#2822).** `partners` is gated by
 * `breeze_has_partner_access(id)` and `users` by partner access OR a reachable
 * non-null `org_id` OR self. Under an org-scoped context (org JWTs, agent,
 * portal, client-AI) the partner hop returns zero rows and a partner-staff
 * recipient (`org_id IS NULL`) is invisible — silently, as English. All three
 * hops therefore run through `readWithPartnerAxisVisibility`, which is a no-op
 * when the ambient scope is already system and otherwise opens ONE
 * system-scoped read for the whole resolution (not one per hop — each escape
 * pins a second pooled connection while the caller's transaction is held).
 *
 * That escape widens which COLUMNS are legible, never which row may be
 * targeted: the ids must come from the caller's own verified auth context or
 * from rows already resolved under its RLS context (a schedule row, a
 * notification channel, `auth.partnerId`). Never feed client-supplied ids in.
 * Only `preferences.locale` / `settings.language` are selected.
 *
 * Callers that already have the relevant setting blobs in memory may pass
 * `explicit` and skip DB reads entirely.
 */
export async function resolveRecipientLocale(ref: {
  userId?: string;
  orgId?: string;
  partnerId?: string;
  /** A value already present in a config object (channel/schedule locale field).
   *  Checked first; if it is a valid SupportedLocale it is returned immediately. */
  explicit?: unknown;
}): Promise<SupportedLocale> {
  // 1. Explicit override (channel/schedule config value)
  if (isSupportedLocale(ref.explicit)) return ref.explicit;

  const hasIds = Boolean(ref.userId || ref.orgId || ref.partnerId);
  if (!hasIds) return 'en';

  if (!getCurrentDbAccessContext()) {
    throw new Error(
      'resolveRecipientLocale: no DB access context — wrap the caller in withDbAccessContext or withSystemDbAccessContext',
    );
  }

  const resolved = await readWithPartnerAxisVisibility(() => resolveFromDb(ref));
  if (resolved) return resolved;

  // Ids were supplied but no tier produced a locale and no partner row was
  // found. Legitimate for a user/org-only ref with nothing configured, but a
  // systematic pattern means misconfiguration or an unreadable row — make it
  // visible rather than silently rendering English.
  captureMessage('recipient locale unresolved; rendering en', {
    eventCode: 'recipient_locale_unresolved',
    level: 'info',
    tags: {
      ...(ref.orgId ? { org_id: ref.orgId } : {}),
      ...(ref.partnerId ? { partner_id: ref.partnerId } : {}),
    },
  });
  return 'en';
}

async function resolveFromDb(ref: {
  userId?: string;
  orgId?: string;
  partnerId?: string;
}): Promise<SupportedLocale | null> {
  // 2. User preference
  if (ref.userId) {
    const [row] = await db
      .select({ preferences: users.preferences })
      .from(users)
      .where(eq(users.id, ref.userId))
      .limit(1);
    const locale = (row?.preferences as { locale?: unknown } | null | undefined)?.locale;
    if (isSupportedLocale(locale)) return locale;
  }

  // 3. Org language setting
  if (ref.orgId) {
    const [row] = await db
      .select({ settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, ref.orgId))
      .limit(1);
    const language = (row?.settings as { language?: unknown } | null | undefined)?.language;
    if (isSupportedLocale(language)) return language;
  }

  // 4. Partner default language — same reader the document stamp uses, so the
  // two tiers cannot drift (services/documentLocale.ts).
  if (ref.partnerId) {
    const [row] = await db
      .select({ settings: partners.settings })
      .from(partners)
      .where(eq(partners.id, ref.partnerId))
      .limit(1);
    // A found partner row always resolves (configured language, else 'en');
    // only a MISSING row falls through to the telemetry below.
    if (row) return resolvePartnerDocumentLocale(row);
  }

  return null;
}
