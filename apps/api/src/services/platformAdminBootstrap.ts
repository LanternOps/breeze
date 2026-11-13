import { and, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { auditLogs, users } from '../db/schema';

/** Actor id recorded on audit rows written by this startup job (no user acts). */
const BOOTSTRAP_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

/**
 * WHERE predicate matching the not-yet-promoted users whose (lowercased) email
 * is in `emails` and who are eligible for promotion:
 *  - the account is `active`;
 *  - its address has been verified through an e-mailed link
 *    (`email_verified_at` set);
 *  - it is a partner-level account (`org_id` NULL), not an account homed in
 *    a customer organization;
 *  - no other account has the same address ignoring case (`users.email` is
 *    unique case-sensitively, so two rows can share one lowercased address);
 *    an ambiguous address promotes nobody.
 *
 * Uses `inArray` — which renders `lower(email) in ($1, $2, ...)` with ONE bound
 * param per email — rather than interpolating the JS array into a raw `sql`
 * template as `= ANY(${emails}::text[])`. The `= ANY(...::text[])` form binds
 * the whole array as a single param, and in the production CJS bundle that
 * param's text reaches Postgres as a bare string (not a `{...}` array literal),
 * so the `::text[]` cast fails at runtime with `malformed array literal` — even
 * though it worked under dev/vitest. Emitting one param per email removes the
 * array serialization entirely, so the failure class can't recur. (#2655)
 *
 * Callers must pass a non-empty array (`inArray([])` renders `in ()`, invalid
 * SQL); `bootstrapPlatformAdmins` guarantees this via its early return.
 */
export function buildUnpromotedAdminMatch(emails: string[]): SQL {
  return and(
    inArray(sql`lower(${users.email})`, emails),
    eq(users.isPlatformAdmin, false),
    eq(users.status, 'active'),
    isNotNull(users.emailVerifiedAt),
    isNull(users.orgId),
    // Raw table names on purpose: inside `UPDATE users`, `users.*` is the row
    // being updated and `same_address` is every other row.
    sql`not exists (select 1 from users same_address where lower(same_address.email) = lower(users.email) and same_address.id <> users.id)`
  )!;
}

/**
 * Idempotent bootstrap that promotes users listed in BREEZE_PLATFORM_ADMINS
 * (comma-separated emails) to platform admin, when the account is eligible
 * (see buildUnpromotedAdminMatch). Runs at API startup. Never demotes —
 * removing an email from the env var is intentionally not a revoke; a platform
 * admin must demote via DB or a future admin tool.
 *
 * Every promotion writes an audit row in the same transaction as the flag, so
 * a promotion without its audit row cannot commit. The run also reports, as
 * warnings, listed addresses that have no account, listed accounts that are
 * not eligible, addresses shared by several accounts, and platform admins
 * whose address is not listed (also when the list is empty), so the operator
 * can review the list.
 */
export async function bootstrapPlatformAdmins(): Promise<void> {
  const raw = process.env.BREEZE_PLATFORM_ADMINS ?? '';
  const emails = parseAdminEmails(raw);

  if (emails.length === 0) {
    console.warn(
      '[platform-admin-bootstrap] No platform admins configured (BREEZE_PLATFORM_ADMINS unset or empty)'
    );
    const admins = await withSystemDbAccessContext(() =>
      db.select({ id: users.id, email: users.email }).from(users).where(eq(users.isPlatformAdmin, true))
    );
    warnUnlistedAdmins(admins);
    return;
  }

  const { promoted, listedRows, admins } = await withSystemDbAccessContext(async () => {
    const promotedRows = await db
      .update(users)
      .set({ isPlatformAdmin: true })
      .where(buildUnpromotedAdminMatch(emails))
      .returning({ id: users.id, email: users.email, partnerId: users.partnerId });

    if (promotedRows.length > 0) {
      await db.insert(auditLogs).values(
        promotedRows.map((row) => ({
          orgId: null,
          partnerId: null,
          actorType: 'system' as const,
          actorId: BOOTSTRAP_ACTOR_ID,
          action: 'platform_admin.bootstrap_promote',
          resourceType: 'user',
          resourceId: row.id,
          resourceName: row.email,
          result: 'success' as const,
          details: {
            source: 'BREEZE_PLATFORM_ADMINS',
            userPartnerId: row.partnerId,
          },
        }))
      );
    }

    const listed = await db
      .select({
        id: users.id,
        address: sql<string>`lower(${users.email})`,
        status: users.status,
        emailVerifiedAt: users.emailVerifiedAt,
        orgId: users.orgId,
        isPlatformAdmin: users.isPlatformAdmin,
      })
      .from(users)
      .where(inArray(sql`lower(${users.email})`, emails));

    const flagged = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.isPlatformAdmin, true));

    return { promoted: promotedRows, listedRows: listed, admins: flagged };
  });

  console.log(
    `[platform-admin-bootstrap] Configured ${emails.length} email(s); promoted ${promoted.length} user(s)`
  );

  const rowsByAddress = new Map<string, typeof listedRows>();
  for (const row of listedRows) {
    rowsByAddress.set(row.address, [...(rowsByAddress.get(row.address) ?? []), row]);
  }

  const missing = emails.filter((email) => !rowsByAddress.has(email));
  if (missing.length > 0) {
    console.warn(
      `[platform-admin-bootstrap] ${missing.length} listed address(es) have no account and were not promoted: ` +
        `${missing.join(', ')}. Remove each address from BREEZE_PLATFORM_ADMINS until its account exists in your own partner.`
    );
  }

  const shared = [...rowsByAddress.entries()].filter(([, rows]) => rows.length > 1);
  if (shared.length > 0) {
    console.warn(
      `[platform-admin-bootstrap] ${shared.length} listed address(es) match more than one account; this run promoted none of them ` +
        '(an account that already has the flag keeps it): ' +
        shared.map(([address, rows]) => `${address} (user ids: ${rows.map((row) => row.id).join(', ')})`).join('; ') +
        '. Remove the accounts that should not exist.'
    );
  }

  const failsRules = (row: (typeof listedRows)[number]) =>
    row.status !== 'active' || row.emailVerifiedAt === null || row.orgId !== null;
  const singleRows = [...rowsByAddress.values()].filter((rows) => rows.length === 1).map((rows) => rows[0]!);
  const ineligible = singleRows.filter((row) => !row.isPlatformAdmin && failsRules(row)).map((row) => row.address);
  if (ineligible.length > 0) {
    console.warn(
      `[platform-admin-bootstrap] ${ineligible.length} listed account(s) were not promoted because the account is not ` +
        `active, its address is not verified, or it belongs to an organization rather than a partner: ${ineligible.join(', ')}.`
    );
  }

  const flaggedFailing = singleRows.filter((row) => row.isPlatformAdmin && failsRules(row));
  if (flaggedFailing.length > 0) {
    console.warn(
      `[platform-admin-bootstrap] ${flaggedFailing.length} listed platform admin account(s) keep the flag but would not be ` +
        `promoted today (not active, address not verified, or belongs to an organization) — user ids: ` +
        `${flaggedFailing.map((row) => row.id).join(', ')}. The flag is not removed automatically; review each account.`
    );
  }

  warnUnlistedAdmins(admins.filter((row) => !emails.includes(row.email.toLowerCase())));
}

function warnUnlistedAdmins(unlisted: Array<{ id: string }>): void {
  if (unlisted.length === 0) return;
  console.warn(
    `[platform-admin-bootstrap] ${unlisted.length} platform admin account(s) are not in BREEZE_PLATFORM_ADMINS ` +
      `(user ids: ${unlisted.map((row) => row.id).join(', ')}). The flag is not removed automatically; ` +
      'review each account.'
  );
}

export function parseAdminEmails(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0)
    ),
  ];
}
