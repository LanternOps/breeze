/**
 * access_review_items policies follow the parent access review's owner.
 *
 * Migration under test: 2026-11-19-101100-access-review-items-parent-review-policies.sql
 *
 * access_review_items has no org_id / partner_id column; its tenancy is the
 * parent access_reviews row, which is owned by exactly one organization OR one
 * partner. Every command on the item table requires that owner to be
 * accessible in the current context — whose user the item is about does not
 * widen or narrow that.
 *
 * Runs through the real postgres.js driver (breeze_app, bound parameters) so
 * the EXISTS join is exercised the way production executes it. Fixtures are
 * seeded inside each `it` — setup.ts truncates between tests.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { accessReviewItems, accessReviews } from '../../db/schema';
import { createOrganization, createPartner, createRole, createUser } from './db-utils';
import { getTestDb } from './setup';

/**
 * One partner, two orgs. The technician's context reaches `allowedOrg` only
 * (partner_users.org_access = 'selected'). Each org has an org-owned review
 * with an item for a colleague on the partner staff and an item for an org
 * user; the partner also has a partner-owned review.
 */
async function seed() {
  const adminDb = getTestDb() as any;
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const partner = await createPartner();
  const allowedOrg = await createOrganization({ partnerId: partner.id });
  const otherOrg = await createOrganization({ partnerId: partner.id });
  const tech = await createUser({ partnerId: partner.id, orgId: null, email: `ari-tech-${unique}@example.test` });
  const colleague = await createUser({
    partnerId: partner.id,
    orgId: null,
    email: `ari-colleague-${unique}@example.test`,
  });
  const otherOrgUser = await createUser({
    partnerId: partner.id,
    orgId: otherOrg.id,
    email: `ari-other-org-user-${unique}@example.test`,
  });
  const allowedOrgUser = await createUser({
    partnerId: partner.id,
    orgId: allowedOrg.id,
    email: `ari-allowed-org-user-${unique}@example.test`,
  });
  const partnerRole = await createRole({ scope: 'partner', partnerId: partner.id });
  const otherOrgRole = await createRole({ scope: 'organization', orgId: otherOrg.id, partnerId: partner.id });
  const allowedOrgRole = await createRole({ scope: 'organization', orgId: allowedOrg.id, partnerId: partner.id });

  async function review(owner: { orgId: string | null; partnerId: string | null }, label: string) {
    const [row] = await adminDb
      .insert(accessReviews)
      .values({ ...owner, name: `review ${label} ${unique}` })
      .returning();
    return row;
  }
  async function item(reviewId: string, userId: string, roleId: string) {
    const [row] = await adminDb
      .insert(accessReviewItems)
      .values({ reviewId, userId, roleId, decision: 'pending' })
      .returning();
    return row;
  }

  const allowedReview = await review({ orgId: allowedOrg.id, partnerId: null }, 'allowed');
  const otherReview = await review({ orgId: otherOrg.id, partnerId: null }, 'other');
  const partnerReview = await review({ orgId: null, partnerId: partner.id }, 'partner');

  const allowedOrgUserItem = await item(allowedReview.id, allowedOrgUser.id, allowedOrgRole.id);
  const otherColleagueItem = await item(otherReview.id, colleague.id, otherOrgRole.id);
  const otherOrgUserItem = await item(otherReview.id, otherOrgUser.id, otherOrgRole.id);
  const partnerColleagueItem = await item(partnerReview.id, colleague.id, partnerRole.id);

  const techCtx: DbAccessContext = {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [allowedOrg.id],
    accessiblePartnerIds: [partner.id],
    userId: tech.id,
  };
  // The colleague under review, acting from an org session for allowedOrg —
  // a context that does not reach otherOrg's review.
  const colleagueOrgCtx: DbAccessContext = {
    scope: 'organization',
    orgId: allowedOrg.id,
    accessibleOrgIds: [allowedOrg.id],
    accessiblePartnerIds: [],
    userId: colleague.id,
  };
  const otherOrgCtx: DbAccessContext = {
    scope: 'organization',
    orgId: otherOrg.id,
    accessibleOrgIds: [otherOrg.id],
    accessiblePartnerIds: [],
    userId: otherOrgUser.id,
  };
  const fullPartnerCtx: DbAccessContext = {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [allowedOrg.id, otherOrg.id],
    accessiblePartnerIds: [partner.id],
    userId: tech.id,
  };

  return {
    partner,
    allowedOrg,
    otherOrg,
    colleague,
    otherOrgRole,
    allowedReview,
    otherReview,
    partnerReview,
    allowedOrgUserItem,
    otherColleagueItem,
    otherOrgUserItem,
    partnerColleagueItem,
    techCtx,
    colleagueOrgCtx,
    otherOrgCtx,
    fullPartnerCtx,
  };
}

async function adminItem(id: string) {
  const adminDb = getTestDb() as any;
  const [row] = await adminDb
    .select({ id: accessReviewItems.id, decision: accessReviewItems.decision })
    .from(accessReviewItems)
    .where(eq(accessReviewItems.id, id));
  return row as { id: string; decision: string } | undefined;
}

function visibleItemIds(ctx: DbAccessContext) {
  return withDbAccessContext(ctx, async () =>
    (await db.select({ id: accessReviewItems.id }).from(accessReviewItems)).map((r) => r.id).sort()
  );
}

function setDecision(ctx: DbAccessContext, id: string) {
  return withDbAccessContext(ctx, () =>
    db
      .update(accessReviewItems)
      .set({ decision: 'approved', reviewedAt: new Date() })
      .where(eq(accessReviewItems.id, id))
      .returning({ id: accessReviewItems.id })
  );
}

function deleteItem(ctx: DbAccessContext, id: string) {
  return withDbAccessContext(ctx, () =>
    db.delete(accessReviewItems).where(eq(accessReviewItems.id, id)).returning({ id: accessReviewItems.id })
  );
}

describe('access_review_items policies follow the parent review owner', () => {
  it('a selected-org partner session reads only items of reviews it can access', async () => {
    const f = await seed();
    const ids = await visibleItemIds(f.techCtx);
    expect(ids).toEqual([f.allowedOrgUserItem.id, f.partnerColleagueItem.id].sort());
  });

  it.each([
    ['partner staff', 'otherColleagueItem'],
    ['org user', 'otherOrgUserItem'],
  ] as const)('a selected-org partner session does not update the %s item of another org review', async (_l, key) => {
    const f = await seed();
    expect(await setDecision(f.techCtx, f[key].id)).toHaveLength(0);
    expect((await adminItem(f[key].id))?.decision).toBe('pending');
  });

  it('a selected-org partner session does not delete an item of another org review', async () => {
    const f = await seed();
    expect(await deleteItem(f.techCtx, f.otherColleagueItem.id)).toHaveLength(0);
    expect(await adminItem(f.otherColleagueItem.id)).toBeDefined();
  });

  it('a selected-org partner session does not add an item to another org review', async () => {
    const f = await seed();
    await expect(
      withDbAccessContext(f.techCtx, () =>
        db.insert(accessReviewItems).values({
          reviewId: f.otherReview.id,
          userId: f.colleague.id,
          roleId: f.otherOrgRole.id,
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('the user an item is about cannot read, update or delete it from a session outside the review owner', async () => {
    const f = await seed();
    expect(await visibleItemIds(f.colleagueOrgCtx)).not.toContain(f.otherColleagueItem.id);
    expect(await setDecision(f.colleagueOrgCtx, f.otherColleagueItem.id)).toHaveLength(0);
    expect(await deleteItem(f.colleagueOrgCtx, f.otherColleagueItem.id)).toHaveLength(0);
    expect((await adminItem(f.otherColleagueItem.id))?.decision).toBe('pending');
  });

  it('an org session reads and decides every item of its own org review', async () => {
    const f = await seed();
    const ids = await visibleItemIds(f.otherOrgCtx);
    expect(ids).toEqual([f.otherColleagueItem.id, f.otherOrgUserItem.id].sort());
    expect(await setDecision(f.otherOrgCtx, f.otherColleagueItem.id)).toHaveLength(1);
    expect((await adminItem(f.otherColleagueItem.id))?.decision).toBe('approved');
  });

  it('an org session does not read items of a partner-owned review', async () => {
    const f = await seed();
    expect(await visibleItemIds(f.otherOrgCtx)).not.toContain(f.partnerColleagueItem.id);
  });

  it('a full partner session reads every item and can add, decide and delete', async () => {
    const f = await seed();
    expect(await visibleItemIds(f.fullPartnerCtx)).toHaveLength(4);
    await withDbAccessContext(f.fullPartnerCtx, () =>
      db.insert(accessReviewItems).values({
        reviewId: f.otherReview.id,
        userId: f.colleague.id,
        roleId: f.otherOrgRole.id,
      })
    );
    expect(await setDecision(f.fullPartnerCtx, f.otherOrgUserItem.id)).toHaveLength(1);
    expect(await deleteItem(f.fullPartnerCtx, f.otherOrgUserItem.id)).toHaveLength(1);
  });

  it('an item cannot be moved to a review the session cannot access', async () => {
    const f = await seed();
    await expect(
      withDbAccessContext(f.techCtx, () =>
        db
          .update(accessReviewItems)
          .set({ reviewId: f.otherReview.id })
          .where(eq(accessReviewItems.id, f.allowedOrgUserItem.id))
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

describe('access_reviews has exactly one owner', () => {
  it('rejects a review with both an org and a partner owner', async () => {
    const adminDb = getTestDb() as any;
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await expect(
      adminDb.insert(accessReviews).values({ orgId: org.id, partnerId: partner.id, name: 'two owners' })
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('rejects a review with no owner', async () => {
    const adminDb = getTestDb() as any;
    await expect(adminDb.insert(accessReviews).values({ name: 'no owner' })).rejects.toMatchObject({
      cause: { code: '23514' },
    });
  });
});
