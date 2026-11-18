/**
 * Org merge and customer domain verification (portal registration W5 #11382,
 * plan D3, Review Focus 2): a verified domain on the merged-away org keeps its
 * verification through the real merge engine (executeOrgMerge sets
 * breeze.org_merge=on for Phase B), while a plain repoint of the same row
 * outside a merge clears it. Real Postgres.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createUser } from './db-utils';
import { customerEmailDomains } from '../../db/schema';
import { executeOrgMerge } from '../../services/orgMerge';
import { findOrgByVerifiedDomain } from '../../services/portalDomainVerification';

const admin = () => getTestDb();

let priorDrain: string | undefined;
beforeEach(() => { priorDrain = process.env.ORG_MERGE_FENCE_DRAIN_MS; process.env.ORG_MERGE_FENCE_DRAIN_MS = '0'; });
afterEach(() => { if (priorDrain === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS; else process.env.ORG_MERGE_FENCE_DRAIN_MS = priorDrain; });

async function pair() {
  const partner = await createPartner();
  const loser = await createOrganization({ partnerId: partner.id });
  const survivor = await createOrganization({ partnerId: partner.id });
  const actor = await createUser({ partnerId: partner.id, email: `merge-${randomUUID()}@msp.test` });
  const merge = () => executeOrgMerge({
    loserOrgId: loser.id, survivorOrgId: survivor.id, partnerId: partner.id,
    performedBy: actor.id, performedByEmail: actor.email,
  });
  return { partner, loser, survivor, merge };
}

async function seedVerified(orgId: string, partnerId: string) {
  const domain = `d-${randomUUID().slice(0, 8)}.example.com`;
  const at = new Date(Date.now() - 60 * 60_000);
  const [row] = await admin().insert(customerEmailDomains).values({
    partnerId,
    orgId,
    domain,
    verificationToken: `tok-${randomUUID()}`,
    verifiedAt: at,
    verifiedMethod: 'dns_txt',
    verifiedEvidence: { via: 'dns_txt', recordName: `_breeze-verify.${domain}` },
    lastCheckedAt: at,
    lastPassedAt: at,
    lastCheckStatus: 'pass',
  }).returning();
  return row!;
}

async function rowOf(id: string) {
  const [row] = await admin().select().from(customerEmailDomains).where(eq(customerEmailDomains.id, id));
  return row!;
}

describe('org merge: customer_email_domains verification', () => {
  it('org merge keeps verification: the loser\'s verified domain moves to the survivor still verified', async () => {
    const f = await pair();
    const row = await seedVerified(f.loser.id, f.partner.id);

    await f.merge();

    const after = await rowOf(row.id);
    expect(after.orgId).toBe(f.survivor.id);
    expect(after.verifiedAt?.getTime()).toBe(row.verifiedAt!.getTime());
    expect(after.verifiedMethod).toBe('dns_txt');
    expect(after.verificationToken).toBe(row.verificationToken);
    expect(after.clearedReason).toBeNull();
    expect((await findOrgByVerifiedDomain(row.domain))?.orgId).toBe(f.survivor.id);
  });

  it('control: the same repoint outside a merge clears verification (repointed)', async () => {
    const f = await pair();
    const row = await seedVerified(f.loser.id, f.partner.id);
    await admin().update(customerEmailDomains).set({ orgId: f.survivor.id }).where(eq(customerEmailDomains.id, row.id));
    const after = await rowOf(row.id);
    expect(after.verifiedAt).toBeNull();
    expect(after.clearedReason).toBe('repointed');
  });
});
