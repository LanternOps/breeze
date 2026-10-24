/**
 * #9304: contracts auto-created from an accepted quote used to get
 * `notes = 'Auto-created from accepted quote <number>'`. Contract notes are
 * copied onto every invoice the contract generates, so that internal line
 * printed on customer invoices. The migration clears ONLY notes that are
 * exactly the system string — anything an MSP edited (extra text, extra
 * lines) is left alone — and never touches existing invoices.
 *
 * Fixtures are re-seeded per test: the integration setup truncates tenant data
 * between tests.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { createOrganization, createPartner } from './db-utils';

const MIGRATION = '2027-01-02-100300-clear-auto-created-contract-notes.sql';
const runDb = it.runIf(!!process.env.DATABASE_URL);

type Row = Record<string, unknown>;
const rows = (r: unknown) => r as unknown as Row[];
const sys = <T,>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

// A dedicated superuser client (the role autoMigrate runs as) with onnotice
// wired, so the cleanup's RAISE WARNING row count can be asserted.
const notices: string[] = [];
const adminSql = postgres(process.env.DATABASE_URL ?? '', { max: 1, onnotice: (n) => { notices.push(String(n.message)); } });
afterAll(async () => { await adminSql.end({ timeout: 5 }); });
async function runMigrationAsAdmin(): Promise<string[]> {
  const migrationSql = readFileSync(join(__dirname, '../../../migrations', MIGRATION), 'utf8');
  notices.length = 0;
  await adminSql.unsafe(migrationSql);
  return notices.filter((m) => m.startsWith('cleared auto-created provenance'));
}

const PROVENANCE = 'Auto-created from accepted quote Q-2026-0001';

async function seed() {
  return sys(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const insertContract = async (name: string, notes: string | null) => rows(await db.execute(sql`
      INSERT INTO contracts (partner_id, org_id, name, interval_months, start_date, currency_code, notes, terms)
      VALUES (${partner.id}::uuid, ${org.id}::uuid, ${name}, 1, '2026-07-01', 'USD', ${notes}, 'Net 30')
      RETURNING id`))[0]!.id as string;
    const exact = await insertContract('Q-2026-0001 — Monthly', PROVENANCE);
    // Quote numbers fall back to the quote's UUID when it has none.
    const uuidNumbered = await insertContract('uuid — Annual',
      'Auto-created from accepted quote 3f2c8a6e-1b7d-4e9a-9c2f-0d5e6a7b8c9d');
    const sameLineEdit = await insertContract('edited same line', `${PROVENANCE} — renewal agreed by phone`);
    const extraLine = await insertContract('edited extra line', `${PROVENANCE}\nCall Bob before invoicing.`);
    const prefixed = await insertContract('prefixed', `Note: ${PROVENANCE}`);
    const otherNotes = await insertContract('hand-written', 'Billed quarterly per MSA.');
    const nullNotes = await insertContract('no notes', null);
    // An invoice already generated from the exact-match contract keeps its notes.
    const invoiceId = rows(await db.execute(sql`
      INSERT INTO invoices (partner_id, org_id, currency_code, notes)
      VALUES (${partner.id}::uuid, ${org.id}::uuid, 'USD', ${`${PROVENANCE}\n\nNet 30`})
      RETURNING id`))[0]!.id as string;
    return { exact, uuidNumbered, sameLineEdit, extraLine, prefixed, otherNotes, nullNotes, invoiceId };
  });
}

const notesOf = async (id: string) =>
  rows(await sys(() => db.execute(sql`SELECT notes, terms FROM contracts WHERE id = ${id}::uuid`)))[0]!;
const invoiceNotes = async (id: string) =>
  rows(await sys(() => db.execute(sql`SELECT notes FROM invoices WHERE id = ${id}::uuid`)))[0]!.notes;

describe('clear auto-created contract notes (2027-01-02-100300, #9304)', () => {
  runDb('nulls exact system-text notes only, leaves edited notes and invoices alone', async () => {
    const s = await seed();
    const warnings = await runMigrationAsAdmin();
    expect(warnings).toEqual(['cleared auto-created provenance notes on 2 contracts']);

    expect(await notesOf(s.exact)).toEqual({ notes: null, terms: 'Net 30' });
    expect((await notesOf(s.uuidNumbered)).notes).toBeNull();
    expect((await notesOf(s.sameLineEdit)).notes).toBe(`${PROVENANCE} — renewal agreed by phone`);
    expect((await notesOf(s.extraLine)).notes).toBe(`${PROVENANCE}\nCall Bob before invoicing.`);
    expect((await notesOf(s.prefixed)).notes).toBe(`Note: ${PROVENANCE}`);
    expect((await notesOf(s.otherNotes)).notes).toBe('Billed quarterly per MSA.');
    expect((await notesOf(s.nullNotes)).notes).toBeNull();
    expect(await invoiceNotes(s.invoiceId)).toBe(`${PROVENANCE}\n\nNet 30`);
  });

  runDb('is idempotent: a second run clears nothing and changes nothing', async () => {
    const s = await seed();
    await runMigrationAsAdmin();
    const snapshot = await Promise.all([s.exact, s.sameLineEdit, s.extraLine].map(notesOf));

    const warnings = await runMigrationAsAdmin();
    expect(warnings).toEqual([]);
    expect(await Promise.all([s.exact, s.sameLineEdit, s.extraLine].map(notesOf))).toEqual(snapshot);
  });
});
