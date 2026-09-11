import { sql } from 'drizzle-orm';
import { db, assertInTransaction, runOutsideDbContext, withSystemDbAccessContext } from '../db';

export type MfaSettingsScope = { kind: 'partner' | 'organization'; id: string };

/** Call only after authorizing the settings target, inside the request transaction.
 * Serialize partner and child-org settings writers before reading their settings.
 * The transaction lock lasts through the caller's eventual settings write.
 */
export async function lockMfaPolicySettings(scope: MfaSettingsScope): Promise<void> {
  assertInTransaction('lockMfaPolicySettings');
  const partnerId = scope.kind === 'partner' ? scope.id : await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const rows = await db.execute<{ partner_id: string }>(sql`
        SELECT partner_id FROM organizations WHERE id = ${scope.id}::uuid`);
      return rows[0]?.partner_id;
    }),
  );
  if (partnerId) {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${partnerId}, 167))`);
  }
}

/** Count newly stranded enrolled users, never factor secrets or identities.
 * Recovery codes are finite emergency credentials, not a sustainable factor.
 * Passkeys stay always allowed; disabled passkeys are not usable inventory.
 * Reads deliberately escape ambient user RLS, but every membership is pinned
 * to the already-authorized scope. Failure propagates and prevents the write.
 */
export async function countMfaPolicyLockouts(scope: MfaSettingsScope, nextSettings: unknown): Promise<number> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const next = JSON.stringify(nextSettings ?? {});
    const rows = await db.execute<{ count: number }>(sql`
      WITH target AS (
        SELECT p.id AS partner_id, p.settings AS partner_settings,
          o.id AS org_id, o.settings AS org_settings
        FROM partners p
        LEFT JOIN organizations o ON o.partner_id = p.id
        WHERE ${scope.kind === 'partner'
          ? sql`p.id = ${scope.id}::uuid`
          : sql`o.id = ${scope.id}::uuid`}
      ), policies AS (
        SELECT ou.user_id,
          CASE WHEN jsonb_typeof(t.partner_settings->'security') = 'object'
              AND (t.partner_settings->'security') ? 'allowedMethods'
            THEN t.partner_settings #> '{security,allowedMethods}'
            ELSE t.org_settings #> '{security,allowedMethods}' END AS before_methods,
          CASE WHEN ${scope.kind} = 'partner' THEN
            CASE WHEN jsonb_typeof(${next}::jsonb->'security') = 'object'
                AND (${next}::jsonb->'security') ? 'allowedMethods'
              THEN ${next}::jsonb #> '{security,allowedMethods}'
              ELSE t.org_settings #> '{security,allowedMethods}' END
          ELSE
            CASE WHEN jsonb_typeof(t.partner_settings->'security') = 'object'
                AND (t.partner_settings->'security') ? 'allowedMethods'
              THEN t.partner_settings #> '{security,allowedMethods}'
              ELSE ${next}::jsonb #> '{security,allowedMethods}' END
          END AS after_methods
        FROM target t JOIN organization_users ou ON ou.org_id = t.org_id
        UNION ALL
        SELECT pu.user_id, p.settings #> '{security,allowedMethods}',
          ${next}::jsonb #> '{security,allowedMethods}'
        FROM partners p JOIN partner_users pu ON pu.partner_id = p.id
        WHERE ${scope.kind} = 'partner' AND p.id = ${scope.id}::uuid
      ), stranded AS (
        SELECT DISTINCT u.id FROM policies p JOIN users u ON u.id = p.user_id
        WHERE u.mfa_enabled
          AND NOT EXISTS (SELECT 1 FROM user_passkeys k WHERE k.user_id = u.id AND k.disabled_at IS NULL)
          AND (
            (COALESCE(u.mfa_secret, '') <> '' AND (p.before_methods->'totp') IS DISTINCT FROM 'false'::jsonb)
            OR (u.mfa_method = 'sms' AND COALESCE(u.phone_number, '') <> '' AND (p.before_methods->'sms') IS DISTINCT FROM 'false'::jsonb)
          )
          AND NOT (
            (COALESCE(u.mfa_secret, '') <> '' AND (p.after_methods->'totp') IS DISTINCT FROM 'false'::jsonb)
            OR (COALESCE(u.mfa_method = 'sms', false) AND COALESCE(u.phone_number, '') <> '' AND (p.after_methods->'sms') IS DISTINCT FROM 'false'::jsonb)
          )
        LIMIT 1000
      ) SELECT count(*)::integer AS count FROM stranded
    `);
    const count = rows[0]?.count;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 1000) {
      throw new Error('MFA policy inventory count unavailable');
    }
    return count;
  }));
}

export function mfaPolicyLockoutResponse(count: number) {
  return {
    code: 'mfa_policy_would_lock_out_users',
    error: 'Enroll an allowed MFA method for affected users before changing this policy.',
    count,
    countCapped: count === 1000,
  };
}
