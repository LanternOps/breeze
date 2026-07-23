import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { users } from '../db/schema';

/**
 * WHERE predicate matching the not-yet-promoted users whose (lowercased) email
 * is in `emails`.
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
    eq(users.isPlatformAdmin, false)
  )!;
}

/**
 * Idempotent bootstrap that promotes users listed in BREEZE_PLATFORM_ADMINS
 * (comma-separated emails) to platform admin. Runs at API startup. Never
 * demotes — removing an email from the env var is intentionally not a revoke;
 * a platform admin must demote via DB or a future admin tool.
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

  const promoted = await withSystemDbAccessContext(async () => {
    const result = await db
      .update(users)
      .set({ isPlatformAdmin: true })
      .where(buildUnpromotedAdminMatch(emails))
      .returning({ id: users.id, email: users.email });
    return result;
  });

  console.log(
    `[platform-admin-bootstrap] Configured ${emails.length} email(s); promoted ${promoted.length} user(s)`
  );
}

export function parseAdminEmails(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}
