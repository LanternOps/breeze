/**
 * Real-Postgres coverage for `resolveRecipientLocale` (#3860, PR #3918 review).
 *
 * THE BUG CLASS (#2822). `partners` is a partner-axis table gated by
 * `breeze_has_partner_access(id)`, and `users` requires partner access, a
 * non-null `org_id` the caller can reach, or self. Under an org-scoped
 * context — every org JWT, agent, portal, and client-AI request — the partner
 * hop returns ZERO rows and a partner-staff recipient (`org_id IS NULL`) is
 * invisible. Neither raises; the resolver silently collapsed to `'en'` for
 * exactly the recipients the feature was meant to serve.
 *
 * A mocked-DB unit test is structurally incapable of catching this (the mock
 * returns whatever row the test stages, with no RLS evaluation), so each
 * context shape the resolver is documented to run under is proven here against
 * the real unprivileged `breeze_app` role: system, org-scoped, and contextless.
 *
 * The first test is the PREMISE PROOF: it asserts the raw rows really are
 * invisible in the org context. Without it, a later change that widened the
 * RLS policy would make every other test here pass vacuously.
 */
import './setup';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { organizations, partners, users } from '../../db/schema';
import { buildDbAccessContext } from '../../middleware/auth';
import { resolveRecipientLocale } from '../../services/recipientLocale';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/** The context a real org-scoped JWT request runs under (production builder,
 *  so the fixture tracks `computeAccessiblePartnerIds` if it ever changes). */
function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return buildDbAccessContext({
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    partnerId,
    userId: null,
  });
}

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

interface Fixture {
  partnerId: string;
  orgId: string;
  /** Partner-level staff: `org_id IS NULL`, `preferences.locale = 'de-DE'`. */
  partnerStaffUserId: string;
  /** Org member with no locale preference — falls through to org/partner. */
  orgUserId: string;
}

let fx: Fixture;

beforeEach(async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  fx = await withSystemDbAccessContext(async () => {
    const [partner] = await db
      .insert(partners)
      .values({
        name: `RL Partner ${unique}`,
        slug: `rl-partner-${unique}`,
        type: 'msp',
        plan: 'pro',
        status: 'active',
        // Deliberately NOT 'en' so the fallback is distinguishable from a hit.
        settings: { language: 'pt-BR' },
      })
      .returning({ id: partners.id });

    const [org] = await db
      .insert(organizations)
      .values({
        currencyCode: 'USD',
        partnerId: partner!.id,
        name: `RL Org ${unique}`,
        slug: `rl-org-${unique}`,
        type: 'customer',
        status: 'active',
        // No language: the org hop must fall through to the partner.
        settings: {},
      })
      .returning({ id: organizations.id });

    const [staff] = await db
      .insert(users)
      .values({
        partnerId: partner!.id,
        orgId: null,
        email: `rl-staff-${unique}@example.com`,
        name: 'RL Staff',
        preferences: { locale: 'de-DE' },
      })
      .returning({ id: users.id });

    const [member] = await db
      .insert(users)
      .values({
        partnerId: partner!.id,
        orgId: org!.id,
        email: `rl-member-${unique}@example.com`,
        name: 'RL Member',
        preferences: {},
      })
      .returning({ id: users.id });

    return {
      partnerId: partner!.id,
      orgId: org!.id,
      partnerStaffUserId: staff!.id,
      orgUserId: member!.id,
    };
  });
});

afterEach(async () => {
  if (!fx) return;
  await withSystemDbAccessContext(async () => {
    await db.delete(users).where(eq(users.id, fx.partnerStaffUserId));
    await db.delete(users).where(eq(users.id, fx.orgUserId));
    await db.delete(organizations).where(eq(organizations.id, fx.orgId));
    await db.delete(partners).where(eq(partners.id, fx.partnerId));
  });
  fx = undefined as unknown as Fixture;
});

describe('premise — the partner row and partner-staff user are invisible to an org-scoped context', () => {
  runDb('raw SELECTs return ZERO rows, without raising', async () => {
    await withDbAccessContext(orgContext(fx.orgId, fx.partnerId), async () => {
      // Sanity: the org row IS visible, so zero below is RLS, not a dead fixture.
      expect(
        await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, fx.orgId)),
      ).toHaveLength(1);

      expect(
        await db.select({ id: partners.id }).from(partners).where(eq(partners.id, fx.partnerId)),
      ).toHaveLength(0);

      expect(
        await db.select({ id: users.id }).from(users).where(eq(users.id, fx.partnerStaffUserId)),
      ).toHaveLength(0);
    });
  });
});

describe('resolveRecipientLocale — org-scoped context (the #2822 trap)', () => {
  runDb('resolves the PARTNER language instead of collapsing to en', async () => {
    const locale = await withDbAccessContext(orgContext(fx.orgId, fx.partnerId), () =>
      resolveRecipientLocale({ userId: fx.orgUserId, orgId: fx.orgId, partnerId: fx.partnerId }),
    );
    expect(locale).toBe('pt-BR');
  });

  runDb('resolves a partner-staff recipient (org_id NULL) user preference', async () => {
    const locale = await withDbAccessContext(orgContext(fx.orgId, fx.partnerId), () =>
      resolveRecipientLocale({ userId: fx.partnerStaffUserId, partnerId: fx.partnerId }),
    );
    expect(locale).toBe('de-DE');
  });
});

describe('resolveRecipientLocale — system context (worker path)', () => {
  runDb('resolves partner language via the org fall-through', async () => {
    const locale = await withDbAccessContext(SYSTEM_CTX, () =>
      resolveRecipientLocale({ userId: fx.orgUserId, orgId: fx.orgId, partnerId: fx.partnerId }),
    );
    expect(locale).toBe('pt-BR');
  });

  runDb('user preference wins over partner language', async () => {
    const locale = await withSystemDbAccessContext(() =>
      resolveRecipientLocale({ userId: fx.partnerStaffUserId, partnerId: fx.partnerId }),
    );
    expect(locale).toBe('de-DE');
  });
});

describe('resolveRecipientLocale — no ambient context', () => {
  runDb('throws instead of silently resolving en for everyone', async () => {
    await expect(
      resolveRecipientLocale({ userId: fx.orgUserId, orgId: fx.orgId, partnerId: fx.partnerId }),
    ).rejects.toThrow(/DB access context/);
  });

  runDb('still short-circuits on an explicit locale (no DB read needed)', async () => {
    await expect(resolveRecipientLocale({ explicit: 'fr-CA', orgId: fx.orgId })).resolves.toBe('fr-CA');
  });
});
