import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { m365Connections, m365UserConsentSessions } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';

/**
 * Behavioural tenant-isolation proof for the communications-delegated (user-axis) rows —
 * design §3.4, task 5.
 *
 * ## Why this file has to exist
 *
 * `m365_connections` is org-XOR-user by construction. The org half is covered by the
 * repo-wide contract suites, which auto-discover tables by their `org_id` column. A
 * user-owned row has `org_id NULL`, so those suites cannot see it — the coverage sweep, the
 * org cascade order, and the structural assertions added alongside the migration all
 * describe the *policy text*, never a row. `m365_user_consent_sessions` has no `org_id`
 * column at all and is invisible to them for the same reason.
 *
 * So a green run of `rls-coverage.integration.test.ts` is not evidence about any of this.
 * This file is the isolation proof for the user axis, and it is the only one.
 *
 * ## The assertion v1 of the design got backwards
 *
 * v1 proposed asserting that an org-scoped token must not see a user-owned row. That is
 * false, and writing it would have cemented a bug: human org-scoped contexts still set
 * `breeze.user_id`, so an org-scoped session belonging to the OWNER sees the owner's own row
 * — correctly. The real properties are narrower: a *different* user cannot see it at any
 * scope, and a keyed or no-user context cannot see it at all. Both are asserted below,
 * alongside the positive control that keeps a future "fix" from denying the owner too.
 *
 * Reassignment-by-UPDATE (owner rewriting `user_id` to another user) is proven in
 * `m365ConnectionsRls.integration.test.ts` and deliberately not duplicated here.
 */

const runDb = it.runIf(!!process.env.DATABASE_URL);
const ownerTenantId = '11111111-1111-4111-8111-111111111111';
const credentialVersion = '0123456789abcdef0123456789abcdef';

/** An ACTIVE communications-delegated row must pin tenant + Entra object id. */
function activeDelegatedRow(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    orgId: null,
    userId,
    tenantId: ownerTenantId,
    delegatedUserObjectId: randomUUID(),
    consentAttemptId: randomUUID(),
    clientId: '22222222-2222-4222-8222-222222222222',
    clientSecret: null,
    profile: 'communications-delegated' as const,
    authMode: 'delegated' as const,
    credentialDomain: 'communications-delegated' as const,
    vaultRef: `akv://vault.example/m365-communications-delegated/${credentialVersion}`,
    credentialVersion,
    permissionManifestVersion: 2,
    status: 'active' as const,
    ...overrides,
  };
}

async function seedFixture() {
  return withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const orgA2 = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });

    const unique = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const owner = await createUser({
      partnerId: partnerA.id, orgId: orgA.id, email: `comms-owner-${unique}@example.com`,
    });
    const sameOrgPeer = await createUser({
      partnerId: partnerA.id, orgId: orgA.id, email: `comms-peer-same-org-${unique}@example.com`,
    });
    const samePartnerPeer = await createUser({
      partnerId: partnerA.id, orgId: orgA2.id, email: `comms-peer-same-partner-${unique}@example.com`,
    });
    const foreigner = await createUser({
      partnerId: partnerB.id, orgId: orgB.id, email: `comms-foreign-${unique}@example.com`,
    });
    // Target for the forged-insert test: owns no connection and backs no context below, so
    // nothing can insert on its behalf legitimately and no unique index can be what refuses.
    const bystander = await createUser({
      partnerId: partnerA.id, orgId: orgA.id, email: `comms-bystander-${unique}@example.com`,
    });

    const [connection] = await db.insert(m365Connections)
      .values(activeDelegatedRow(owner.id))
      .returning({
        id: m365Connections.id,
        userId: m365Connections.userId,
        consentAttemptId: m365Connections.consentAttemptId,
        status: m365Connections.status,
      });
    if (!connection) throw new Error('failed to seed the owner connection');

    const [session] = await db.insert(m365UserConsentSessions).values({
      stateHash: 'a'.repeat(64),
      phase: 'delegated_consent',
      connectionId: connection.id,
      userId: owner.id,
      profile: 'communications-delegated',
      consentAttemptId: connection.consentAttemptId!,
      nonce: 'n'.repeat(43),
      codeVerifier: 'v'.repeat(43),
      expiresAt: new Date(Date.now() + 300_000),
    }).returning({ id: m365UserConsentSessions.id });
    if (!session) throw new Error('failed to seed the owner consent session');

    const orgScope = (orgId: string, userId: string | null): DbAccessContext => ({
      scope: 'organization',
      orgId,
      accessibleOrgIds: [orgId],
      accessiblePartnerIds: [],
      userId,
    });

    // Every context that is NOT the owner. Each must be blind to the owner's row, and the
    // reason differs per entry — which is the point of running the same assertions across
    // all of them rather than picking one representative.
    const nonOwnerContexts: Array<[string, DbAccessContext]> = [
      // Same org as the owner: the org branch of the policy cannot help, because the row's
      // org_id is NULL.
      ['same-org peer', orgScope(orgA.id, sameOrgPeer.id)],
      // Same partner, different org.
      ['same-partner peer', orgScope(orgA2.id, samePartnerPeer.id)],
      // Partner scope over the whole partner — the widest tenant scope available.
      ['partner-scope peer', {
        scope: 'partner',
        orgId: null,
        accessibleOrgIds: [orgA.id, orgA2.id],
        accessiblePartnerIds: [partnerA.id],
        currentPartnerId: partnerA.id,
        userId: sameOrgPeer.id,
      }],
      ['foreign partner', orgScope(orgB.id, foreigner.id)],
      // §3.4 assertion 2, and the one nothing else covers: API keys, agents and system jobs
      // open a context with NO breeze.user_id. `breeze_current_user_id()` returns NULL and
      // `user_id = NULL` is NULL, so the user branch never matches. An API key carries its
      // creator's user id at the APPLICATION layer (mcpServer.ts), which is precisely why
      // the database must not be the thing that lets it through.
      ['keyed org (no user)', orgScope(orgA.id, null)],
      ['keyed partner (no user)', {
        scope: 'partner',
        orgId: null,
        accessibleOrgIds: [orgA.id, orgA2.id],
        accessiblePartnerIds: [partnerA.id],
        currentPartnerId: partnerA.id,
        userId: null,
      }],
    ];

    return {
      partnerA,
      orgA,
      owner,
      sameOrgPeer,
      bystander,
      connection,
      session,
      ownerOrgContext: orgScope(orgA.id, owner.id),
      ownerPartnerContext: {
        scope: 'partner' as const,
        orgId: null,
        accessibleOrgIds: [orgA.id, orgA2.id],
        accessiblePartnerIds: [partnerA.id],
        currentPartnerId: partnerA.id,
        userId: owner.id,
      },
      nonOwnerContexts,
    };
  });
}

describe('m365_connections user axis — cross-user isolation', () => {
  runDb('runs code-under-test as breeze_app without BYPASSRLS', async () => {
    // Without this every denial below could be vacuous for the wrong reason.
    const fx = await seedFixture();
    const rows = await withDbAccessContext(fx.ownerOrgContext, () => db.execute(
      sql`SELECT current_user AS who, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    ));
    expect((rows as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0])
      .toEqual({ who: 'breeze_app', rolbypassrls: false });
  });

  runDb('lets the owner read and update their own row at org and partner scope', async () => {
    // The positive control. An org-scoped human token DOES see its owner's user-owned row,
    // because the context sets breeze.user_id — see the header note on the v1 assertion.
    // Without this, tightening the policy to deny everyone would look like a pass.
    const fx = await seedFixture();

    for (const [label, context] of [
      ['org scope', fx.ownerOrgContext] as const,
      ['partner scope', fx.ownerPartnerContext] as const,
    ]) {
      const visible = await withDbAccessContext(context, () =>
        db.select({ id: m365Connections.id }).from(m365Connections)
          .where(eq(m365Connections.id, fx.connection.id)));
      expect(visible, `${label} SELECT`).toEqual([{ id: fx.connection.id }]);
    }

    const updated = await withDbAccessContext(fx.ownerOrgContext, () =>
      db.update(m365Connections).set({ status: 'degraded' })
        .where(eq(m365Connections.id, fx.connection.id))
        .returning({ status: m365Connections.status }));
    expect(updated).toEqual([{ status: 'degraded' }]);
  });

  runDb('hides the row from every non-owning context, keyed contexts included', async () => {
    const fx = await seedFixture();
    for (const [label, context] of fx.nonOwnerContexts) {
      const rows = await withDbAccessContext(context, () =>
        db.select({ id: m365Connections.id }).from(m365Connections)
          .where(eq(m365Connections.id, fx.connection.id)));
      expect(rows, `${label} SELECT`).toEqual([]);
    }
  });

  runDb('silently affects zero rows on a non-owner UPDATE or DELETE, leaving the row intact', async () => {
    // RLS filters rather than raising for UPDATE/DELETE, so these come back as an empty
    // result and NOT an error. A caller that treats "no exception" as success would report a
    // status change or a disconnect that never happened, which is why the row is re-read
    // here rather than trusting the empty return.
    const fx = await seedFixture();
    for (const [label, context] of fx.nonOwnerContexts) {
      const updated = await withDbAccessContext(context, () =>
        db.update(m365Connections).set({ status: 'revoked' })
          .where(eq(m365Connections.id, fx.connection.id))
          .returning({ id: m365Connections.id }));
      expect(updated, `${label} UPDATE`).toEqual([]);

      const deleted = await withDbAccessContext(context, () =>
        db.delete(m365Connections)
          .where(eq(m365Connections.id, fx.connection.id))
          .returning({ id: m365Connections.id }));
      expect(deleted, `${label} DELETE`).toEqual([]);
    }

    const [after] = await withSystemDbAccessContext(() => db.select({
      id: m365Connections.id,
      userId: m365Connections.userId,
      status: m365Connections.status,
    }).from(m365Connections).where(eq(m365Connections.id, fx.connection.id)));
    expect(after).toEqual({
      id: fx.connection.id,
      userId: fx.owner.id,
      status: 'active',
    });
  });

  runDb('rejects a forged insert on behalf of another user with 42501', async () => {
    // The row is bound to a bystander: a real user who owns no connection and backs none of
    // these contexts. That makes RLS the only thing that can refuse it — the row is
    // otherwise valid, and the unique index on (user_id, profile) has nothing to collide
    // with. Targeting the owner instead would have muddied it, since the insert would also
    // violate that index and the code could come from either check.
    const fx = await seedFixture();
    for (const [label, context] of fx.nonOwnerContexts) {
      await expect(
        withDbAccessContext(context, () => db.insert(m365Connections)
          .values(activeDelegatedRow(fx.bystander.id))),
        `${label} INSERT`,
      ).rejects.toMatchObject({ cause: { code: '42501' } });
    }
  });
});

describe('m365_user_consent_sessions — system-only, behaviourally', () => {
  runDb('refuses every tenant scope, including the owning user', async () => {
    // The rows hold a live PKCE code_verifier and nonce: material for completing someone's
    // sign-in. The owner is included on purpose — a session token that could read its own
    // verifier is a session token that can be replayed against the callback, so "it's their
    // own data" is not a reason to allow it.
    const fx = await seedFixture();
    const contexts: Array<[string, DbAccessContext]> = [
      ['owner org scope', fx.ownerOrgContext],
      ['owner partner scope', fx.ownerPartnerContext],
      ...fx.nonOwnerContexts,
    ];

    for (const [label, context] of contexts) {
      const selected = await withDbAccessContext(context, () =>
        db.select({ id: m365UserConsentSessions.id }).from(m365UserConsentSessions)
          .where(eq(m365UserConsentSessions.id, fx.session.id)));
      expect(selected, `${label} SELECT`).toEqual([]);

      await expect(
        withDbAccessContext(context, () => db.insert(m365UserConsentSessions).values({
          stateHash: 'b'.repeat(64),
          phase: 'delegated_consent',
          connectionId: fx.connection.id,
          userId: fx.owner.id,
          profile: 'communications-delegated',
          consentAttemptId: fx.connection.consentAttemptId!,
          nonce: 'n'.repeat(43),
          codeVerifier: 'v'.repeat(43),
          expiresAt: new Date(Date.now() + 300_000),
        })),
        `${label} INSERT`,
      ).rejects.toMatchObject({ cause: { code: '42501' } });

      const updated = await withDbAccessContext(context, () =>
        db.update(m365UserConsentSessions).set({ expiresAt: new Date(Date.now() + 600_000) })
          .where(eq(m365UserConsentSessions.id, fx.session.id))
          .returning({ id: m365UserConsentSessions.id }));
      expect(updated, `${label} UPDATE`).toEqual([]);

      const deleted = await withDbAccessContext(context, () =>
        db.delete(m365UserConsentSessions)
          .where(eq(m365UserConsentSessions.id, fx.session.id))
          .returning({ id: m365UserConsentSessions.id }));
      expect(deleted, `${label} DELETE`).toEqual([]);
    }

    // The row survived all of it — the empty UPDATE/DELETE returns above were denials, not
    // deletions that happened to report nothing.
    const stillThere = await withSystemDbAccessContext(() =>
      db.select({ id: m365UserConsentSessions.id }).from(m365UserConsentSessions)
        .where(eq(m365UserConsentSessions.id, fx.session.id)));
    expect(stillThere).toEqual([{ id: fx.session.id }]);
  });

  runDb('allows the system context to read and write', async () => {
    // The counterweight: a table nothing can reach is not the goal, and the consent flow
    // runs in a system context.
    const fx = await seedFixture();
    const updated = await withSystemDbAccessContext(() =>
      db.update(m365UserConsentSessions).set({ expiresAt: new Date(Date.now() + 900_000) })
        .where(eq(m365UserConsentSessions.id, fx.session.id))
        .returning({ id: m365UserConsentSessions.id }));
    expect(updated).toEqual([{ id: fx.session.id }]);
  });

  runDb('cannot attach a session to a connection owned by a different user', async () => {
    // The composite FK (connection_id, user_id, profile, consent_attempt_id) is what stops a
    // consent session from being hung off someone else's mailbox — a system-context bug in
    // the consent flow would otherwise redeem one user's authorization code against another
    // user's connection. Enforceable only because all four columns are NOT NULL: under MATCH
    // SIMPLE a single NULL would disable the constraint entirely.
    const fx = await seedFixture();
    await expect(withSystemDbAccessContext(() => db.insert(m365UserConsentSessions).values({
      stateHash: 'c'.repeat(64),
      phase: 'delegated_consent',
      connectionId: fx.connection.id,
      userId: fx.sameOrgPeer.id,
      profile: 'communications-delegated',
      consentAttemptId: fx.connection.consentAttemptId!,
      nonce: 'n'.repeat(43),
      codeVerifier: 'v'.repeat(43),
      expiresAt: new Date(Date.now() + 300_000),
    }))).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  runDb('cascades sessions away when the connection is deleted', async () => {
    // This table carries neither org_id nor device_id, so it appears in NO cascade list —
    // CORE_ORG_CASCADE_DELETE_ORDER and the device lists cannot see it. FK CASCADE from
    // m365_connections and from users is therefore the entire erasure story, and it is
    // asserted rather than assumed.
    const fx = await seedFixture();
    await withSystemDbAccessContext(() => db.delete(m365Connections)
      .where(eq(m365Connections.id, fx.connection.id)));

    const remaining = await withSystemDbAccessContext(() =>
      db.select({ id: m365UserConsentSessions.id }).from(m365UserConsentSessions)
        .where(eq(m365UserConsentSessions.id, fx.session.id)));
    expect(remaining).toEqual([]);
  });
});
