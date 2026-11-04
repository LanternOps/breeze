/**
 * The ticket import framework's tables and stores (#8313 W4; spec
 * docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md
 * §5.5–§5.7, §8 W4 row) against real Postgres, as the unprivileged
 * `breeze_app` role through the production `db`.
 *
 * Migration under test: 2027-01-20-100000-ticket-import-framework.sql
 *
 * Proves:
 *   - RLS: another partner can neither read, change, delete nor forge (42501)
 *     a row of any of the six tables; the composite FKs pin every child to
 *     its source's partner; the org map's org FK refuses another partner's
 *     org even in system scope and is DEFERRABLE INITIALLY IMMEDIATE;
 *   - the stores behind the routes: owner-only, keyless, tickets:write,
 *     one-source principals; no view carries the ciphertext; mappings locked
 *     while a run is active; revoke and delete refused while active, then
 *     revoke keeps the row and delete cascades to maps, runs, ledger and
 *     issues; a run's window checks and the S3 refusal; one active run;
 *     new credentials clear a revocation.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  partnerServicePrincipals,
  ticketCategories,
  ticketImportCategoryMaps,
  ticketImportItems,
  ticketImportOrgMaps,
  ticketImportRunIssues,
  ticketImportRuns,
  ticketImportSources,
  tickets,
} from '../../db/schema';
import type { Database } from '../../db';
import { issuePartnerServicePrincipalKey } from '../../services/partnerServicePrincipalKeys';
import { registerTicketImportModule } from '../../services/ticketImport/moduleRegistry';
import { cascadeDeleteOrg, cascadeDeletePartner } from '../../services/tenantCascade';
import { cancelRun, startRun } from '../../services/ticketImport/runStore';
import { openSourceCredentials, sealSourceCredentials } from '../../services/ticketImport/sourceCredentials';
import {
  deleteSource,
  getMappings,
  getSource,
  listSources,
  lockPrincipalForSource,
  readSourceForUse,
  replaceMappings,
  revokeSource,
  updateSource,
} from '../../services/ticketImport/sourceStore';
import { fakeTicketImportModule } from '../../services/ticketImport/testing/fakeModule';
import { createUser, userEpochs } from './db-utils';
import { getTestDb } from './setup';
import { closeWindow, openWindow, seedImport, startImportRun, uniq, type ImportFx } from './ticketImportFixtures';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const CASE_TIMEOUT = 60_000;

let unregister: () => void;
beforeAll(() => { unregister = registerTicketImportModule(fakeTicketImportModule); });
afterAll(() => unregister());

async function causeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'no error';
  } catch (err) {
    const e = err as { cause?: { message?: string; code?: string }; message?: string; code?: string };
    return `${e.cause?.code ?? e.code ?? ''} ${e.cause?.message ?? e.message ?? ''}`;
  }
}

async function fixtureWithRows(): Promise<ImportFx & { categoryId: string; runId: string }> {
  const fx = await seedImport();
  const [category] = await getTestDb().insert(ticketCategories).values({ partnerId: fx.partner.id, name: uniq('Printers') }).returning();
  await withDbAccessContext(fx.ownerContext(), () => replaceMappings({
    partnerId: fx.partner.id,
    sourceId: fx.sourceId,
    options: {},
    mappings: {
      orgs: [{ sourceOrgKey: 'acme', sourceOrgName: 'Acme', orgId: fx.orgA.id }],
      categories: [{ sourceGroupKey: 'printers', sourceGroupName: 'Printers', categoryId: category!.id }],
    },
  }));
  const run = await startImportRun(fx, 'dry_run');
  await withSystemDbAccessContext(async () => {
    await db.insert(ticketImportItems).values({ sourceId: fx.sourceId, partnerId: fx.partner.id, sourceTicketKey: 'k1', state: 'imported', importedVersion: 'v1' });
    await db.insert(ticketImportRunIssues).values({ runId: run.id, partnerId: fx.partner.id, kind: 'failed', code: 'x', sourceTicketKey: 'k1' });
  });
  return { ...fx, categoryId: category!.id, runId: run.id };
}

describe('ticket import tables: RLS and composite FKs (real Postgres, as breeze_app)', () => {
  runDb('another partner can neither see, change, delete nor forge a row of any of the six tables', async () => {
    const a = await fixtureWithRows();
    const b = await seedImport();
    const asB = <T>(fn: () => Promise<T>) => withDbAccessContext(b.ownerContext(), fn);

    // Reads: nothing of A's is visible to B.
    const reads = await asB(async () => ({
      sources: await db.select().from(ticketImportSources).where(eq(ticketImportSources.partnerId, a.partner.id)),
      orgMaps: await db.select().from(ticketImportOrgMaps).where(eq(ticketImportOrgMaps.partnerId, a.partner.id)),
      categoryMaps: await db.select().from(ticketImportCategoryMaps).where(eq(ticketImportCategoryMaps.partnerId, a.partner.id)),
      runs: await db.select().from(ticketImportRuns).where(eq(ticketImportRuns.partnerId, a.partner.id)),
      items: await db.select().from(ticketImportItems).where(eq(ticketImportItems.partnerId, a.partner.id)),
      issues: await db.select().from(ticketImportRunIssues).where(eq(ticketImportRunIssues.partnerId, a.partner.id)),
    }));
    expect(reads).toEqual({ sources: [], orgMaps: [], categoryMaps: [], runs: [], items: [], issues: [] });
    expect(await asB(() => getSource(a.partner.id, a.sourceId))).toBeNull();

    // Writes: B's UPDATE and DELETE reach none of A's rows.
    const touched = await asB(async () => ({
      updated: (await db.update(ticketImportSources).set({ label: 'hijack' }).where(eq(ticketImportSources.id, a.sourceId)).returning()).length,
      deletedItems: (await db.delete(ticketImportItems).where(eq(ticketImportItems.sourceId, a.sourceId)).returning()).length,
      deletedRuns: (await db.delete(ticketImportRuns).where(eq(ticketImportRuns.id, a.runId)).returning()).length,
    }));
    expect(touched).toEqual({ updated: 0, deletedItems: 0, deletedRuns: 0 });

    // Forging A's partner id is 42501 on every table.
    const forged = {
      sources: await causeOf(() => asB(() => db.insert(ticketImportSources).values({
        id: randomUUID(), partnerId: a.partner.id, module: 'fake', label: 'x', baseUrl: 'https://x.example.test',
        credentialsEncrypted: 'x', partnerServicePrincipalId: a.principal.id,
      }))),
      orgMaps: await causeOf(() => asB(() => db.insert(ticketImportOrgMaps).values({ sourceId: a.sourceId, partnerId: a.partner.id, sourceOrgKey: 'z', orgId: a.orgA.id }))),
      categoryMaps: await causeOf(() => asB(() => db.insert(ticketImportCategoryMaps).values({ sourceId: a.sourceId, partnerId: a.partner.id, sourceGroupKey: 'z', categoryId: a.categoryId }))),
      runs: await causeOf(() => asB(() => db.insert(ticketImportRuns).values({ partnerId: a.partner.id, sourceId: a.sourceId, kind: 'dry_run', options: {} }))),
      items: await causeOf(() => asB(() => db.insert(ticketImportItems).values({ sourceId: a.sourceId, partnerId: a.partner.id, sourceTicketKey: 'zz', state: 'failed' }))),
      issues: await causeOf(() => asB(() => db.insert(ticketImportRunIssues).values({ runId: a.runId, partnerId: a.partner.id, kind: 'failed' }))),
    };
    for (const [table, message] of Object.entries(forged)) {
      expect(message, table).toMatch(/42501|row-level security/);
    }

    // Under its own partner id, B cannot hang a row off A's source: the
    // composite (source_id, partner_id) FK has no such parent.
    const crossParent = await causeOf(() => asB(() => db.insert(ticketImportItems).values({
      sourceId: a.sourceId, partnerId: b.partner.id, sourceTicketKey: 'zz', state: 'failed',
    })));
    expect(crossParent).toMatch(/23503|ticket_import_items_source_fk/);
  }, CASE_TIMEOUT);

  runDb('the org map refuses another partner\'s org even in system scope, and its org FK is deferrable', async () => {
    const a = await seedImport();
    const b = await seedImport();
    const cross = await causeOf(() => withSystemDbAccessContext(() => db.insert(ticketImportOrgMaps).values({
      sourceId: a.sourceId, partnerId: a.partner.id, sourceOrgKey: 'other', orgId: b.orgA.id,
    })));
    expect(cross).toMatch(/ticket_import_org_maps_org_fk/);
    const [fk] = await getTestDb().execute<{ condeferrable: boolean; condeferred: boolean }>(sql`
      SELECT condeferrable, condeferred FROM pg_constraint WHERE conname = 'ticket_import_org_maps_org_fk'`);
    expect(fk).toMatchObject({ condeferrable: true, condeferred: false });
    // A second fallback for one source is refused by the partial unique index.
    await withSystemDbAccessContext(() => db.insert(ticketImportOrgMaps).values({ sourceId: a.sourceId, partnerId: a.partner.id, sourceOrgKey: null, orgId: a.orgA.id }));
    const twoFallbacks = await causeOf(() => withSystemDbAccessContext(() => db.insert(ticketImportOrgMaps).values({
      sourceId: a.sourceId, partnerId: a.partner.id, sourceOrgKey: null, orgId: a.orgB.id,
    })));
    expect(twoFallbacks).toMatch(/ticket_import_org_maps_fallback_uq/);
  }, CASE_TIMEOUT);
});

describe('ticket import tables: erasure', () => {
  runDb('erasing an org drops it from the org maps and leaves the source; erasing the partner removes all six tables', async () => {
    const fx = await fixtureWithRows();
    await withDbAccessContext(fx.ownerContext(), () => cancelRun(fx.partner.id, fx.runId));
    const window = await openWindow(fx, [fx.orgA.id, fx.orgB.id]);
    await startImportRun(fx, 'import', window.id);
    const count = (table: string) => withSystemDbAccessContext(async () =>
      Number((await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE partner_id = ${fx.partner.id}`))[0]!.n));
    const TABLES = ['ticket_import_sources', 'ticket_import_org_maps', 'ticket_import_category_maps', 'ticket_import_runs', 'ticket_import_items', 'ticket_import_run_issues'];

    // fixtureWithRows maps acme -> orgA only.
    expect(await count('ticket_import_org_maps')).toBe(1);
    await cascadeDeleteOrg(fx.orgA.id, fx.owner.id);
    expect(await count('ticket_import_org_maps')).toBe(0);
    expect(await count('ticket_import_sources')).toBe(1);

    // CONTROL: every table holds rows of the partner before the sweep.
    for (const table of TABLES.filter((t) => t !== 'ticket_import_org_maps')) expect(await count(table), table).toBeGreaterThan(0);
    await expect(cascadeDeletePartner(fx.partner.id, randomUUID())).resolves.toBeDefined();
    for (const table of TABLES) expect(await count(table), table).toBe(0);
  }, CASE_TIMEOUT);
});

describe('ticket import stores (the routes\' services, real Postgres)', () => {
  runDb('a source\'s principal: owner-only, keyless, tickets:write, and one source each', async () => {
    const fx = await seedImport();
    const inCtx = <T>(fn: () => Promise<T>, userId?: string) => withDbAccessContext(fx.ownerContext(userId), () => db.transaction(() => fn()));
    const [fresh] = await getTestDb().insert(partnerServicePrincipals).values({
      partnerId: fx.partner.id, name: uniq('Second'), scopes: ['tickets:write'], createdBy: fx.owner.id, updatedBy: fx.owner.id,
    }).returning();
    const otherAdmin = await createUser({ partnerId: fx.partner.id, orgId: null, email: `${uniq('admin')}@example.test` });

    await expect(inCtx(() => lockPrincipalForSource({ partnerId: fx.partner.id, principalId: fresh!.id, ownerUserId: otherAdmin.id })))
      .rejects.toMatchObject({ code: 'TICKET_IMPORT_OWNER_REQUIRED', status: 403 });
    await expect(inCtx(() => lockPrincipalForSource({ partnerId: fx.partner.id, principalId: fx.principal.id, ownerUserId: fx.owner.id })))
      .rejects.toMatchObject({ code: 'TICKET_IMPORT_PRINCIPAL_IN_USE', status: 409 });
    await expect(inCtx(() => lockPrincipalForSource({ partnerId: fx.partner.id, principalId: fresh!.id, ownerUserId: fx.owner.id })))
      .resolves.toBeUndefined();

    const [readOnly] = await getTestDb().insert(partnerServicePrincipals).values({
      partnerId: fx.partner.id, name: uniq('ReadOnly'), scopes: ['tickets:read'], createdBy: fx.owner.id, updatedBy: fx.owner.id,
    }).returning();
    await expect(inCtx(() => lockPrincipalForSource({ partnerId: fx.partner.id, principalId: readOnly!.id, ownerUserId: fx.owner.id })))
      .rejects.toMatchObject({ code: 'TICKET_IMPORT_PRINCIPAL_SCOPE_MISSING' });

    const epochs = await userEpochs(fx.owner.id);
    await withDbAccessContext(fx.ownerContext(), () => issuePartnerServicePrincipalKey(db as unknown as Database, {
      partnerServicePrincipalId: fresh!.id, partnerId: fx.partner.id, name: 'key', actorId: fx.owner.id,
      actorSessionEpochs: { authEpoch: epochs.authEpoch, mfaEpoch: epochs.mfaEpoch },
    }));
    await expect(inCtx(() => lockPrincipalForSource({ partnerId: fx.partner.id, principalId: fresh!.id, ownerUserId: fx.owner.id })))
      .rejects.toMatchObject({ code: 'TICKET_IMPORT_PRINCIPAL_HAS_KEY' });
  }, CASE_TIMEOUT);

  runDb('no view carries the ciphertext; the sealed credential opens only under its own row id', async () => {
    const fx = await seedImport();
    const [stored] = await getTestDb().select({ ct: ticketImportSources.credentialsEncrypted }).from(ticketImportSources).where(eq(ticketImportSources.id, fx.sourceId));
    const views = await withDbAccessContext(fx.ownerContext(), async () => ({
      one: await getSource(fx.partner.id, fx.sourceId),
      all: await listSources(fx.partner.id),
    }));
    for (const view of [views.one!, ...views.all]) {
      expect(Object.keys(view)).not.toContain('credentialsEncrypted');
      expect(JSON.stringify(view)).not.toContain(stored!.ct!);
      expect(JSON.stringify(view)).not.toContain('fake-token');
    }
    expect(views.one).toMatchObject({ hasCredentials: true, ownerUserId: fx.owner.id, principalId: fx.principal.id });
    expect(openSourceCredentials(fx.sourceId, stored!.ct!)).toEqual({ token: 'fake-token' });
    expect(() => openSourceCredentials(randomUUID(), stored!.ct!)).toThrow();
  }, CASE_TIMEOUT);

  runDb('mappings lock, revoke and delete are refused while a run is active; cancel frees them', async () => {
    const fx = await seedImport();
    const asOwner = <T>(fn: () => Promise<T>) => withDbAccessContext(fx.ownerContext(), fn);
    const run = await startImportRun(fx, 'dry_run');
    const mappings = { orgs: [{ sourceOrgKey: null, sourceOrgName: null, orgId: fx.orgA.id }], categories: [] };
    await expect(asOwner(() => replaceMappings({ partnerId: fx.partner.id, sourceId: fx.sourceId, mappings, options: {} })))
      .rejects.toMatchObject({ code: 'TICKET_IMPORT_MAPPING_LOCKED', status: 409 });
    await expect(asOwner(() => revokeSource(fx.partner.id, fx.sourceId, fx.owner.id))).rejects.toMatchObject({ code: 'TICKET_IMPORT_RUN_ACTIVE' });
    await expect(asOwner(() => deleteSource(fx.partner.id, fx.sourceId))).rejects.toMatchObject({ code: 'TICKET_IMPORT_RUN_ACTIVE' });
    await expect(asOwner(() => startRun({ partnerId: fx.partner.id, sourceId: fx.sourceId, kind: 'dry_run', startedBy: fx.owner.id, objectStorageConfigured: true })))
      .rejects.toMatchObject({ code: 'TICKET_IMPORT_RUN_ACTIVE' });

    expect(await asOwner(() => cancelRun(fx.partner.id, run.id))).toMatchObject({ alreadyFinished: false, run: { state: 'cancelled' } });
    expect(await asOwner(() => cancelRun(fx.partner.id, run.id))).toMatchObject({ alreadyFinished: true });
    await asOwner(() => replaceMappings({ partnerId: fx.partner.id, sourceId: fx.sourceId, mappings, options: {} }));
    expect((await asOwner(() => getMappings(fx.partner.id, fx.sourceId))).orgs).toEqual(mappings.orgs);

    // Revoke keeps the row, its principal, maps and history.
    expect(await asOwner(() => revokeSource(fx.partner.id, fx.sourceId, fx.owner.id))).toEqual({ alreadyRevoked: false });
    expect(await asOwner(() => revokeSource(fx.partner.id, fx.sourceId, fx.owner.id))).toEqual({ alreadyRevoked: true });
    const revoked = await asOwner(() => readSourceForUse(fx.partner.id, fx.sourceId));
    expect(revoked).toMatchObject({ credentialsEncrypted: null, view: { hasCredentials: false, revokedBy: fx.owner.id } });
    await expect(asOwner(() => startRun({ partnerId: fx.partner.id, sourceId: fx.sourceId, kind: 'dry_run', startedBy: fx.owner.id, objectStorageConfigured: true })))
      .rejects.toMatchObject({ code: 'TICKET_IMPORT_SOURCE_REVOKED' });

    // New credentials, sealed under the same id, clear the revocation.
    await asOwner(() => updateSource({ partnerId: fx.partner.id, sourceId: fx.sourceId, credentialsEncrypted: sealSourceCredentials(fx.sourceId, { token: 'rotated' }) }));
    const reconnected = await asOwner(() => readSourceForUse(fx.partner.id, fx.sourceId));
    expect(reconnected!.view).toMatchObject({ hasCredentials: true, revokedAt: null, revokedBy: null });
    expect(openSourceCredentials(fx.sourceId, reconnected!.credentialsEncrypted!)).toEqual({ token: 'rotated' });
  }, CASE_TIMEOUT);

  runDb('delete removes the source with its maps, runs, ledger and issues; the principal and tickets stay', async () => {
    const fx = await fixtureWithRows();
    await withDbAccessContext(fx.ownerContext(), () => cancelRun(fx.partner.id, fx.runId));
    await withDbAccessContext(fx.ownerContext(), () => deleteSource(fx.partner.id, fx.sourceId));
    const left = await withSystemDbAccessContext(async () => ({
      sources: (await db.select().from(ticketImportSources).where(eq(ticketImportSources.id, fx.sourceId))).length,
      orgMaps: (await db.select().from(ticketImportOrgMaps).where(eq(ticketImportOrgMaps.sourceId, fx.sourceId))).length,
      categoryMaps: (await db.select().from(ticketImportCategoryMaps).where(eq(ticketImportCategoryMaps.sourceId, fx.sourceId))).length,
      runs: (await db.select().from(ticketImportRuns).where(eq(ticketImportRuns.sourceId, fx.sourceId))).length,
      items: (await db.select().from(ticketImportItems).where(eq(ticketImportItems.sourceId, fx.sourceId))).length,
      issues: (await db.select().from(ticketImportRunIssues).where(eq(ticketImportRunIssues.runId, fx.runId))).length,
      principal: (await db.select().from(partnerServicePrincipals).where(eq(partnerServicePrincipals.id, fx.principal.id))).length,
    }));
    expect(left).toEqual({ sources: 0, orgMaps: 0, categoryMaps: 0, runs: 0, items: 0, issues: 0, principal: 1 });
  }, CASE_TIMEOUT);

  runDb('an import run needs S3 and an open window of this principal holding every mapped org', async () => {
    const fx = await seedImport();
    const start = (windowId: string, objectStorageConfigured = true) => withDbAccessContext(fx.ownerContext(), () => startRun({
      partnerId: fx.partner.id, sourceId: fx.sourceId, kind: 'import', windowId, startedBy: fx.owner.id, objectStorageConfigured,
    }));
    // The fixture maps acme -> orgA and beta -> orgB.
    const narrow = await openWindow(fx, [fx.orgA.id]);
    await expect(start(narrow.id, false)).rejects.toMatchObject({ code: 'TICKET_IMPORT_OBJECT_STORAGE_REQUIRED', status: 409 });
    await expect(start(narrow.id)).rejects.toMatchObject({ code: 'TICKET_IMPORT_ORGS_OUTSIDE_WINDOW', details: { orgIds: [fx.orgB.id] } });
    await closeWindow(fx, narrow.id);
    await expect(start(narrow.id)).rejects.toMatchObject({ code: 'TICKET_IMPORT_WINDOW_NOT_OPEN' });
    await expect(start(randomUUID())).rejects.toMatchObject({ code: 'TICKET_IMPORT_WINDOW_NOT_FOUND', status: 404 });

    // A window of another principal of the partner is not this source's grant.
    const other = await seedImport();
    const [otherPrincipal] = await getTestDb().insert(partnerServicePrincipals).values({
      partnerId: fx.partner.id, name: uniq('Other'), scopes: ['tickets:write'], createdBy: fx.owner.id, updatedBy: fx.owner.id,
    }).returning();
    const epochs = await userEpochs(fx.owner.id);
    const { openMigrationWindow } = await import('../../services/migrationWindows');
    const foreign = await withDbAccessContext(fx.ownerContext(), () => openMigrationWindow({
      partnerId: fx.partner.id, principalId: otherPrincipal!.id, orgIds: [fx.orgA.id, fx.orgB.id],
      endsAt: new Date(Date.now() + 86_400_000), sourceLabel: 'other',
      opener: { userId: fx.owner.id, authEpoch: epochs.authEpoch, mfaEpoch: epochs.mfaEpoch }, stepUp: null,
    }));
    await expect(start(foreign.id)).rejects.toMatchObject({ code: 'TICKET_IMPORT_WINDOW_PRINCIPAL_MISMATCH' });
    await closeWindow(fx, foreign.id);
    // Another partner's window is not found at all.
    const theirs = await openWindow(other);
    await expect(start(theirs.id)).rejects.toMatchObject({ code: 'TICKET_IMPORT_WINDOW_NOT_FOUND' });

    const wide = await openWindow(fx);
    const run = await start(wide.id);
    expect(run).toMatchObject({ kind: 'import', windowId: wide.id, state: 'queued', phase: 'scan' });
    const [row] = await getTestDb().select().from(ticketImportRuns).where(and(eq(ticketImportRuns.id, run.id)));
    expect(row!.options).toEqual({});
    // Nothing above touched a ticket.
    expect(await getTestDb().select({ id: tickets.id }).from(tickets).where(eq(tickets.orgId, fx.orgA.id))).toEqual([]);
  }, CASE_TIMEOUT);

  runDb('mappings take only the partner\'s active orgs and categories', async () => {
    const fx = await seedImport();
    const other = await seedImport();
    const [foreignCategory] = await getTestDb().insert(ticketCategories).values({ partnerId: other.partner.id, name: uniq('Theirs') }).returning();
    const put = (mappings: Parameters<typeof replaceMappings>[0]['mappings']) =>
      withDbAccessContext(fx.ownerContext(), () => replaceMappings({ partnerId: fx.partner.id, sourceId: fx.sourceId, mappings, options: {} }));
    await expect(put({ orgs: [{ sourceOrgKey: 'x', sourceOrgName: null, orgId: other.orgA.id }], categories: [] }))
      .rejects.toMatchObject({ code: 'TICKET_IMPORT_MAPPING_INVALID', details: { orgIds: [other.orgA.id] } });
    await expect(put({ orgs: [], categories: [{ sourceGroupKey: 'g', sourceGroupName: null, categoryId: foreignCategory!.id }] }))
      .rejects.toMatchObject({ code: 'TICKET_IMPORT_MAPPING_INVALID' });
    await expect(put({
      orgs: [{ sourceOrgKey: null, sourceOrgName: null, orgId: fx.orgA.id }, { sourceOrgKey: null, sourceOrgName: null, orgId: fx.orgB.id }],
      categories: [],
    })).rejects.toMatchObject({ code: 'TICKET_IMPORT_MAPPING_INVALID' });
  }, CASE_TIMEOUT);
});
