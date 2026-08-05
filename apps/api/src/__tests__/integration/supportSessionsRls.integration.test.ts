/**
 * support_sessions RLS — Shape 1 (direct org_id) enforcement, plus the
 * one-hidden-org-per-partner uniqueness that the whole feature rests on.
 *
 * Migrations under test:
 *   - 2026-08-13-a-quick-support-sessions.sql (table + 4 breeze_org_isolation_* policies)
 *   - 2026-08-13-b-quick-support-org-index.sql (organizations_partner_quick_support_uniq)
 *
 * Every one of these assertions is invisible to the mocked unit suites: they
 * mock `../db` wholesale, so no policy is ever evaluated and no partial index
 * is ever consulted. This file drives the REAL postgres.js pool as the
 * unprivileged `breeze_app` role (FORCE ROW LEVEL SECURITY), which is the only
 * place the tenancy contract is actually proven.
 *
 * Quick Support rows live in a HIDDEN per-partner org (organizations.type =
 * 'quick_support'), so the isolation question is not academic: a leak here
 * hands one MSP a live remote-assist credential trail belonging to another.
 *
 * NOTE ON VACUITY: every test builds its own partners/orgs/users from scratch
 * (no module-level memoized fixture), and the cross-tenant INSERT test proves
 * the byte-identical insert SUCCEEDS for the legitimate owner immediately
 * before asserting 42501 for the forger. A policy that denied everything —
 * or a fixture that silently reused one org — would fail that pairing.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { organizations, sites, supportSessions } from '../../db/schema';
import { createPartner, createUser } from './db-utils';

const createdSessions: string[] = [];
const createdSites: string[] = [];
const createdOrgs: string[] = [];

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

/**
 * The context a partner-scope technician request runs under. The hidden
 * Quick Support org is deliberately INSIDE accessibleOrgIds — that is what
 * lets a tech read back their own sessions (see quickSupportOrg.ts).
 */
function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

/**
 * Seed a hidden 'quick_support' org straight through the `breeze_app` pool
 * under a SYSTEM context (the same escalation the real provisioning path
 * uses).
 *
 * Deliberately not `getOrCreateQuickSupportOrg()`: this file must test the
 * DATABASE contract, so the fixture path must not be able to mask a missing
 * policy or index by taking a service-layer shortcut.
 */
async function seedQuickSupportOrg(partnerId: string): Promise<{ orgId: string; siteId: string }> {
  const [org] = await withDbAccessContext(SYSTEM_CTX, () =>
    db
      .insert(organizations)
      .values({
        partnerId,
        name: 'Quick Support',
        slug: `quick-support-${partnerId}`,
        type: 'quick_support',
        status: 'active',
      })
      .returning(),
  );
  if (!org) throw new Error('seedQuickSupportOrg: no org row');
  createdOrgs.push(org.id);

  const [site] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(sites).values({ orgId: org.id, name: 'Quick Support', timezone: 'UTC' }).returning(),
  );
  if (!site) throw new Error('seedQuickSupportOrg: no site row');
  createdSites.push(site.id);

  return { orgId: org.id, siteId: site.id };
}

/**
 * A complete, INDEPENDENT Quick Support tenant: partner + hidden org + tech
 * user. Never memoized — each test builds its own, so no shared fixture can
 * make a cross-tenant assertion pass by accident.
 */
async function seedTenant() {
  const partner = await createPartner();
  const { orgId } = await seedQuickSupportOrg(partner.id);
  // Explicit unique address: db-utils' default is `test-${Date.now()}` and
  // users.email is UNIQUE, so two tenants seeded in the same millisecond
  // would collide.
  const user = await createUser({
    partnerId: partner.id,
    email: `qs-rls-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@example.com`,
  });
  return { partnerId: partner.id, orgId, userId: user.id };
}

function sessionValues(orgId: string, userId: string, codeHash: string) {
  const now = Date.now();
  return {
    orgId,
    createdByUserId: userId,
    codeHash,
    codeExpiresAt: new Date(now + 15 * 60_000),
    hardExpiresAt: new Date(now + 8 * 3_600_000),
  };
}

/** Unique 64-char hex, matching the SHA-256 shape the real code hash uses. */
function fakeCodeHash(tag: string): string {
  return (tag + Math.random().toString(36).slice(2) + '0'.repeat(64)).slice(0, 64);
}

async function seedSession(orgId: string, userId: string): Promise<string> {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(supportSessions).values(sessionValues(orgId, userId, fakeCodeHash('seed'))).returning(),
  );
  if (!row) throw new Error('seedSession: no row');
  createdSessions.push(row.id);
  return row.id;
}

afterEach(async () => {
  if (createdSessions.length === 0 && createdSites.length === 0 && createdOrgs.length === 0) return;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    for (const id of createdSessions) {
      await db.delete(supportSessions).where(eq(supportSessions.id, id));
    }
    for (const id of createdSites) {
      await db.delete(sites).where(eq(sites.id, id));
    }
  });
  // Each organization delete gets its OWN transaction. Deleting an org fires
  // breeze_partner_export_organizations_delete, which takes a PARTNER export
  // lock — and the lock hierarchy forbids acquiring a partner lock once an
  // organization lock is already held in the same transaction. Batching these
  // with the deletes above (or with each other) raises
  // "partner export lock hierarchy violation".
  for (const id of createdOrgs) {
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.delete(organizations).where(eq(organizations.id, id)),
    );
  }
  createdSessions.length = 0;
  createdSites.length = 0;
  createdOrgs.length = 0;
});

describe('support_sessions RLS — Shape 1 direct org_id (2026-08-13-a migration)', () => {
  it('POSITIVE CONTROL: a partner reads its OWN hidden-org sessions under a normal (non-system) context', async () => {
    const a = await seedTenant();
    const sessionId = await seedSession(a.orgId, a.userId);

    const visible = await withDbAccessContext(partnerContext(a.partnerId, [a.orgId]), () =>
      db.select({ id: supportSessions.id, orgId: supportSessions.orgId }).from(supportSessions),
    );

    // Proves the suite is wired up and the SELECT policy is not simply
    // denying everything: without this, every isolation assertion below
    // would pass vacuously against a broken-shut policy.
    expect(visible.map((r) => r.id)).toContain(sessionId);
    expect(visible.every((r) => r.orgId === a.orgId)).toBe(true);
  });

  it('a partner-A context SELECTing partner-B sessions returns ZERO rows', async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const sessionA = await seedSession(a.orgId, a.userId);
    const sessionB = await seedSession(b.orgId, b.userId);

    // Both rows genuinely exist — a system read is the control for "the
    // isolation result below is about RLS, not about missing fixtures".
    const asSystem = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ id: supportSessions.id }).from(supportSessions),
    );
    expect(asSystem.map((r) => r.id)).toEqual(expect.arrayContaining([sessionA, sessionB]));

    const asA = await withDbAccessContext(partnerContext(a.partnerId, [a.orgId]), () =>
      db.select({ id: supportSessions.id }).from(supportSessions),
    );
    expect(asA.map((r) => r.id)).not.toContain(sessionB);

    // And targeting B's row by primary key directly is still zero rows —
    // a policy that only filtered unqualified scans would slip past the
    // assertion above.
    const targeted = await withDbAccessContext(partnerContext(a.partnerId, [a.orgId]), () =>
      db.select({ id: supportSessions.id }).from(supportSessions).where(eq(supportSessions.id, sessionB)),
    );
    expect(targeted).toEqual([]);
  });

  it('a forged INSERT into partner-B hidden org fails with SQLSTATE 42501 — while the identical insert succeeds for B itself', async () => {
    const a = await seedTenant();
    const b = await seedTenant();

    // Leg 1 (anti-vacuity): the EXACT same insert, same target org, run by
    // the org's rightful owner, must SUCCEED. If this leg ever fails the
    // 42501 below stops meaning "cross-tenant write denied".
    const legitimateHash = fakeCodeHash('legit');
    const [legit] = await withDbAccessContext(partnerContext(b.partnerId, [b.orgId]), () =>
      db.insert(supportSessions).values(sessionValues(b.orgId, b.userId, legitimateHash)).returning(),
    );
    expect(legit?.orgId).toBe(b.orgId);
    if (legit) createdSessions.push(legit.id);

    // Leg 2: partner A forges a row into B's hidden org. The WITH CHECK on
    // breeze_org_isolation_insert must reject it at the DB layer.
    // A distinct code_hash is used so a UNIQUE violation (23505) can never
    // be mistaken for the RLS denial we are asserting.
    let caught: unknown;
    try {
      await withDbAccessContext(partnerContext(a.partnerId, [a.orgId]), () =>
        db.insert(supportSessions).values(sessionValues(b.orgId, b.userId, fakeCodeHash('forged'))).returning(),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught, 'cross-tenant INSERT was NOT rejected').toBeDefined();
    const code = (caught as { code?: string; cause?: { code?: string } }).code
      ?? (caught as { cause?: { code?: string } }).cause?.code;
    expect(code).toBe('42501');

    // Nothing landed: the forged row must not exist even to a system reader.
    const forgedRows = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ id: supportSessions.id }).from(supportSessions).where(eq(supportSessions.orgId, b.orgId)),
    );
    expect(forgedRows).toHaveLength(1); // only the legitimate leg-1 row
  });

  it('a forged UPDATE of a partner-B row affects zero rows and leaves the row untouched', async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const sessionB = await seedSession(b.orgId, b.userId);

    // Control: B can update its own row, so the zero-row result below is
    // about the USING clause, not about a broken UPDATE statement.
    const ownUpdate = await withDbAccessContext(partnerContext(b.partnerId, [b.orgId]), () =>
      db
        .update(supportSessions)
        .set({ attributionLabel: 'set-by-owner' })
        .where(eq(supportSessions.id, sessionB))
        .returning(),
    );
    expect(ownUpdate).toHaveLength(1);

    const forged = await withDbAccessContext(partnerContext(a.partnerId, [a.orgId]), () =>
      db
        .update(supportSessions)
        .set({ status: 'ended', endedReason: 'forged-by-partner-a' })
        .where(eq(supportSessions.id, sessionB))
        .returning(),
    );
    expect(forged).toHaveLength(0);

    const [after] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(supportSessions).where(eq(supportSessions.id, sessionB)),
    );
    expect(after?.status).toBe('pending');
    expect(after?.endedReason).toBeNull();
    expect(after?.attributionLabel).toBe('set-by-owner');
  });

  it('a forged DELETE of a partner-B row affects zero rows', async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const sessionB = await seedSession(b.orgId, b.userId);

    const deleted = await withDbAccessContext(partnerContext(a.partnerId, [a.orgId]), () =>
      db.delete(supportSessions).where(eq(supportSessions.id, sessionB)).returning(),
    );
    expect(deleted).toHaveLength(0);

    const [survivor] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ id: supportSessions.id }).from(supportSessions).where(eq(supportSessions.id, sessionB)),
    );
    expect(survivor?.id).toBe(sessionB);
  });
});

describe('organizations_partner_quick_support_uniq — one hidden org per partner (2026-08-13-b migration)', () => {
  it('rejects a SECOND quick_support org for the same partner with SQLSTATE 23505', async () => {
    const partner = await createPartner();
    await seedQuickSupportOrg(partner.id);

    let caught: unknown;
    try {
      await withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(organizations)
          .values({
            partnerId: partner.id,
            name: 'Quick Support (duplicate)',
            // A DIFFERENT slug, so the failure can only come from the partial
            // unique index and never from organizations.slug's own UNIQUE.
            slug: `quick-support-dup-${partner.id}`,
            type: 'quick_support',
            status: 'active',
          })
          .returning(),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught, 'a second quick_support org was accepted').toBeDefined();
    const code = (caught as { code?: string; cause?: { code?: string } }).code
      ?? (caught as { cause?: { code?: string } }).cause?.code;
    expect(code).toBe('23505');

    const rows = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .select({ id: organizations.id })
        .from(organizations)
        .where(and(eq(organizations.partnerId, partner.id), eq(organizations.type, 'quick_support'))),
    );
    expect(rows).toHaveLength(1);
  });

  it('the index is PARTIAL: a second ORDINARY (customer) org for the same partner is still allowed', async () => {
    const partner = await createPartner();
    await seedQuickSupportOrg(partner.id);

    // Proves the uniqueness above is scoped to type='quick_support' and has
    // not accidentally become "one org per partner", which would break every
    // real MSP.
    const [first, second] = await withDbAccessContext(SYSTEM_CTX, async () => {
      const [a] = await db
        .insert(organizations)
        .values({ partnerId: partner.id, name: 'Cust A', slug: `cust-a-${partner.id}`, type: 'customer', status: 'active' })
        .returning();
      const [b] = await db
        .insert(organizations)
        .values({ partnerId: partner.id, name: 'Cust B', slug: `cust-b-${partner.id}`, type: 'customer', status: 'active' })
        .returning();
      return [a, b];
    });
    if (first) createdOrgs.push(first.id);
    if (second) createdOrgs.push(second.id);

    expect(first?.id).toBeDefined();
    expect(second?.id).toBeDefined();
    expect(first?.id).not.toBe(second?.id);
  });
});
