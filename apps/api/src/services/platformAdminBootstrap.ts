import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { users } from '../db/schema';

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
      .where(
        sql`lower(${users.email}) = ANY(${emails}::text[]) AND ${users.isPlatformAdmin} = false`
      )
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
