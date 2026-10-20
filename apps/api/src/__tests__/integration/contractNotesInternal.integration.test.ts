/**
 * #9347: contract `notes` became internal-only. Before this change a generated
 * invoice printed `[notes, terms]` joined by a blank line; now it prints only
 * `terms` (the "Invoice note"). Migration
 * `2027-01-02-100900-contract-notes-internal-only.sql` copies every non-empty
 * `notes` into the front of `terms`, so invoices print exactly what they
 * printed before the migration.
 *
 * Proven here on a real database:
 *   - generated invoice notes are byte-identical across the migration, for
 *     every notes/terms shape (both, notes only, terms only, neither, empty);
 *   - after the migration, editing Notes no longer changes generated invoice
 *     notes, and editing the Invoice note does;
 *   - a second run of the migration changes 0 rows.
 *
 * The fresh test database has already run the migration (autoMigrate), so each
 * test first clears its done-marker — the comment on `contracts.notes` — to
 * put the database back in the pre-migration state, then replays the file.
 */
import './setup';
import { describe, it, expect, vi } from 'vitest';

// Lifecycle events + PDF render are fire-and-forget BullMQ side effects, not
// the correctness under test (same rationale as contractCurrency).
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { eq, inArray, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { partners, organizations, contracts, invoices } from '../../db/schema';
import {
  createContract, addContractLineToContract, activateContract, generateDueInvoice, updateContract,
  type ContractActorT,
} from '../../services/contractService';
import { replayMigration } from './replayMigration';
import { getTestDb } from './setup';

const RUN = !!process.env.DATABASE_URL;
const MIGRATION = '2027-01-02-100900-contract-notes-internal-only.sql';
const START = '2026-07-01';
const FIRST_RUN = new Date('2026-07-01T06:00:00Z');

/** What generateDueInvoice printed BEFORE #9347 for a contract's notes/terms. */
function legacyInvoiceNotes(notes: string | null, terms: string | null): string | null {
  const parts = [notes, terms].filter(Boolean) as string[];
  return parts.length ? parts.join('\n\n') : null;
}

async function seedOrg(): Promise<{ actor: ContractActorT; orgId: string }> {
  const sfx = Math.random().toString(36).slice(2, 8);
  let orgId = '';
  let partnerId = '';
  await withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({
      name: `CN ${sfx}`, slug: `cn-${sfx}`, type: 'msp', plan: 'pro', status: 'active', currencyCode: 'USD',
    }).returning({ id: partners.id });
    partnerId = p!.id;
    const [o] = await db.insert(organizations).values({
      partnerId, name: 'CNOrg', slug: `cno-${sfx}`, currencyCode: 'USD',
    }).returning({ id: organizations.id });
    orgId = o!.id;
  });
  return { actor: { userId: null as unknown as string, partnerId, accessibleOrgIds: [orgId] }, orgId };
}

/** An active monthly contract with one flat line, due on START. */
async function seedContract(
  actor: ContractActorT, orgId: string, header: { notes: string | null; terms: string | null },
): Promise<string> {
  const c = await withSystemDbAccessContext(() => createContract({
    orgId, name: 'Managed', billingTiming: 'advance', intervalMonths: 1, startDate: START,
  }, actor));
  await withSystemDbAccessContext(() => addContractLineToContract(c.id, {
    lineType: 'flat', description: 'Managed services', unitPrice: '100.00', taxable: false,
  }, actor));
  await withSystemDbAccessContext(() => activateContract(c.id, actor, new Date(`${START}T00:00:00Z`)));
  // Raw write: the pre-migration state, including shapes the API never
  // produces (an empty string), exactly as they sit in old rows.
  await withSystemDbAccessContext(() =>
    db.update(contracts).set(header).where(eq(contracts.id, c.id)));
  return c.id;
}

async function generatedInvoiceNotes(contractId: string): Promise<string | null> {
  // Mirror contractWorker.ts: generation runs in a fresh system context.
  const res = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() => generateDueInvoice(contractId, FIRST_RUN)));
  expect(res.generated).toBe(true);
  const [inv] = await withSystemDbAccessContext(() =>
    db.select({ notes: invoices.notes }).from(invoices).where(eq(invoices.id, res.invoiceId!)).limit(1));
  return inv!.notes;
}

/** Put the database back in the pre-migration state: clear the done-marker. */
async function resetMigrationMarker(): Promise<void> {
  // DDL: the owner connection (the one migrations run as), not breeze_app.
  await getTestDb().execute(sql`COMMENT ON COLUMN public.contracts.notes IS NULL`);
}

async function readHeaders(ids: string[]) {
  return withSystemDbAccessContext(() =>
    db.select({ id: contracts.id, notes: contracts.notes, terms: contracts.terms, updatedAt: contracts.updatedAt })
      .from(contracts).where(inArray(contracts.id, ids)));
}

describe.runIf(RUN)('contract notes are internal-only (#9347)', () => {
  it('generated invoice notes are unchanged across the migration for every notes/terms shape', async () => {
    const { actor, orgId } = await seedOrg();
    const shapes: { notes: string | null; terms: string | null }[] = [
      { notes: 'Billed per MSA section 4.\nCall before 9am.', terms: 'Net 30' },
      { notes: 'Notes only', terms: null },
      { notes: 'Notes with empty terms', terms: '' },
      { notes: null, terms: 'Terms only' },
      { notes: '', terms: 'Empty notes' },
      { notes: null, terms: null },
      // Whitespace is truthy in the old join, so it printed; it still must.
      { notes: ' ', terms: 'After a blank note' },
    ];
    const ids: string[] = [];
    for (const shape of shapes) ids.push(await seedContract(actor, orgId, shape));

    await resetMigrationMarker();
    await replayMigration(MIGRATION);

    const printed: (string | null)[] = [];
    for (const [i, shape] of shapes.entries()) {
      const notes = await generatedInvoiceNotes(ids[i]!);
      printed.push(notes);
      expect(notes, JSON.stringify(shape)).toBe(legacyInvoiceNotes(shape.notes, shape.terms));
    }
    // Literal pins, so a drift in the legacy oracle above cannot pass silently.
    expect(printed).toEqual([
      'Billed per MSA section 4.\nCall before 9am.\n\nNet 30',
      'Notes only',
      'Notes with empty terms',
      'Terms only',
      'Empty notes',
      null,
      ' \n\nAfter a blank note',
    ]);

    // Notes stay as the internal copy; nothing is cleared.
    const after = new Map((await readHeaders(ids)).map((r) => [r.id, r]));
    for (const [i, shape] of shapes.entries()) {
      expect(after.get(ids[i]!)!.notes).toBe(shape.notes);
    }
  });

  it('after the migration, editing Notes does not change the invoice; editing the Invoice note does', async () => {
    const { actor, orgId } = await seedOrg();
    const notesEdited = await seedContract(actor, orgId, { notes: 'Original note', terms: 'Net 30' });
    const termsEdited = await seedContract(actor, orgId, { notes: 'Original note', terms: 'Net 30' });

    await resetMigrationMarker();
    await replayMigration(MIGRATION);

    // Through the service the PATCH route uses, on ACTIVE contracts.
    await withSystemDbAccessContext(() => updateContract(notesEdited, { notes: 'Chase on day 3 - internal' }, actor));
    await withSystemDbAccessContext(() => updateContract(termsEdited, { terms: 'Net 15' }, actor));

    expect(await generatedInvoiceNotes(notesEdited)).toBe('Original note\n\nNet 30');
    expect(await generatedInvoiceNotes(termsEdited)).toBe('Net 15');
  });

  it('a second run of the migration changes 0 rows', async () => {
    const { actor, orgId } = await seedOrg();
    const ids = [
      await seedContract(actor, orgId, { notes: 'N', terms: 'T' }),
      await seedContract(actor, orgId, { notes: 'N', terms: null }),
      // Looks like an already-migrated row; the marker, not the text, decides.
      await seedContract(actor, orgId, { notes: 'N', terms: 'N\n\nT' }),
    ];

    await resetMigrationMarker();
    await replayMigration(MIGRATION);
    // The first run sets the done-marker the second run keys on.
    const [marker] = await getTestDb().execute<{ c: string | null }>(
      sql`SELECT col_description('public.contracts'::regclass, a.attnum) AS c
            FROM pg_attribute a
           WHERE a.attrelid = 'public.contracts'::regclass AND a.attname = 'notes'`);
    expect(marker!.c).toMatch(/^Internal-only contract notes \(#9347\)/);
    const first = await readHeaders(ids);
    expect(new Map(first.map((r) => [r.id, r.terms]))).toEqual(new Map([
      [ids[0], 'N\n\nT'],
      [ids[1], 'N'],
      [ids[2], 'N\n\nN\n\nT'],
    ]));

    await replayMigration(MIGRATION);
    const second = await readHeaders(ids);
    expect(second.map((r) => ({ id: r.id, terms: r.terms, updatedAt: r.updatedAt.toISOString() })).sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual(first.map((r) => ({ id: r.id, terms: r.terms, updatedAt: r.updatedAt.toISOString() })).sort((a, b) => a.id.localeCompare(b.id)));
  });
});
