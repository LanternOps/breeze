/**
 * #8606 (feature #8601 W05): "Refresh from time entries" on an unissued draft,
 * end to end against real Postgres under the unprivileged app role (RLS on).
 *
 * Proves: the refresh re-reads the source entries and updates description,
 * work_date, worked_minutes and is_unapproved_time; a hand-edited description
 * survives (description_edited); amounts, quantities and totals never move;
 * a second refresh changes nothing; issued invoices are refused; another
 * tenant cannot refresh the draft; reissue copies the flag; and the migration
 * backfill flags only pre-existing draft time-entry lines, idempotently.
 *
 * Runs under vitest.integration.config.ts. integration/setup.ts TRUNCATEs core
 * tenant tables before every test.
 */
import './setup';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';

vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { invoiceLines, invoices, partners, timeEntries } from '../../db/schema';
import {
  assembleDraftFromOrg, issueInvoice, refreshDraftTimeLines, updateLine, voidInvoice,
} from '../../services/invoiceService';
import { seedGateOrg, type GateOrgFixture } from './multiCurrencyWave6GateFixtures';
import { getTestDb } from './setup';

const RUN = !!process.env.DATABASE_URL;
const runDb = it.runIf(RUN);

const MIGRATION = '2026-12-27-070000-invoice-line-description-edited.sql';
const migrationSql = readFileSync(join(__dirname, '../../../migrations', MIGRATION), 'utf8');
const notices: string[] = [];
const adminSql = RUN
  ? postgres(process.env.DATABASE_URL ?? '', { max: 1, onnotice: (n) => { notices.push(String(n.message)); } })
  : null;
afterAll(async () => { await adminSql?.end({ timeout: 5 }); });

const sys = <T,>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);
const ctxOf = (f: GateOrgFixture): DbAccessContext => ({
  scope: 'partner', orgId: null, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [f.partnerId], userId: f.userId,
});
const asTenant = <T,>(f: GateOrgFixture, fn: () => Promise<T>) => withDbAccessContext(ctxOf(f), fn);

/** One partner in New York with one 90-minute billable entry on Sep 16 (local). */
async function seed(): Promise<GateOrgFixture & { entryId: string }> {
  const f = await seedGateOrg('USD');
  await getTestDb().update(partners).set({ timezone: 'America/New_York' }).where(eq(partners.id, f.partnerId));
  const [te] = await sys(() => db.insert(timeEntries).values({
    partnerId: f.partnerId, orgId: f.orgId, userId: f.userId,
    startedAt: new Date('2026-09-16T15:00:00Z'), endedAt: new Date('2026-09-16T16:30:00Z'),
    durationMinutes: 90, description: 'Replaced toner', isBillable: true, hourlyRate: '100.00',
    billingStatus: 'not_billed', isApproved: true, currencyCode: 'USD',
  }).returning({ id: timeEntries.id }));
  return { ...f, entryId: te!.id };
}

async function assemble(f: GateOrgFixture): Promise<string> {
  const draft = await asTenant(f, () => assembleDraftFromOrg({ orgId: f.orgId, from: '2026-09-01', to: '2026-09-30' }, f.actor));
  return draft.invoice.id;
}

const lineRows = (invoiceId: string) => sys(() => db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)));
const header = (invoiceId: string) => sys(async () => {
  const [row] = await db.select({ subtotal: invoices.subtotal, taxTotal: invoices.taxTotal, total: invoices.total, balance: invoices.balance })
    .from(invoices).where(eq(invoices.id, invoiceId));
  return row!;
});
const editEntry = (entryId: string, set: Partial<typeof timeEntries.$inferInsert>) =>
  sys(() => db.update(timeEntries).set(set).where(eq(timeEntries.id, entryId)));

describe.runIf(RUN)('refreshDraftTimeLines (#8606)', () => {
  runDb('refreshes description, midnight-spanning work date, worked minutes and approval; amounts never move', async () => {
    const f = await seed();
    const invoiceId = await assemble(f);
    const [before] = await lineRows(invoiceId);
    expect(before).toMatchObject({ description: 'Replaced toner', workDate: '2026-09-16', descriptionEdited: false });
    const totalsBefore = await header(invoiceId);

    // 02:30Z on Sep 18 is 22:30 on Sep 17 in New York; it ends after local midnight.
    await editEntry(f.entryId, {
      description: 'Replaced toner and drum', isApproved: false, durationMinutes: 85, billableMinutes: 90, roundingIncrementMinutes: 15,
      startedAt: new Date('2026-09-18T02:30:00Z'), endedAt: new Date('2026-09-18T04:00:00Z'),
    });
    const result = await asTenant(f, () => refreshDraftTimeLines(invoiceId, f.actor));
    expect(result.summary).toEqual({ refreshed: 1, unchanged: 0, skipped: 0, quantityDrifted: 0 });
    expect(result.lines[0]).toEqual({
      lineId: before!.id, status: 'refreshed', changed: ['description', 'workDate', 'workedMinutes', 'isUnapprovedTime'],
    });

    const [after] = await lineRows(invoiceId);
    expect(after).toMatchObject({
      description: 'Replaced toner and drum', workDate: '2026-09-17', workedMinutes: 85, isUnapprovedTime: true,
      quantity: before!.quantity, unitPrice: before!.unitPrice, lineTotal: before!.lineTotal, descriptionEdited: false,
    });
    expect(await header(invoiceId)).toEqual(totalsBefore);

    // Idempotent: a second run reports unchanged and writes nothing.
    const again = await asTenant(f, () => refreshDraftTimeLines(invoiceId, f.actor));
    expect(again.summary).toEqual({ refreshed: 0, unchanged: 1, skipped: 0, quantityDrifted: 0 });
    expect(await lineRows(invoiceId)).toEqual([after]);
  });

  runDb('a hand-edited description survives a refresh; its work date still refreshes', async () => {
    const f = await seed();
    const invoiceId = await assemble(f);
    const [line] = await lineRows(invoiceId);

    // A patch that does not change the description leaves the flag clear.
    await asTenant(f, () => updateLine(invoiceId, line!.id, { description: 'Replaced toner', taxable: true }, f.actor));
    expect((await lineRows(invoiceId))[0]!.descriptionEdited).toBe(false);

    await asTenant(f, () => updateLine(invoiceId, line!.id, { description: 'Printer service' }, f.actor));
    expect((await lineRows(invoiceId))[0]!.descriptionEdited).toBe(true);

    await editEntry(f.entryId, {
      description: 'Replaced toner and drum',
      startedAt: new Date('2026-09-20T15:00:00Z'), endedAt: new Date('2026-09-20T16:30:00Z'),
    });
    const result = await asTenant(f, () => refreshDraftTimeLines(invoiceId, f.actor));
    expect(result.lines[0]).toMatchObject({ status: 'refreshed', changed: ['workDate'] });
    expect((await lineRows(invoiceId))[0]).toMatchObject({ description: 'Printer service', workDate: '2026-09-20', descriptionEdited: true });
  });

  runDb('a changed billed duration is reported as quantityDrifted and the line and totals stay byte-identical', async () => {
    const f = await seed();
    const invoiceId = await assemble(f);
    const linesBefore = await lineRows(invoiceId);
    const totalsBefore = await header(invoiceId);
    await editEntry(f.entryId, { durationMinutes: 120, description: 'Longer visit' });

    const result = await asTenant(f, () => refreshDraftTimeLines(invoiceId, f.actor));
    expect(result.lines[0]).toEqual({ lineId: linesBefore[0]!.id, status: 'quantityDrifted', lineQuantity: '1.50', entryQuantity: '2.00' });
    expect(await lineRows(invoiceId)).toEqual(linesBefore);
    expect(await header(invoiceId)).toEqual(totalsBefore);
  });

  runDb('an entry already billed elsewhere is skipped and reported, never refreshed', async () => {
    const f = await seed();
    const invoiceId = await assemble(f);
    const linesBefore = await lineRows(invoiceId);
    await editEntry(f.entryId, { billingStatus: 'billed', description: 'Changed after billing' });

    const result = await asTenant(f, () => refreshDraftTimeLines(invoiceId, f.actor));
    expect(result.lines[0]).toEqual({ lineId: linesBefore[0]!.id, status: 'skipped', reason: 'billed_elsewhere' });
    expect(await lineRows(invoiceId)).toEqual(linesBefore);
  });

  runDb('matches each line to its own entry; manual lines are not part of the refresh', async () => {
    const f = await seed();
    const [b] = await sys(() => db.insert(timeEntries).values({
      partnerId: f.partnerId, orgId: f.orgId, userId: f.userId,
      startedAt: new Date('2026-09-15T15:00:00Z'), endedAt: new Date('2026-09-15T16:00:00Z'),
      durationMinutes: 60, description: 'Checked backups', isBillable: true, hourlyRate: '100.00',
      billingStatus: 'not_billed', isApproved: true, currencyCode: 'USD',
    }).returning({ id: timeEntries.id }));
    const invoiceId = await assemble(f);
    await sys(() => db.insert(invoiceLines).values({
      invoiceId, orgId: f.orgId, sourceType: 'manual', description: 'Site visit fee',
      quantity: '1.00', unitPrice: '50.00', lineTotal: '50.00', sortOrder: 99,
    }));
    const before = await lineRows(invoiceId);
    const lineA = before.find((l) => l.sourceId === f.entryId)!;
    const lineB = before.find((l) => l.sourceId === b!.id)!;
    const manual = before.find((l) => l.sourceType === 'manual')!;

    await editEntry(f.entryId, { description: 'Replaced toner and drum' });
    await editEntry(b!.id, { billingStatus: 'billed', description: 'Should not appear' });
    const result = await asTenant(f, () => refreshDraftTimeLines(invoiceId, f.actor));

    expect(result.summary).toEqual({ refreshed: 1, unchanged: 0, skipped: 1, quantityDrifted: 0 });
    expect(result.lines.map((o) => o.lineId).sort()).toEqual([lineA.id, lineB.id].sort());
    expect(result.lines).toContainEqual({ lineId: lineB.id, status: 'skipped', reason: 'billed_elsewhere' });
    const after = await lineRows(invoiceId);
    expect(after.find((l) => l.id === lineA.id)!.description).toBe('Replaced toner and drum');
    expect(after.find((l) => l.id === lineB.id)).toEqual(lineB);
    expect(after.find((l) => l.id === manual.id)).toEqual(manual);
  });

  runDb('an issued invoice is refused with 409 NOT_A_DRAFT and its lines do not change', async () => {
    const f = await seed();
    const invoiceId = await assemble(f);
    await asTenant(f, () => issueInvoice(invoiceId, f.actor));
    const linesBefore = await lineRows(invoiceId);
    await editEntry(f.entryId, { description: 'Edited after issue' });

    await expect(asTenant(f, () => refreshDraftTimeLines(invoiceId, f.actor)))
      .rejects.toMatchObject({ status: 409, code: 'NOT_A_DRAFT' });
    expect(await lineRows(invoiceId)).toEqual(linesBefore);
  });

  runDb('another tenant cannot refresh the draft (RLS hides it) and nothing changes', async () => {
    const a = await seed();
    const b = await seedGateOrg('USD');
    const invoiceId = await assemble(a);
    const linesBefore = await lineRows(invoiceId);
    await editEntry(a.entryId, { description: 'Edited by tenant A' });

    await expect(asTenant(b, () => refreshDraftTimeLines(invoiceId, b.actor)))
      .rejects.toMatchObject({ status: 404, code: 'INVOICE_NOT_FOUND' });
    expect(await lineRows(invoiceId)).toEqual(linesBefore);
  });

  runDb('void and reissue copies description_edited onto the replacement draft', async () => {
    const f = await seed();
    const invoiceId = await assemble(f);
    const [line] = await lineRows(invoiceId);
    await asTenant(f, () => updateLine(invoiceId, line!.id, { description: 'Printer service' }, f.actor));
    await asTenant(f, () => issueInvoice(invoiceId, f.actor));
    const reissued = await asTenant(f, () => voidInvoice(invoiceId, 'wrong date', { reissue: true }, f.actor));
    expect(reissued.invoice.id).not.toBe(invoiceId);
    const [cloned] = await lineRows(reissued.invoice.id);
    expect(cloned).toMatchObject({ description: 'Printer service', descriptionEdited: true });
  });
});

describe.runIf(RUN)('migration 2026-12-27-070000 description_edited backfill (#8606)', () => {
  async function seedLines() {
    const f = await seedGateOrg('USD');
    return sys(async () => {
      const mk = async (status: 'draft' | 'sent', sfx: string) => {
        const [inv] = await db.insert(invoices).values({
          partnerId: f.partnerId, orgId: f.orgId, status, currencyCode: 'USD',
          ...(status === 'sent' ? { invoiceNumber: `RF-${sfx}-${Math.random().toString(36).slice(2, 8)}`, issueDate: '2026-09-30' } : {}),
        }).returning({ id: invoices.id });
        return inv!.id;
      };
      const draftId = await mk('draft', 'd');
      const issuedId = await mk('sent', 's');
      const base = { orgId: f.orgId, quantity: '1.00', unitPrice: '10.00', lineTotal: '10.00', description: 'x' };
      const rows = await db.insert(invoiceLines).values([
        { ...base, invoiceId: draftId, sourceType: 'time_entry' },
        { ...base, invoiceId: draftId, sourceType: 'manual' },
        { ...base, invoiceId: issuedId, sourceType: 'time_entry' },
      ]).returning({ id: invoiceLines.id });
      return { draftTime: rows[0]!.id, draftManual: rows[1]!.id, issuedTime: rows[2]!.id };
    });
  }
  const flag = (id: string) => sys(async () =>
    (await db.select({ v: invoiceLines.descriptionEdited }).from(invoiceLines).where(eq(invoiceLines.id, id)))[0]!.v);

  runDb('flags only pre-existing draft time_entry lines, reports the count, and a re-run never flags newer lines', async () => {
    const ids = await seedLines();
    expect(await flag(ids.draftTime)).toBe(false);

    // Simulate the first deploy: the lines exist, the column does not yet.
    // (globalSetup already migrated this database, so drop the column first;
    // the migration under test puts it back.)
    await adminSql!.unsafe('ALTER TABLE invoice_lines DROP COLUMN description_edited');
    notices.length = 0;
    await adminSql!.unsafe(migrationSql);
    expect(await flag(ids.draftTime)).toBe(true);
    expect(await flag(ids.draftManual)).toBe(false);
    expect(await flag(ids.issuedTime)).toBe(false);
    expect(notices.some((n) => /description_edited backfill: flagged 1 row/.test(n))).toBe(true);

    // A draft assembled AFTER the column existed starts unflagged; applying
    // the migration again (by hand) must not flag it.
    const [later] = await sys(async () => {
      const [src] = await db.select({ invoiceId: invoiceLines.invoiceId, orgId: invoiceLines.orgId })
        .from(invoiceLines).where(eq(invoiceLines.id, ids.draftTime));
      return db.insert(invoiceLines).values({
        invoiceId: src!.invoiceId, orgId: src!.orgId, sourceType: 'time_entry',
        quantity: '1.00', unitPrice: '10.00', lineTotal: '10.00', description: 'later',
      }).returning({ id: invoiceLines.id });
    });
    notices.length = 0;
    await adminSql!.unsafe(migrationSql);
    expect(notices.some((n) => /description_edited backfill/.test(n))).toBe(false);
    expect(await flag(later!.id)).toBe(false);
    expect(await flag(ids.draftTime)).toBe(true);
    expect(await flag(ids.draftManual)).toBe(false);
  });
});
