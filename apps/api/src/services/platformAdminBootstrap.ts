import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { users } from '../db/schema';
import {
  advanceUserSecurityState,
  revokeAllUserSessionFamilies,
  type AuthLifecycleTransaction,
} from './authLifecycle';
import { clearPermissionCache } from './permissions';
import { revokeAllUserTokens } from './tokenRevocation';
import { revokeAllUserOauthArtifacts } from '../oauth/grantRevocation';
import { runPostCommitCleanup } from './postCommitCleanup';

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
    const tx = db as unknown as AuthLifecycleTransaction;
    for (const user of result) {
      await advanceUserSecurityState(tx, user.id);
      await revokeAllUserSessionFamilies(tx, user.id, 'platform-admin-changed');
    }
    return result;
  });

  const cleanup = await runPostCommitCleanup(promoted.flatMap((user) => [
    { name: `user-tokens:${user.id}`, run: () => revokeAllUserTokens(user.id) },
    { name: `permission-cache:${user.id}`, run: () => clearPermissionCache(user.id) },
    { name: `oauth:${user.id}`, run: () => revokeAllUserOauthArtifacts(user.id) },
  ]));
  for (const failure of cleanup.failures) {
    console.error('[platform-admin-bootstrap] post-commit credential cleanup failed', failure.name, failure.error);
  }

  console.log(
    `[platform-admin-bootstrap] Configured ${emails.length} email(s); promoted ${promoted.length} user(s); cleanup=${cleanup.cleanupStatus}`
  );
}

export function parseAdminEmails(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}
