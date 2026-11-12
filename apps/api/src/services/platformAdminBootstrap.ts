import { and, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { auditLogs, users } from '../db/schema';

/** Actor id recorded on audit rows written by this startup job (no user acts). */
const BOOTSTRAP_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

/**
 * WHERE predicate matching the not-yet-promoted users whose (lowercased) email
 * is in `emails` and who are eligible for promotion: the account is `active`
 * and its address has been verified through an e-mailed link
 * (`email_verified_at` set).
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
    isNotNull(users.emailVerifiedAt)
  )!;
}

/**
 * Idempotent bootstrap that promotes users listed in BREEZE_PLATFORM_ADMINS
 * (comma-separated emails) to platform admin, when the account is active and
 * its address is verified (see buildUnpromotedAdminMatch). Runs at API startup. Never
 * demotes — removing an email from the env var is intentionally not a revoke;
 * a platform admin must demote via DB or a future admin tool.
 *
 * Every promotion writes an audit row in the same transaction as the flag, so
 * a promotion without its audit row cannot commit. The run also reports, as
 * warnings, listed addresses that have no account and platform admins whose
 * address is no longer listed, so the operator can review the list.
 */
export async function bootstrapPlatformAdmins(): Promise<void> {
  const raw = process.env.BREEZE_PLATFORM_ADMINS ?? '';
  const emails = parseAdminEmails(raw);

  if (emails.length === 0) {
    console.warn(
      '[platform-admin-bootstrap] No platform admins configured (BREEZE_PLATFORM_ADMINS unset or empty)'
    );
    return;
  }

  const { promoted, listedRows, unlistedAdmins } = await withSystemDbAccessContext(async () => {
    const promotedRows = await db
      .update(users)
      .set({ isPlatformAdmin: true })
      .where(buildUnpromotedAdminMatch(emails))
      .returning({ id: users.id, email: users.email, partnerId: users.partnerId, orgId: users.orgId });

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
            userOrgId: row.orgId,
          },
        }))
      );
    }

    const listed = await db
      .select({
        email: users.email,
        status: users.status,
        emailVerifiedAt: users.emailVerifiedAt,
        isPlatformAdmin: users.isPlatformAdmin,
      })
      .from(users)
      .where(inArray(sql`lower(${users.email})`, emails));

    const admins = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.isPlatformAdmin, true));

    return {
      promoted: promotedRows,
      listedRows: listed,
      unlistedAdmins: admins.filter((row) => !emails.includes(row.email.toLowerCase())),
    };
  });

  console.log(
    `[platform-admin-bootstrap] Configured ${emails.length} email(s); promoted ${promoted.length} user(s)`
  );

  const present = new Set(listedRows.map((row) => row.email.toLowerCase()));
  const missing = emails.filter((email) => !present.has(email));
  if (missing.length > 0) {
    console.warn(
      `[platform-admin-bootstrap] ${missing.length} listed address(es) have no account and were not promoted: ` +
        `${missing.join(', ')}. Create the account for each address now, or remove it from BREEZE_PLATFORM_ADMINS.`
    );
  }

  const ineligible = listedRows
    .filter((row) => !row.isPlatformAdmin && (row.status !== 'active' || row.emailVerifiedAt === null))
    .map((row) => row.email.toLowerCase());
  if (ineligible.length > 0) {
    console.warn(
      `[platform-admin-bootstrap] ${ineligible.length} listed account(s) were not promoted because the account is not ` +
        `active or its address is not verified: ${ineligible.join(', ')}. The account holder can verify the address ` +
        '(Resend verification); the promotion happens at the next API start.'
    );
  }

  if (unlistedAdmins.length > 0) {
    console.warn(
      `[platform-admin-bootstrap] ${unlistedAdmins.length} platform admin account(s) are not in BREEZE_PLATFORM_ADMINS ` +
        `(user ids: ${unlistedAdmins.map((row) => row.id).join(', ')}). The flag is not removed automatically; ` +
        'review each account.'
    );
  }
}

export function parseAdminEmails(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}
