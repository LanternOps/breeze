import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { BillingLinkPurpose } from '@breeze/shared';
import { billingLinkTokens } from '../../db/schema';
import { encryptSecret } from '../secretCrypto';
import { columnAad, encryptedColumnRegistry } from '../encryptedColumnRegistry';
import { portalBase } from '../portalUrl';
import type { Tx } from './types';
const spec = encryptedColumnRegistry.find(s => s.table === 'billing_link_tokens' && s.column === 'token_ct');
if (!spec) throw new Error('billing_link_tokens.token_ct is not registered');

export async function mintBillingLinkToken(tx: Tx, input: {
  orgId: string; purpose: BillingLinkPurpose; enrollmentId?: string;
  invoiceId?: string; generation?: number; ttlDays: number;
}): Promise<{ token: string; id: string }> {
  if (!Number.isSafeInteger(input.ttlDays) || input.ttlDays <= 0) throw new Error('ttlDays must be a positive integer');
  const expiresAt = new Date(Date.now() + input.ttlDays * 86400000);
  if (!Number.isFinite(expiresAt.getTime())) throw new Error('ttlDays exceeds Date range');
  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const tokenCt = encryptSecret(token, { aad: columnAad(spec!, id) });
  if (!tokenCt) throw new Error('Could not encrypt billing link');
  await tx.insert(billingLinkTokens).values({
    id, orgId: input.orgId, purpose: input.purpose,
    enrollmentId: input.enrollmentId ?? null, invoiceId: input.invoiceId ?? null,
    generation: input.generation ?? null, expiresAt,
    tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'), tokenCt,
  });
  return { token, id };
}
export type BillingLinkFailure = 'invalid' | 'expired' | 'revoked' | 'consumed';
/**
 * Like resolveBillingLinkToken, but says why a matched link is unusable so a client
 * page can explain it ("expired", "replaced", "already used"). `row` is null for an
 * unknown, malformed or wrong-purpose token: callers must reveal nothing about those.
 */
export async function inspectBillingLinkToken(db: Tx, token: string, purpose: BillingLinkPurpose): Promise<{
  row: typeof billingLinkTokens.$inferSelect | null; failure: BillingLinkFailure | null;
}> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { row: null, failure: 'invalid' };
  const [row] = await db.select().from(billingLinkTokens).where(and(
    eq(billingLinkTokens.tokenHash, createHash('sha256').update(token, 'utf8').digest('hex')),
    eq(billingLinkTokens.purpose, purpose),
  )).limit(1);
  if (!row || row.purpose !== purpose) return { row: null, failure: 'invalid' };
  if (row.expiresAt.getTime() <= Date.now()) return { row, failure: 'expired' };
  if (row.revokedAt) return { row, failure: 'revoked' };
  if ((purpose === 'enroll' || purpose === 'confirm_payment') && row.consumedAt) return { row, failure: 'consumed' };
  return { row, failure: null };
}
export async function resolveBillingLinkToken(db: Tx, token: string, purpose: BillingLinkPurpose): Promise<typeof billingLinkTokens.$inferSelect | null> {
  const { row, failure } = await inspectBillingLinkToken(db, token, purpose);
  return failure ? null : row;
}
export async function revokeBillingLinkTokens(tx: Tx, filter: {
  orgId: string; purpose?: BillingLinkPurpose; enrollmentId?: string; invoiceId?: string;
}): Promise<number> {
  const rows = await tx.update(billingLinkTokens).set({ revokedAt: new Date() }).where(and(
    eq(billingLinkTokens.orgId, filter.orgId), isNull(billingLinkTokens.revokedAt),
    filter.purpose === undefined ? undefined : eq(billingLinkTokens.purpose, filter.purpose),
    filter.enrollmentId === undefined ? undefined : eq(billingLinkTokens.enrollmentId, filter.enrollmentId),
    filter.invoiceId === undefined ? undefined : eq(billingLinkTokens.invoiceId, filter.invoiceId),
  )).returning({ id: billingLinkTokens.id });
  return rows.length;
}
export function buildBillingLinkUrl(purpose: BillingLinkPurpose, token: string): string {
  const suffix: Record<BillingLinkPurpose, string> = {
    enroll: '', skip_invoice: '/skip', stop_autopay: '/stop', confirm_payment: '/confirm',
  };
  return `${portalBase()}/autopay/${encodeURIComponent(token)}${suffix[purpose]}`;
}
