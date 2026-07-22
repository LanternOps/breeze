/**
 * Real-Postgres contract tests for the data-only repair migration
 * `apps/api/migrations/2026-07-21-quote-orphan-line-and-number-backfill.sql`.
 *
 * Two quote defects were fixed on the WRITE path only, so every row written
 * before the fix stays broken forever:
 *   A. `quote_lines.block_id IS NULL` ("orphans") — rendered on the PDF/portal
 *      and counted in totals, but silently invisible in the web editor, which
 *      walks `quote_blocks` only.
 *   B. `quotes.quote_number IS NULL` on drafts created before numbering moved
 *      to create time (#2227) — with no UI to assign one, the quote is stuck.
 *
 * These tests execute the ACTUAL migration file (not a reimplementation of it)
 * against seeded broken rows, exactly the way `autoMigrate` does: the whole
 * file through `client.unsafe(content)` on a privileged connection. Anything
 * that reimplements the SQL here would prove nothing about the shipped file.
 *
 * NOTE: globalSetup already applied this migration once, against an empty
 * database — a no-op. Re-running it here is legitimate precisely because the
 * file is required to be idempotent.
 */
import './setup';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import postgres, { type Sql } from 'postgres';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../../migrations/2026-07-21-quote-orphan-line-and-number-backfill.sql'
);

// Same privileged URL the rest of the integration setup uses for seeding. The
// migration runner connects as the owner/superuser, so this mirrors production.
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

let sql: Sql;
let migrationSql: string;

beforeAll(() => {
  if (!process.env.DATABASE_URL) return;
  migrationSql = readFileSync(MIGRATION_PATH, 'utf8');
  sql = postgres(DATABASE_URL, { max: 3, idle_timeout: 20, connect_timeout: 10, onnotice: () => {} });
});

afterAll(async () => {
  if (sql) await sql.end();
});

/** Apply the migration file verbatim, exactly as autoMigrate does. */
async function applyMigration(): Promise<void> {
  await sql.unsafe(migrationSql);
}

async function seedTenant(): Promise<{ partnerId: string; orgId: string }> {
  const sfx = Math.random().toString(36).slice(2, 10);
  const [p] = await sql<{ id: string }[]>`
    INSERT INTO partners (name, slug, type, plan, status)
    VALUES (${`QB ${sfx}`}, ${`qb-${sfx}`}, 'msp', 'pro', 'active')
    RETURNING id
  `;
  const [o] = await sql<{ id: string }[]>`
    INSERT INTO organizations (partner_id, name, slug)
    VALUES (${p!.id}, 'QB Org', ${`qb-org-${sfx}`})
    RETURNING id
  `;
  return { partnerId: p!.id, orgId: o!.id };
}

async function seedQuote(
  t: { partnerId: string; orgId: string },
  opts: { quoteNumber?: string | null; sentAt?: string | null; createdAt?: string; status?: string } = {}
): Promise<string> {
  const [q] = await sql<{ id: string }[]>`
    INSERT INTO quotes (partner_id, org_id, quote_number, status, sent_at, created_at)
    VALUES (
      ${t.partnerId},
      ${t.orgId},
      ${opts.quoteNumber ?? null},
      ${(opts.status ?? 'draft') as string}::quote_status,
      ${opts.sentAt ?? null},
      ${opts.createdAt ?? '2026-01-15 10:00:00'}
    )
    RETURNING id
  `;
  return q!.id;
}

async function seedBlock(
  t: { orgId: string },
  quoteId: string,
  blockType: string,
  sortOrder: number
): Promise<string> {
  const [b] = await sql<{ id: string }[]>`
    INSERT INTO quote_blocks (quote_id, org_id, block_type, content, sort_order)
    VALUES (${quoteId}, ${t.orgId}, ${blockType}::quote_block_type, '{}'::jsonb, ${sortOrder})
    RETURNING id
  `;
  return b!.id;
}

/** Seed a line with block_id explicitly NULL — the broken "orphan" shape. */
async function seedOrphanLine(
  t: { orgId: string },
  quoteId: string,
  sortOrder: number
): Promise<string> {
  const [l] = await sql<{ id: string }[]>`
    INSERT INTO quote_lines (quote_id, block_id, org_id, source_type, description, quantity, unit_price, line_total, sort_order)
    VALUES (${quoteId}, NULL, ${t.orgId}, 'manual', ${`Orphan ${sortOrder}`}, 1, 100.00, 100.00, ${sortOrder})
    RETURNING id
  `;
  return l!.id;
}

async function blockIdOf(lineId: string): Promise<string | null> {
  const [r] = await sql<{ block_id: string | null }[]>`
    SELECT block_id FROM quote_lines WHERE id = ${lineId}
  `;
  return r!.block_id;
}

async function quoteNumberOf(quoteId: string): Promise<string | null> {
  const [r] = await sql<{ quote_number: string | null }[]>`
    SELECT quote_number FROM quotes WHERE id = ${quoteId}
  `;
  return r!.quote_number;
}

async function blocksOf(quoteId: string) {
  return sql<{ id: string; block_type: string; content: unknown; sort_order: number; org_id: string }[]>`
    SELECT id, block_type, content, sort_order, org_id
    FROM quote_blocks WHERE quote_id = ${quoteId}
    ORDER BY sort_order, created_at, id
  `;
}

async function counterOf(partnerId: string, year: number): Promise<number | null> {
  const [r] = await sql<{ counter: number }[]>`
    SELECT counter FROM partner_quote_sequences WHERE partner_id = ${partnerId} AND year = ${year}
  `;
  return r ? Number(r.counter) : null;
}

describe('quote backfill migration — PART A: orphan quote_lines', () => {
  runDb('attaches an orphan to the quote\'s EARLIEST existing line_items block', async () => {
    const t = await seedTenant();
    const quoteId = await seedQuote(t, { quoteNumber: 'Q-2026-9001' });
    // Deliberately insert out of sort order so "earliest" can only be satisfied
    // by sort_order, not by insertion/creation order.
    const later = await seedBlock(t, quoteId, 'line_items', 5);
    await seedBlock(t, quoteId, 'heading', 0);
    const earliest = await seedBlock(t, quoteId, 'line_items', 2);
    const orphan = await seedOrphanLine(t, quoteId, 0);

    expect(await blockIdOf(orphan)).toBeNull();
    await applyMigration();

    expect(await blockIdOf(orphan)).toBe(earliest);
    expect(await blockIdOf(orphan)).not.toBe(later);
    // No block was invented when a usable one already existed.
    expect((await blocksOf(quoteId)).length).toBe(3);
  });

  runDb('creates exactly ONE line_items block for a quote that has none, reused by every orphan', async () => {
    const t = await seedTenant();
    const quoteId = await seedQuote(t, { quoteNumber: 'Q-2026-9002' });
    // A non-line_items block exists, so the migration must still create one AND
    // must append after it (sort_order = max + 1), mirroring nextBlockSortOrder.
    await seedBlock(t, quoteId, 'heading', 0);
    await seedBlock(t, quoteId, 'rich_text', 3);
    const orphans = [
      await seedOrphanLine(t, quoteId, 0),
      await seedOrphanLine(t, quoteId, 1),
      await seedOrphanLine(t, quoteId, 2)
    ];

    await applyMigration();

    const blocks = await blocksOf(quoteId);
    const lineItemBlocks = blocks.filter((b) => b.block_type === 'line_items');
    expect(lineItemBlocks).toHaveLength(1);

    const created = lineItemBlocks[0]!;
    expect(created.sort_order).toBe(4); // max(0,3) + 1
    expect(created.content).toEqual({}); // mirrors resolveLineBlockId's `content: {}`
    expect(created.org_id).toBe(t.orgId); // tenant taken from the parent quote

    // ONE block per quote, not one per line.
    const attached = await Promise.all(orphans.map(blockIdOf));
    expect(attached).toEqual([created.id, created.id, created.id]);
  });

  runDb('leaves already-attached lines untouched', async () => {
    const t = await seedTenant();
    const quoteId = await seedQuote(t, { quoteNumber: 'Q-2026-9003' });
    const blockA = await seedBlock(t, quoteId, 'line_items', 0);
    const blockB = await seedBlock(t, quoteId, 'line_items', 1);
    const [attached] = await sql<{ id: string }[]>`
      INSERT INTO quote_lines (quote_id, block_id, org_id, source_type, description, quantity, unit_price, line_total, sort_order)
      VALUES (${quoteId}, ${blockB}, ${t.orgId}, 'manual', 'Already placed', 1, 50.00, 50.00, 0)
      RETURNING id
    `;

    await applyMigration();

    // Still in block B — NOT relocated to the earliest block.
    expect(await blockIdOf(attached!.id)).toBe(blockB);
    expect(blockB).not.toBe(blockA);
  });

  runDb('does not leak a block across quotes — each affected quote gets its own', async () => {
    const t = await seedTenant();
    const q1 = await seedQuote(t, { quoteNumber: 'Q-2026-9004' });
    const q2 = await seedQuote(t, { quoteNumber: 'Q-2026-9005' });
    const o1 = await seedOrphanLine(t, q1, 0);
    const o2 = await seedOrphanLine(t, q2, 0);

    await applyMigration();

    const b1 = await blockIdOf(o1);
    const b2 = await blockIdOf(o2);
    expect(b1).not.toBeNull();
    expect(b2).not.toBeNull();
    expect(b1).not.toBe(b2);
    expect((await blocksOf(q1)).map((b) => b.id)).toEqual([b1]);
    expect((await blocksOf(q2)).map((b) => b.id)).toEqual([b2]);
  });
});

describe('quote backfill migration — PART B: missing quote_number', () => {
  runDb('numbers a never-sent draft via partner_quote_sequences in formatQuoteNumber shape', async () => {
    const t = await seedTenant();
    const quoteId = await seedQuote(t, { quoteNumber: null, sentAt: null, createdAt: '2025-03-04 09:00:00' });

    expect(await counterOf(t.partnerId, 2025)).toBeNull();
    await applyMigration();

    // Year comes from the quote's created_at, counter zero-padded to 4.
    expect(await quoteNumberOf(quoteId)).toBe('Q-2025-0001');
    // Allocation went THROUGH the sequence table, not computed inline.
    expect(await counterOf(t.partnerId, 2025)).toBe(1);
  });

  runDb('continues an EXISTING partner sequence rather than restarting at 1', async () => {
    const t = await seedTenant();
    await sql`
      INSERT INTO partner_quote_sequences (partner_id, year, counter)
      VALUES (${t.partnerId}, 2026, 7)
    `;
    const quoteId = await seedQuote(t, { quoteNumber: null, sentAt: null, createdAt: '2026-05-02 09:00:00' });

    await applyMigration();

    expect(await quoteNumberOf(quoteId)).toBe('Q-2026-0008');
    expect(await counterOf(t.partnerId, 2026)).toBe(8);
  });

  runDb('allocates distinct numbers to multiple drafts, oldest first, without colliding', async () => {
    const t = await seedTenant();
    const older = await seedQuote(t, { quoteNumber: null, createdAt: '2026-02-01 09:00:00' });
    const newer = await seedQuote(t, { quoteNumber: null, createdAt: '2026-02-09 09:00:00' });

    await applyMigration();

    expect(await quoteNumberOf(older)).toBe('Q-2026-0001');
    expect(await quoteNumberOf(newer)).toBe('Q-2026-0002');
    expect(await counterOf(t.partnerId, 2026)).toBe(2);
  });

  runDb('skips a candidate number already held by another quote of the same partner', async () => {
    const t = await seedTenant();
    // Q-2026-0001 is taken; the sequence is behind (a partial-restore shape).
    await seedQuote(t, { quoteNumber: 'Q-2026-0001', createdAt: '2026-01-02 09:00:00' });
    const stuck = await seedQuote(t, { quoteNumber: null, createdAt: '2026-01-03 09:00:00' });

    await applyMigration();

    // Burned counter 1 (occupied), landed on 2 — no unique-index abort.
    expect(await quoteNumberOf(stuck)).toBe('Q-2026-0002');
  });

  runDb('leaves a SENT quote with a NULL number ALONE (never renumber a delivered document)', async () => {
    const t = await seedTenant();
    const sent = await seedQuote(t, {
      quoteNumber: null,
      sentAt: '2026-04-01 12:00:00',
      status: 'sent',
      createdAt: '2026-03-01 09:00:00'
    });

    await applyMigration();

    expect(await quoteNumberOf(sent)).toBeNull();
    // And no counter was burned on its behalf.
    expect(await counterOf(t.partnerId, 2026)).toBeNull();
  });

  runDb('does not rewrite an existing quote_number', async () => {
    const t = await seedTenant();
    const quoteId = await seedQuote(t, { quoteNumber: 'Q-2026-0042', createdAt: '2026-06-01 09:00:00' });

    await applyMigration();

    expect(await quoteNumberOf(quoteId)).toBe('Q-2026-0042');
    expect(await counterOf(t.partnerId, 2026)).toBeNull();
  });
});

describe('quote backfill migration — idempotency', () => {
  runDb('a second application is a complete no-op (no re-number, no duplicate block)', async () => {
    const t = await seedTenant();

    // Orphan with no line_items block anywhere.
    const qOrphan = await seedQuote(t, { quoteNumber: 'Q-2026-9100' });
    const orphanA = await seedOrphanLine(t, qOrphan, 0);
    const orphanB = await seedOrphanLine(t, qOrphan, 1);
    // Unsent draft with no number.
    const qUnnumbered = await seedQuote(t, { quoteNumber: null, createdAt: '2026-07-01 09:00:00' });
    // Sent quote with no number — must stay NULL across both runs.
    const qSent = await seedQuote(t, {
      quoteNumber: null, sentAt: '2026-07-02 12:00:00', status: 'sent', createdAt: '2026-07-02 09:00:00'
    });

    await applyMigration();

    const firstBlocks = await blocksOf(qOrphan);
    const firstState = {
      blockIds: firstBlocks.map((b) => b.id),
      orphanA: await blockIdOf(orphanA),
      orphanB: await blockIdOf(orphanB),
      number: await quoteNumberOf(qUnnumbered),
      sentNumber: await quoteNumberOf(qSent),
      counter: await counterOf(t.partnerId, 2026)
    };
    expect(firstState.blockIds).toHaveLength(1);
    expect(firstState.number).toBe('Q-2026-0001');
    expect(firstState.counter).toBe(1);

    // ---- second application ----
    await applyMigration();

    expect((await blocksOf(qOrphan)).map((b) => b.id)).toEqual(firstState.blockIds);
    expect(await blockIdOf(orphanA)).toBe(firstState.orphanA);
    expect(await blockIdOf(orphanB)).toBe(firstState.orphanB);
    expect(await quoteNumberOf(qUnnumbered)).toBe(firstState.number);
    expect(await quoteNumberOf(qSent)).toBeNull();
    // The decisive assertion: no counter was burned on the re-run.
    expect(await counterOf(t.partnerId, 2026)).toBe(firstState.counter);

    // ---- third application, for good measure ----
    await applyMigration();
    expect(await counterOf(t.partnerId, 2026)).toBe(firstState.counter);
    expect((await blocksOf(qOrphan)).map((b) => b.id)).toEqual(firstState.blockIds);
  });

  runDb('is a no-op on a database with nothing to repair', async () => {
    const t = await seedTenant();
    const quoteId = await seedQuote(t, { quoteNumber: 'Q-2026-0500', createdAt: '2026-08-01 09:00:00' });
    const block = await seedBlock(t, quoteId, 'line_items', 0);
    await sql`
      INSERT INTO quote_lines (quote_id, block_id, org_id, source_type, description, quantity, unit_price, line_total, sort_order)
      VALUES (${quoteId}, ${block}, ${t.orgId}, 'manual', 'Healthy', 1, 10.00, 10.00, 0)
    `;

    await applyMigration();

    expect((await blocksOf(quoteId)).map((b) => b.id)).toEqual([block]);
    expect(await quoteNumberOf(quoteId)).toBe('Q-2026-0500');
    expect(await counterOf(t.partnerId, 2026)).toBeNull();
  });
});
