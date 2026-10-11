/**
 * Ticket migration windows (#8313, wave 1a) against real Postgres, as the
 * unprivileged `breeze_app` role (setup.ts), so RLS and the composite FKs are
 * really in force.
 *
 * Migration under test: 2026-12-23-110000-migration-windows.sql
 *
 * Proves:
 *   - open: owner-only, keyless principal with tickets:write, active orgs of
 *     the partner only, one open window per partner (service check AND the
 *     partial unique index), opener epochs snapshotted;
 *   - key issue/rotate are refused while a window is open for the principal;
 *   - RLS: another partner can neither see nor forge a window; the composite
 *     FK refuses an org of another partner even in system scope;
 *   - the import write's FOR SHARE lock works under the partner context (it
 *     depends on the UPDATE policy — spec §3.6);
 *   - close vs write, two connections, both orders: a close waits for a
 *     holder of FOR SHARE, and a FOR SHARE taken during a close sees it closed;
 *   - close: per-org counts, frozen summary, partner-level audit row;
 *   - the sweep closes on every condition and publishes one
 *     `migration.window_closed` per org, exactly once.
 */
import './setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

type Published = { type: string; orgId: string; payload: Record<string, unknown>; eventId?: string };
const published = vi.hoisted(() => [] as Published[]);
vi.mock('../../services/eventBus', async (orig) => ({
  ...(await orig<typeof import('../../services/eventBus')>()),
  publishEvent: async (type: string, orgId: string, payload: Record<string, unknown>, _source: string, options?: { eventId?: string }) => {
    published.push({ type, orgId, payload, eventId: options?.eventId });
    return options?.eventId ?? 'evt';
  },
}));

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  auditLogs,
  migrationWindowOrgs,
  migrationWindows,
  organizations,
  partnerServicePrincipalKeys,
  partnerServicePrincipals,
  partnerUsers,
  ticketComments,
  tickets,
  users,
} from '../../db/schema';
import {
  closeMigrationWindow,
  openMigrationWindow,
  sweepMigrationWindows,
} from '../../services/migrationWindows';
import { issuePartnerServicePrincipalKey } from '../../services/partnerServicePrincipalKeys';
import type { Database } from '../../db';
import { assignUserToPartner, createOrganization, createPartner, createRole, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const DAY = 86_400_000;
let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;

async function partnerAdmin(partnerId: string, orgAccess: 'all' | 'selected' = 'all') {
  const user = await createUser({ partnerId, orgId: null, email: `${uniq('mw')}@example.test` });
  const role = await createRole({ scope: 'partner', partnerId });
  await assignUserToPartner(user.id, partnerId, role.id, orgAccess);
  return user;
}

async function seed() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const owner = await partnerAdmin(partner.id);
  const [principal] = await getTestDb().insert(partnerServicePrincipals).values({
    partnerId: partner.id,
    name: uniq('Import'),
    scopes: ['tickets:read', 'tickets:write'],
    createdBy: owner.id,
    updatedBy: owner.id,
  }).returning();
  const context = (userId: string = owner.id): DbAccessContext => ({
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [orgA.id, orgB.id],
    accessiblePartnerIds: [partner.id],
    currentPartnerId: partner.id,
    userId,
  });
  return { partner, orgA, orgB, owner, principal: principal!, context };
}

type Fx = Awaited<ReturnType<typeof seed>>;

async function epochsOf(userId: string) {
  const [row] = await getTestDb().select({ authEpoch: users.authEpoch, mfaEpoch: users.mfaEpoch, credentialEpoch: users.credentialEpoch })
    .from(users).where(eq(users.id, userId));
  return row!;
}

async function open(fx: Fx, overrides: Partial<Parameters<typeof openMigrationWindow>[0]> = {}, asUser = fx.owner.id) {
  const epochs = await epochsOf(asUser);
  return withDbAccessContext(fx.context(asUser), () => openMigrationWindow({
    partnerId: fx.partner.id,
    principalId: fx.principal.id,
    orgIds: [fx.orgB.id, fx.orgA.id],
    endsAt: new Date(Date.now() + 2 * DAY),
    sourceLabel: 'zammad',
    opener: { userId: asUser, authEpoch: epochs.authEpoch, mfaEpoch: epochs.mfaEpoch },
    stepUp: null,
    ...overrides,
  }));
}

async function causeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    const e = err as { cause?: { message?: string }; message?: string };
    return e.cause?.message ?? e.message;
  }
}

function settledWithin<T>(p: Promise<T>, ms: number): Promise<boolean> {
  return Promise.race([p.then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
}

describe('migration windows (real Postgres, as breeze_app)', () => {
  beforeEach(() => {
    published.length = 0;
  });

  runDb('the owner opens a window for a keyless principal; its orgs and the opener epochs are recorded', async () => {
    const fx = await seed();
    const view = await open(fx);
    expect(view).toMatchObject({ partnerId: fx.partner.id, principalId: fx.principal.id, status: 'open', writesPerHour: 6000 });
    expect(view.orgIds).toEqual([fx.orgA.id, fx.orgB.id].sort());
    const [row] = await getTestDb().select().from(migrationWindows).where(eq(migrationWindows.id, view.id));
    const epochs = await epochsOf(fx.owner.id);
    expect(row).toMatchObject({ openedBy: fx.owner.id, openerCredentialEpoch: epochs.credentialEpoch, openerMfaEpoch: epochs.mfaEpoch });
    const orgRows = await getTestDb().select().from(migrationWindowOrgs).where(eq(migrationWindowOrgs.windowId, view.id));
    expect(orgRows).toHaveLength(2);
  });

  runDb('only the owner may open; the principal must be keyless and hold tickets:write; orgs must be active orgs of the partner', async () => {
    const fx = await seed();
    const otherAdmin = await partnerAdmin(fx.partner.id);
    await expect(open(fx, {}, otherAdmin.id)).rejects.toMatchObject({ code: 'SERVICE_PRINCIPAL_OWNER_REQUIRED', status: 403 });

    const [key] = await getTestDb().insert(partnerServicePrincipalKeys).values({
      partnerServicePrincipalId: fx.principal.id, partnerId: fx.partner.id, name: 'live', keyHash: uniq('h'),
      keyPrefix: 'brz_sp_test', createdBy: fx.owner.id, ownerCredentialEpoch: 1, ownerMfaEpoch: 1, status: 'active',
    }).returning();
    await expect(open(fx)).rejects.toMatchObject({ code: 'MIGRATION_WINDOW_PRINCIPAL_HAS_KEY', status: 409 });
    await getTestDb().update(partnerServicePrincipalKeys).set({ status: 'revoked', revokedAt: new Date() })
      .where(eq(partnerServicePrincipalKeys.id, key!.id));

    await getTestDb().update(partnerServicePrincipals).set({ scopes: ['tickets:read'] }).where(eq(partnerServicePrincipals.id, fx.principal.id));
    await expect(open(fx)).rejects.toMatchObject({ code: 'MIGRATION_WINDOW_PRINCIPAL_SCOPE_MISSING' });
    await getTestDb().update(partnerServicePrincipals).set({ scopes: ['tickets:write'] }).where(eq(partnerServicePrincipals.id, fx.principal.id));

    const foreign = await createOrganization({ partnerId: (await createPartner()).id });
    await expect(open(fx, { orgIds: [fx.orgA.id, foreign.id] }))
      .rejects.toMatchObject({ code: 'MIGRATION_WINDOW_ORG_NOT_ALLOWED', details: { orgIds: [foreign.id] } });
    await getTestDb().update(organizations).set({ status: 'suspended' }).where(eq(organizations.id, fx.orgB.id));
    await expect(open(fx)).rejects.toMatchObject({ code: 'MIGRATION_WINDOW_ORG_NOT_ALLOWED', details: { orgIds: [fx.orgB.id] } });
    await getTestDb().update(organizations).set({ status: 'active' }).where(eq(organizations.id, fx.orgB.id));

    await expect(open(fx, { endsAt: new Date(Date.now() + 15 * DAY) })).rejects.toMatchObject({ code: 'MIGRATION_WINDOW_INVALID_SPAN' });
    // Every refusal above wrote nothing.
    expect(await getTestDb().select().from(migrationWindows).where(eq(migrationWindows.partnerId, fx.partner.id))).toEqual([]);
  });

  runDb('one open window per partner: the service refuses, and the partial unique index is the backstop', async () => {
    const fx = await seed();
    const first = await open(fx);
    await expect(open(fx)).rejects.toMatchObject({ code: 'MIGRATION_WINDOW_ALREADY_OPEN', status: 409 });
    const cause = await causeOf(() => withSystemDbAccessContext(() => db.insert(migrationWindows).values({
      partnerId: fx.partner.id, partnerServicePrincipalId: fx.principal.id, sourceLabel: 'dup', endsAt: new Date(Date.now() + DAY),
      writesPerHour: 6000, openedBy: fx.owner.id, openerCredentialEpoch: 1, openerMfaEpoch: 1,
    })));
    expect(cause).toMatch(/migration_windows_one_open_per_partner/);
    // Closed windows do not count.
    await withDbAccessContext(fx.context(), () => db.transaction((tx) => closeMigrationWindow(tx, {
      windowId: first.id, partnerId: fx.partner.id, reason: 'closed_by_admin', closedBy: fx.owner.id,
    })));
    await expect(open(fx)).resolves.toMatchObject({ status: 'open' });
  });

  runDb('no key can be issued for the principal while its window is open', async () => {
    const fx = await seed();
    const window = await open(fx);
    const epochs = await epochsOf(fx.owner.id);
    const issue = () => withDbAccessContext(fx.context(), () => issuePartnerServicePrincipalKey(db as unknown as Database, {
      partnerServicePrincipalId: fx.principal.id, partnerId: fx.partner.id, name: 'mirror', actorId: fx.owner.id,
      actorSessionEpochs: { authEpoch: epochs.authEpoch, mfaEpoch: epochs.mfaEpoch },
    }));
    await expect(issue()).rejects.toMatchObject({ code: 'MIGRATION_WINDOW_ACTIVE', status: 409 });
    await withDbAccessContext(fx.context(), () => db.transaction((tx) => closeMigrationWindow(tx, {
      windowId: window.id, partnerId: fx.partner.id, reason: 'closed_by_admin', closedBy: fx.owner.id,
    })));
    await expect(issue()).resolves.toMatchObject({ keyPrefix: expect.stringMatching(/^brz_sp_/) });
  });

  runDb('RLS: another partner neither sees nor forges a window; the composite FK pins orgs to the window partner', async () => {
    const fx = await seed();
    const window = await open(fx);
    const other = await seed();

    const seen = await withDbAccessContext(other.context(), () => db.select().from(migrationWindows).where(eq(migrationWindows.id, window.id)));
    expect(seen).toEqual([]);
    const seenOrgs = await withDbAccessContext(other.context(), () => db.select().from(migrationWindowOrgs).where(eq(migrationWindowOrgs.windowId, window.id)));
    expect(seenOrgs).toEqual([]);

    const forged = await causeOf(() => withDbAccessContext(other.context(), () => db.insert(migrationWindows).values({
      partnerId: fx.partner.id, partnerServicePrincipalId: fx.principal.id, sourceLabel: 'forge', endsAt: new Date(Date.now() + DAY),
      writesPerHour: 6000, openedBy: other.owner.id, openerCredentialEpoch: 1, openerMfaEpoch: 1, status: 'closed',
      closedAt: new Date(), closedReason: 'closed_by_admin',
    })));
    expect(forged).toMatch(/row-level security/);
    const forgedOrg = await causeOf(() => withDbAccessContext(other.context(), () => db.insert(migrationWindowOrgs).values({
      windowId: window.id, partnerId: fx.partner.id, orgId: other.orgA.id,
    })));
    expect(forgedOrg).toMatch(/row-level security/);
    // Even system scope cannot point a window at another partner's org.
    const crossOrg = await causeOf(() => withSystemDbAccessContext(() => db.insert(migrationWindowOrgs).values({
      windowId: window.id, partnerId: fx.partner.id, orgId: other.orgA.id,
    })));
    expect(crossOrg).toMatch(/migration_window_orgs_org_fk/);
  });

  runDb('the import write lock (FOR SHARE) works under the partner context — it depends on the UPDATE policy', async () => {
    const fx = await seed();
    const window = await open(fx);
    const rows = await withDbAccessContext(fx.context(), () => db.execute(
      sql`SELECT id, status FROM migration_windows WHERE id = ${window.id} FOR SHARE`,
    ));
    expect(Array.from(rows as unknown as Array<{ id: string; status: string }>)).toEqual([{ id: window.id, status: 'open' }]);
  });

  runDb('close vs write, two connections: a close waits for a FOR SHARE holder', async () => {
    const fx = await seed();
    const window = await open(fx);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const hasLock = new Promise<void>((r) => { locked = r; });

    const writer = withDbAccessContext(fx.context(), async () => {
      await db.execute(sql`SELECT id FROM migration_windows WHERE id = ${window.id} AND status = 'open' FOR SHARE`);
      locked();
      await gate;
    });
    await hasLock;
    const closer = withSystemDbAccessContext(() => db.transaction((tx) => closeMigrationWindow(tx, {
      windowId: window.id, reason: 'expired', closedBy: null,
    })));
    expect(await settledWithin(closer, 400)).toBe(false);
    release();
    await writer;
    await expect(closer).resolves.toMatchObject({ alreadyClosed: false, window: { status: 'closed' } });
  });

  runDb('close vs write, two connections: a FOR SHARE taken during a close sees the window closed', async () => {
    const fx = await seed();
    const window = await open(fx);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let closedInTx!: () => void;
    const hasClosed = new Promise<void>((r) => { closedInTx = r; });

    const closer = withSystemDbAccessContext(() => db.transaction(async (tx) => {
      const result = await closeMigrationWindow(tx, { windowId: window.id, reason: 'closed_by_admin', closedBy: fx.owner.id });
      closedInTx();
      await gate;
      return result;
    }));
    await hasClosed;
    const writer = withDbAccessContext(fx.context(), () => db.execute(
      sql`SELECT status FROM migration_windows WHERE id = ${window.id} FOR SHARE`,
    ));
    expect(await settledWithin(writer, 400)).toBe(false);
    release();
    await closer;
    const rows = Array.from((await writer) as unknown as Array<{ status: string }>);
    expect(rows).toEqual([{ status: 'closed' }]);
  });

  runDb('close counts what the window imported per org, freezes the summary and writes a partner-level audit row', async () => {
    const fx = await seed();
    const window = await open(fx);
    const [ticket] = await getTestDb().insert(tickets).values({
      orgId: fx.orgA.id, partnerId: fx.partner.id, ticketNumber: uniq('TKT'), internalNumber: uniq('T'),
      subject: 'Imported', status: 'closed', migrationWindowId: window.id,
    }).returning();
    await getTestDb().insert(tickets).values({
      orgId: fx.orgA.id, partnerId: fx.partner.id, ticketNumber: uniq('TKT'), internalNumber: uniq('T'), subject: 'Live',
    });
    await getTestDb().insert(ticketComments).values([
      { ticketId: ticket!.id, content: 'customer reply', commentType: 'comment', isPublic: true, authorType: 'email', migrationWindowId: window.id },
      { ticketId: ticket!.id, content: 'note', commentType: 'internal', isPublic: false, authorType: 'internal', migrationWindowId: window.id },
      // A feed row is not counted.
      { ticketId: ticket!.id, content: '', commentType: 'status_change', isPublic: false, authorType: 'internal', migrationWindowId: window.id },
    ]);

    const result = await withDbAccessContext(fx.context(), () => db.transaction((tx) => closeMigrationWindow(tx, {
      windowId: window.id, partnerId: fx.partner.id, reason: 'closed_by_admin', closedBy: fx.owner.id,
    })));
    expect(result!.window.counts).toEqual({
      orgs: [
        { orgId: fx.orgA.id, ticketsImported: 1, commentsImported: 2 },
        { orgId: fx.orgB.id, ticketsImported: 0, commentsImported: 0 },
      ].sort((a, b) => a.orgId.localeCompare(b.orgId)),
      ticketsImported: 1,
      commentsImported: 2,
    });
    const [row] = await getTestDb().select().from(migrationWindows).where(eq(migrationWindows.id, window.id));
    expect(row).toMatchObject({ status: 'closed', closedReason: 'closed_by_admin', closedBy: fx.owner.id, summaryPublishedAt: null });
    const [audit] = await getTestDb().select().from(auditLogs).where(and(
      eq(auditLogs.resourceId, window.id), eq(auditLogs.action, 'migration_window.closed'),
    ));
    expect(audit).toMatchObject({ orgId: null, partnerId: fx.partner.id, actorId: fx.owner.id });
    // Closing again is a no-op.
    const again = await withDbAccessContext(fx.context(), () => db.transaction((tx) => closeMigrationWindow(tx, {
      windowId: window.id, partnerId: fx.partner.id, reason: 'expired', closedBy: null,
    })));
    expect(again).toMatchObject({ alreadyClosed: true, window: { closedReason: 'closed_by_admin' } });
  });

  runDb('the sweep closes on every condition and publishes one migration.window_closed per org, once', async () => {
    const expired = await seed();
    const disabled = await seed();
    const epochMoved = await seed();
    const demoted = await seed();
    const healthy = await seed();
    const windows = {
      expired: await open(expired),
      disabled: await open(disabled),
      epochMoved: await open(epochMoved),
      demoted: await open(demoted),
      healthy: await open(healthy),
    };
    await getTestDb().update(migrationWindows)
      .set({ openedAt: new Date(Date.now() - 3 * DAY), endsAt: new Date(Date.now() - DAY) })
      .where(eq(migrationWindows.id, windows.expired.id));
    await getTestDb().update(partnerServicePrincipals).set({ status: 'disabled' })
      .where(eq(partnerServicePrincipals.id, disabled.principal.id));
    await getTestDb().update(users).set({ credentialEpoch: sql`${users.credentialEpoch} + 1` })
      .where(eq(users.id, epochMoved.owner.id));
    await getTestDb().update(partnerUsers).set({ orgAccess: 'selected' })
      .where(and(eq(partnerUsers.userId, demoted.owner.id), eq(partnerUsers.partnerId, demoted.partner.id)));

    await sweepMigrationWindows(new Date());

    const statusOf = async (id: string) => (await getTestDb().select().from(migrationWindows).where(eq(migrationWindows.id, id)))[0]!;
    expect(await statusOf(windows.expired.id)).toMatchObject({ status: 'closed', closedReason: 'expired', closedBy: null });
    expect(await statusOf(windows.disabled.id)).toMatchObject({ status: 'closed', closedReason: 'principal_inactive' });
    expect(await statusOf(windows.epochMoved.id)).toMatchObject({ status: 'closed', closedReason: 'opener_inactive' });
    expect(await statusOf(windows.demoted.id)).toMatchObject({ status: 'closed', closedReason: 'opener_inactive' });
    expect(await statusOf(windows.healthy.id)).toMatchObject({ status: 'open' });

    for (const [name, fx] of [['expired', expired], ['disabled', disabled], ['epochMoved', epochMoved], ['demoted', demoted]] as const) {
      const id = windows[name].id;
      expect((await statusOf(id)).summaryPublishedAt).not.toBeNull();
      const events = published.filter((e) => e.payload.windowId === id);
      expect(events.map((e) => e.orgId).sort()).toEqual([fx.orgA.id, fx.orgB.id].sort());
      expect(events.every((e) => e.type === 'migration.window_closed' && e.eventId === `${id}:${e.orgId}`)).toBe(true);
      expect(events[0]!.payload).toMatchObject({ partnerId: fx.partner.id, sourceLabel: 'zammad', ticketsImported: 0, commentsImported: 0 });
    }
    expect(published.some((e) => e.payload.windowId === windows.healthy.id)).toBe(false);

    // A second sweep publishes nothing again for these windows.
    const ours = () => published.filter((e) => Object.values(windows).some((w) => w.id === e.payload.windowId)).length;
    const before = ours();
    await sweepMigrationWindows(new Date());
    expect(ours()).toBe(before);
  });
});
