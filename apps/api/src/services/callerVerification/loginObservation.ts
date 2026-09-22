/**
 * Independent login telemetry → OS principal binding (#6354 W01).
 *
 * An authenticated agent reported a session whose OS principal carries a
 * directory UPN. If exactly ONE active directory-bound contact in the SAME
 * org has that UPN, the OS principal is recorded on that binding
 * (`observeLogin`). Anything else — no UPN, username/principal mismatch,
 * inconsistent SID/UID, zero or several matches — is ignored: telemetry
 * never creates a binding from scratch, and a UPN seen in another org is
 * never evidence here.
 */
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db, assertInTransaction } from '../../db';
import { callerVerificationSubjectBindings as b } from '../../db/schema/callerVerification';
import { observeLogin } from './subjects';

export type SessionPrincipal = { sid?: string; uid?: number; username: string; upn?: string };

export async function observeSessionPrincipal(orgId: string, hostname: string, username: string, p: SessionPrincipal | undefined): Promise<void> {
  if (!p?.upn || p.username.toLowerCase() !== username.toLowerCase() || ((p.sid !== undefined) === (p.uid !== undefined))) return;
  assertInTransaction('observeSessionPrincipal');
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`caller-identity:${orgId}`}))`);
  const rows = await db.select().from(b).where(and(
    eq(b.orgId, orgId), isNull(b.revokedAt), isNotNull(b.entraTenantId), isNotNull(b.entraOid),
    sql`lower(${b.upnSnapshot})=lower(${p.upn})`,
  )).limit(2);
  if (rows.length !== 1) return;
  await observeLogin({
    orgId, contactId: rows[0]!.contactId,
    osPrincipal: p.sid ?? `uid:${p.uid}@${hostname}`, osUsername: p.username, upn: p.upn,
  });
}
