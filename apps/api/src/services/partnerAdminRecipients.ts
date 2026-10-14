// apps/api/src/services/partnerAdminRecipients.ts
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { partnerUsers, roles, users } from '../db/schema';

export interface PartnerAdminRecipient {
  id: string;
  email: string;
  name: string | null;
}

/**
 * The partner's active users holding the `Partner Admin` role — the people
 * Breeze notifies about account-level events (sending-domain status, account
 * deletion, archive purge warnings, trust review).
 *
 * `partner_users` / `users` are partner-axis tables, and callers range from
 * request handlers (where an org- or partner-scoped context is already
 * active) to workers (no context at all). Step outside any ambient context
 * first, then run in system scope; `withSystemDbAccessContext` alone
 * short-circuits when a context already exists and the query would silently
 * run as the caller.
 */
export async function listActivePartnerAdmins(partnerId: string): Promise<PartnerAdminRecipient[]> {
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(partnerUsers)
    .innerJoin(users, eq(users.id, partnerUsers.userId))
    .innerJoin(roles, eq(roles.id, partnerUsers.roleId))
    .where(and(
      eq(partnerUsers.partnerId, partnerId),
      eq(roles.name, 'Partner Admin'),
      eq(users.status, 'active'),
    )), 'partnerAdminRecipients.list'));

  // Dedupe by address, not by id: that is what every existing site did with
  // `new Set(emails)`, and it is what their tests (which mock rows carrying
  // only `email`) continue to assert.
  const seen = new Set<string>();
  const out: PartnerAdminRecipient[] = [];
  for (const row of rows) {
    const email = row.email?.trim();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push({ id: row.id, email, name: row.name ?? null });
  }
  return out;
}
