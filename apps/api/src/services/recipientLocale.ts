import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users, organizations, partners } from '../db/schema';
import { isSupportedLocale, type SupportedLocale } from '@breeze/shared';

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
 * The function intentionally takes plain ids and performs narrow SELECT queries.
 * **Precondition:** callers must have established a DB access context before
 * calling this function — either `withDbAccessContext` (request paths) or
 * `withSystemDbAccessContext` (background workers).  The bare `db` pool used
 * here inherits whatever RLS context the surrounding `withDbAccessContext` /
 * `withSystemDbAccessContext` call set up, so the queries run under the correct
 * tenant identity without needing an extra context wrap per call.
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

  // 4. Partner default language
  if (ref.partnerId) {
    const [row] = await db
      .select({ settings: partners.settings })
      .from(partners)
      .where(eq(partners.id, ref.partnerId))
      .limit(1);
    const language = (row?.settings as { language?: unknown } | null | undefined)?.language;
    if (isSupportedLocale(language)) return language;
  }

  return 'en';
}
