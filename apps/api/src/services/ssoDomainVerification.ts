import { randomBytes } from 'crypto';
import { resolveTxt } from 'dns/promises';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { ssoVerifiedDomains } from '../db/schema/sso';

// DB-CONTEXT CONTRACT: these functions use the ambient DB context. Callers MUST
// establish it. Request routes run inside withDbAccessContext (org scope).
// The SSO callback and the daily re-check job have no org context and MUST wrap
// these calls in withSystemDbAccessContext (a contextless read under breeze_app
// silently returns 0 rows). Do not switch context inside this service.

export const TXT_RECORD_HOST_PREFIX = '_breeze-verify';
export const TXT_RECORD_VALUE_PREFIX = 'breeze-domain-verify';

export interface PendingDomain {
  id: string;
  orgId: string;
  domain: string;
  verificationToken: string;
  recordName: string;
  recordValue: string;
  verifiedAt: Date | null;
}

/** Normalize user-entered domain to a bare lowercased hostname (no scheme/path/port/wildcard). Throws on invalid. */
export function normalizeDomain(input: string): string {
  if (!input) throw new Error('Domain is required');
  let d = input.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '');
  // Strip path, query string, and port — each split may theoretically yield undefined in TS strict mode
  d = ((d.split('/')[0] ?? '').split('?')[0] ?? '').split(':')[0] ?? '';
  d = d.replace(/^\*\./, '').replace(/^\.+/, '').replace(/\.+$/, '');
  if (!d || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) {
    throw new Error(`Invalid domain: ${input}`);
  }
  return d;
}

export function recordNameFor(domain: string): string {
  return `${TXT_RECORD_HOST_PREFIX}.${domain}`;
}
export function recordValueFor(token: string): string {
  return `${TXT_RECORD_VALUE_PREFIX}=${token}`;
}

/** Create (or return existing) a pending domain row + its DNS instructions. Idempotent on (orgId, domain). */
export async function createPendingDomain(opts: { orgId: string; domain: string; createdBy?: string | null }): Promise<PendingDomain> {
  const domain = normalizeDomain(opts.domain);
  const verificationToken = randomBytes(24).toString('hex');
  const rows = await db
    .insert(ssoVerifiedDomains)
    .values({ orgId: opts.orgId, domain, verificationToken, createdBy: opts.createdBy ?? null })
    .onConflictDoUpdate({
      target: [ssoVerifiedDomains.orgId, ssoVerifiedDomains.domain],
      set: { updatedAt: new Date() },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error(`Failed to insert or retrieve domain row for ${domain}`);
  return {
    id: row.id, orgId: row.orgId, domain: row.domain,
    verificationToken: row.verificationToken,
    recordName: recordNameFor(row.domain),
    recordValue: recordValueFor(row.verificationToken),
    verifiedAt: row.verifiedAt,
  };
}

/** Perform a DNS TXT check for a single org/domain. Sets verifiedAt on success; sticky (never clears it). Always bumps lastCheckedAt. */
export async function verifyDomain(opts: { orgId: string; domain: string }): Promise<{ verified: boolean; reason?: string }> {
  const domain = normalizeDomain(opts.domain);
  const [row] = await db.select().from(ssoVerifiedDomains)
    .where(and(eq(ssoVerifiedDomains.orgId, opts.orgId), eq(ssoVerifiedDomains.domain, domain)))
    .limit(1);
  if (!row) return { verified: false, reason: 'not_found' };
  const expected = recordValueFor(row.verificationToken);
  let found = false;
  try {
    const records = await resolveTxt(recordNameFor(domain)); // string[][]: one inner array of chunks per TXT record
    found = records.some(chunks => chunks.join('').trim() === expected);
  } catch {
    found = false; // ENOTFOUND / ENODATA / SERVFAIL → simply not verified yet
  }
  const now = new Date();
  if (found) {
    await db.update(ssoVerifiedDomains)
      .set({ verifiedAt: row.verifiedAt ?? now, lastCheckedAt: now, updatedAt: now })
      .where(eq(ssoVerifiedDomains.id, row.id));
    return { verified: true };
  }
  await db.update(ssoVerifiedDomains)
    .set({ lastCheckedAt: now, updatedAt: now })
    .where(eq(ssoVerifiedDomains.id, row.id));
  return { verified: false, reason: 'txt_not_found' };
}

/** Is this exact email-domain verified for the org? Returns false on invalid input (never throws). */
export async function isDomainVerifiedForOrg(orgId: string, rawDomain: string): Promise<boolean> {
  let domain: string;
  try { domain = normalizeDomain(rawDomain); } catch { return false; }
  const [row] = await db.select({ verifiedAt: ssoVerifiedDomains.verifiedAt })
    .from(ssoVerifiedDomains)
    .where(and(eq(ssoVerifiedDomains.orgId, orgId), eq(ssoVerifiedDomains.domain, domain), isNotNull(ssoVerifiedDomains.verifiedAt)))
    .limit(1);
  return !!row;
}

/** Does the org have at least one verified domain? (Gate signal for the SSO callback.) */
export async function orgHasAnyVerifiedDomain(orgId: string): Promise<boolean> {
  const [row] = await db.select({ id: ssoVerifiedDomains.id })
    .from(ssoVerifiedDomains)
    .where(and(eq(ssoVerifiedDomains.orgId, orgId), isNotNull(ssoVerifiedDomains.verifiedAt)))
    .limit(1);
  return !!row;
}

/**
 * When true, the SSO callback enforces domain verification for EVERY org
 * (refuses to provision/JIT-link an email whose domain isn't verified).
 * When false (default), enforcement is per-org: only orgs that already have at
 * least one verified domain are gated (gradual rollout). Read at call time so
 * it can be toggled without a redeploy in dev.
 */
export function isSsoDomainVerificationStrict(): boolean {
  return (process.env.SSO_DOMAIN_VERIFICATION_STRICT ?? '').toLowerCase() === 'true';
}

/**
 * Should the SSO callback REFUSE to JIT-link/provision for this org + asserted
 * email domain? (security review #2 H-2 / Plan B.) Enforcement is global when
 * SSO_DOMAIN_VERIFICATION_STRICT is set, otherwise per-org: an org becomes gated
 * once it has ≥1 verified domain (gradual rollout). When enforcing, the asserted
 * email's domain must be a verified domain for the org. Uses ambient db context —
 * callers without a request context (the SSO callback) must wrap in
 * withSystemDbAccessContext.
 */
export async function isSsoProvisioningBlocked(orgId: string, emailDomain: string | null): Promise<boolean> {
  const enforcing = isSsoDomainVerificationStrict() || (await orgHasAnyVerifiedDomain(orgId));
  if (!enforcing) return false;
  const verified = emailDomain ? await isDomainVerifiedForOrg(orgId, emailDomain) : false;
  return !verified;
}

/**
 * Re-run DNS TXT verification for EVERY SSO domain. Sticky: never un-verifies
 * (delegates to verifyDomain, which only sets verifiedAt and never clears it);
 * flips pending→verified once DNS propagates and refreshes lastCheckedAt.
 * Ambient db context — the re-check worker wraps this in withSystemDbAccessContext.
 */
export async function recheckAllDomains(): Promise<{ checked: number; verified: number }> {
  const rows = await db
    .select({ orgId: ssoVerifiedDomains.orgId, domain: ssoVerifiedDomains.domain })
    .from(ssoVerifiedDomains);
  let verified = 0;
  for (const row of rows) {
    const result = await verifyDomain({ orgId: row.orgId, domain: row.domain });
    if (result.verified) verified++;
  }
  return { checked: rows.length, verified };
}
