// DLP-on-ingest — real-DB integration (:5433 stack, breeze_app role). DLP runs
// ONCE, at ingest, between extraction and any persistence/embedding: 'redact'
// detectors rewrite the stored text (and therefore chunks, entities, and what
// the embedder/enrichment LLM ever see); a 'block' detector short-circuits the
// file to status=blocked_dlp with no text, no chunks, and no embedder call.
// Patterned on ingest/contentSearch harnesses: seeding via breeze_test, running
// via breeze_app under the org access context, in-memory fakes for reader/
// embedder/LLM (no network, no real APIs).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { WorkspaceDatabase } from '../hostTypes';
import { createContentIngestService } from '../services/contentIngestService';
import { createEnrichmentService, type EnrichmentInvoke } from '../services/enrichmentService';
import { FakeEmbedder, EMBEDDING_DIM, type Embedder } from '../content/embedder';
import type { ContentByteReader, ContentSourceRef } from '../content/byteReader';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
const APP_URL = process.env.DATABASE_URL_APP ?? 'postgresql://breeze_app:breeze_test@localhost:5433/breeze_test';
if (new URL(ADMIN_URL).port === '5432') throw new Error('refusing to run against :5432 — use the test stack (:5433)');

// A real Luhn-valid test card + a plausible SSN. These live only in the
// in-memory reader below — never on disk.
const RAW_CARD = '4111 1111 1111 1111';
const RAW_CARD_DIGITS = '4111111111111111';
const RAW_SSN = '123-45-6789';

// redact-case file: a card number to redact, plus a PO number that is NOT a DLP
// target and must survive redaction as an extracted entity.
const REDACT_REL = 'Projects/Accounting/payment-record.md';
const REDACT_BYTES = `Vendor payment record. PO 4021. Charge the card ${RAW_CARD} for the outstanding balance.`;
// block-case file: an SSN under a config that blocks SSNs.
const BLOCK_REL = 'Projects/HR/new-hire-onboarding.md';
const BLOCK_BYTES = `New hire onboarding. Employee SSN: ${RAW_SSN} on file with payroll.`;

// transition-case file: ingested CLEAN first (chunks + regex entities land),
// then its bytes change to something a block detector trips. The same-hash
// short-circuit only skips DLP on UNCHANGED bytes, so changed bytes are the
// reliable path to force a clean → blocked_dlp transition.
const TRANSITION_REL = 'Projects/Legal/roster.md';
const TRANSITION_CLEAN_BYTES = 'Team roster for the Legal matter. PO 7788 covers outside counsel. Kickoff next week.';
const TRANSITION_BLOCK_SSN = '567-89-1234';
const TRANSITION_BLOCK_BYTES = `Updated roster. Employee SSN: ${TRANSITION_BLOCK_SSN} added to payroll records.`;

// One org config: cards redact, SSNs block. The redact file has no SSN so it
// redacts; the block file has an SSN so it blocks.
const DLP_CONFIG = {
  detectors: {
    credit_card: 'redact', ssn: 'block', iban: 'off', api_key: 'off', email: 'off', phone: 'off',
  },
  customPatterns: [],
};

// force re-scan case: a file that is CLEAN under DLP_CONFIG (email off) but that
// a later, tightened config (email block) must flip to blocked_dlp — WITHOUT any
// byte change. Carries a PO number (a regex entity that lands on the clean pass
// and must be purged on the forced block). This is W2's a22f079 scenario reached
// via force instead of a byte change.
const FORCE_REL = 'Projects/Comms/team-memo.md';
const FORCE_CLEAN_BYTES = 'Team memo. PO 5501 covers the project. Reach alex@example.com with any questions.';
const DLP_CONFIG_EMAIL_BLOCK = {
  detectors: {
    credit_card: 'redact', ssn: 'block', iban: 'off', api_key: 'off', email: 'block', phone: 'off',
  },
  customPatterns: [],
};

// transient case: a pending file whose byte read fails (source down). The run
// must abort and leave NO content row, so the file stays pending and re-ingests
// cleanly once the source is back.
const TRANSIENT_REL = 'Projects/Ops/status-note.md';
const TRANSIENT_BYTES = 'Ops status note. PO 6602 tracked. All systems nominal.';

/** In-memory reader: rel_path → bytes. No disk, no network. */
class MapReader implements ContentByteReader {
  constructor(private readonly files: Record<string, string>) {}
  async read(_source: ContentSourceRef, relPath: string): Promise<Buffer> {
    const body = this.files[relPath];
    if (body === undefined) throw new Error(`no fixture for ${relPath}`);
    return Buffer.from(body, 'utf8');
  }
}

/** FakeEmbedder that records every text it is asked to embed. */
class CapturingEmbedder implements Embedder {
  readonly seen: string[] = [];
  private inner = new FakeEmbedder();
  async embed(texts: string[], _inputType: 'document' | 'query'): Promise<number[][]> {
    this.seen.push(...texts);
    return this.inner.embed(texts);
  }
}

/** Fake `invoke` that records the user prompt and returns a valid, minimal result. */
class CapturingInvoke {
  readonly prompts: string[] = [];
  invoke: EnrichmentInvoke = async (input) => {
    for (const m of input.messages) this.prompts.push(m.content);
    return {
      text: JSON.stringify({
        docType: 'payment record', projectKey: null, projectLabel: null,
        docDate: null, confidence: 'low', people: [],
      }),
    };
  };
}

let admin: postgres.Sql;
let app: postgres.Sql;
let appDb: ReturnType<typeof drizzle>;
let partner: string, org: string, source: string;
const fileIds: Record<string, string> = {};

async function withOrgTx<T>(fn: (db: WorkspaceDatabase) => Promise<T>): Promise<T> {
  return appDb.transaction(async (transaction) => {
    const tx = (transaction as unknown as { session: { client: postgres.TransactionSql } }).session.client;
    await tx`SELECT set_config('breeze.scope', 'organization', true),
                    set_config('breeze.org_id', ${org}, true),
                    set_config('breeze.accessible_org_ids', ${org}, true),
                    set_config('breeze.accessible_partner_ids', ${partner}, true),
                    set_config('breeze.user_id', '', true),
                    set_config('breeze.current_partner_id', '', true)`;
    return fn(transaction as unknown as WorkspaceDatabase);
  });
}

const capturingEmbedder = new CapturingEmbedder();

async function ingest(batch: number) {
  return withOrgTx((db) => createContentIngestService(db, {
    reader: new MapReader({ [REDACT_REL]: REDACT_BYTES, [BLOCK_REL]: BLOCK_BYTES }),
    embedder: capturingEmbedder,
  }).run(org, batch));
}

// Ingest with a caller-supplied byte map — used by the transition case, whose
// bytes for the SAME rel_path change between the clean and blocked runs.
async function ingestWith(files: Record<string, string>, batch: number) {
  return withOrgTx((db) => createContentIngestService(db, {
    reader: new MapReader(files),
    embedder: capturingEmbedder,
  }).run(org, batch));
}

// Forced sweep: re-scans EVERY eligible file against the current config. The
// map must therefore cover every live file's current bytes, or a missing
// fixture would read-fail and abort the sweep.
async function ingestForce(files: Record<string, string>, batch: number) {
  return withOrgTx((db) => createContentIngestService(db, {
    reader: new MapReader(files),
    embedder: capturingEmbedder,
  }).run(org, batch, { force: true }));
}

/** Reader that fails the read for one rel_path (source-down simulation). */
class DownReader implements ContentByteReader {
  constructor(private readonly down: string) {}
  async read(_source: ContentSourceRef, relPath: string): Promise<Buffer> {
    if (relPath === this.down) throw new Error('connect ECONNREFUSED 127.0.0.1:445');
    throw new Error(`no fixture for ${relPath}`);
  }
}

async function ingestWithReader(rd: ContentByteReader, batch: number) {
  return withOrgTx((db) => createContentIngestService(db, {
    reader: rd,
    embedder: capturingEmbedder,
  }).run(org, batch));
}

beforeAll(async () => {
  admin = postgres(ADMIN_URL, { max: 1 });
  app = postgres(APP_URL, { max: 1 });
  appDb = drizzle(app);
  partner = randomUUID(); org = randomUUID(); source = randomUUID();
  const sfx = randomUUID();
  await admin`INSERT INTO partners (id, name, slug) VALUES (${partner}, 'wsp-dlp', ${`wsp-dlp-${sfx}`})`;
  await admin`INSERT INTO organizations (id, partner_id, name, slug, currency_code)
              VALUES (${org}, ${partner}, 'wsp-dlp-org', ${`wsp-dlp-org-${sfx}`}, 'USD')`;
  await admin`INSERT INTO workspace_org_settings (org_id, content_enabled, dlp_config)
              VALUES (${org}, true, ${JSON.stringify(DLP_CONFIG)}::jsonb)`;
  await admin`INSERT INTO workspace_sources (id, org_id, kind, display_name, root_path, visibility_group_ids)
              VALUES (${source}, ${org}, 'smb_share', 'dlp estate', '\\\\127.0.0.1\\dlp', '[]'::jsonb)`;
  for (const rel of [REDACT_REL, BLOCK_REL]) {
    const id = randomUUID();
    fileIds[rel] = id;
    const parent = rel.slice(0, rel.lastIndexOf('/'));
    const name = rel.split('/').pop()!;
    await admin`INSERT INTO workspace_file_index (id, org_id, source_id, rel_path, parent_path, name, is_dir, ext, size, mtime)
                VALUES (${id}, ${org}, ${source}, ${rel}, ${parent}, ${name}, false, 'md', 100, now())`;
  }
});

afterAll(async () => {
  for (const t of ['workspace_content_chunks', 'workspace_content_entities', 'workspace_file_enrichment',
    'workspace_file_content', 'workspace_projects', 'workspace_file_index', 'workspace_sources',
    'workspace_org_settings']) {
    await admin.unsafe(`DELETE FROM ${t} WHERE org_id = $1`, [org]);
  }
  await admin`DELETE FROM organizations WHERE id = ${org}`;
  await admin`DELETE FROM partners WHERE id = ${partner}`;
  await admin.end(); await app.end();
});

describe('DLP-on-ingest (real DB)', () => {
  it('drains both files, redacting one and blocking the other in a single run', async () => {
    const run = await ingest(10);
    expect(run.errors).toEqual([]);
    expect(run.processed).toBe(2);
    expect(run.remaining).toBe(0);
  });

  it('redact case: stored text, chunks, entities, and the embedder see only redacted text', async () => {
    const redactId = fileIds[REDACT_REL];
    const [row] = await admin`SELECT status, extracted_text, dlp_findings
                              FROM workspace_file_content WHERE file_index_id = ${redactId}`;
    expect(row.status).toBe('extracted');
    expect(row.extracted_text).toContain('[REDACTED:credit_card]');
    expect(row.extracted_text).not.toContain(RAW_CARD_DIGITS);
    expect(row.extracted_text).not.toContain('4111');

    // dlp_findings records the redaction
    const findings = row.dlp_findings as Array<{ detector: string; action: string; count: number }>;
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ detector: 'credit_card', action: 'redact', count: 1 }),
    ]));

    // FTS over the stored text cannot surface the raw card number
    const [{ n: ftsHits }] = await admin`
      SELECT count(*)::int AS n FROM workspace_file_content
      WHERE org_id = ${org}
        AND to_tsvector('simple', coalesce(extracted_text, '')) @@ plainto_tsquery('simple', ${RAW_CARD_DIGITS})`;
    expect(ftsHits).toBe(0);

    // chunks carry redacted text only
    const chunks = await admin`SELECT text, vector_dims(embedding) AS dims
                               FROM workspace_content_chunks WHERE file_index_id = ${redactId}`;
    expect(chunks.length).toBeGreaterThan(0);
    for (const ch of chunks) {
      expect(ch.text as string).not.toContain('4111');
      expect(ch.text as string).toContain('[REDACTED:credit_card]');
      expect(Number(ch.dims)).toBe(EMBEDDING_DIM);
    }

    // entities (PO number) are extracted from the redacted text — PO is not a
    // DLP target and survives redaction.
    const entities = await admin`SELECT entity_type, value_norm FROM workspace_content_entities
                                 WHERE file_index_id = ${redactId}`;
    const po = entities.filter((e) => e.entity_type === 'po').map((e) => e.value_norm);
    expect(po).toEqual(['PO 4021']);

    // the embedder never saw the raw card, only the redacted token
    expect(capturingEmbedder.seen.some((t) => t.includes('4111'))).toBe(false);
    expect(capturingEmbedder.seen.some((t) => t.includes('[REDACTED:credit_card]'))).toBe(true);
  });

  it('block case: blocked_dlp status, no text, no chunks, embedder never called', async () => {
    const blockId = fileIds[BLOCK_REL];
    const [row] = await admin`SELECT status, extracted_text, dlp_findings
                              FROM workspace_file_content WHERE file_index_id = ${blockId}`;
    expect(row.status).toBe('blocked_dlp');
    expect(row.extracted_text).toBeNull();
    const findings = row.dlp_findings as Array<{ detector: string; action: string }>;
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ detector: 'ssn', action: 'block' }),
    ]));

    const chunks = await admin`SELECT id FROM workspace_content_chunks WHERE file_index_id = ${blockId}`;
    expect(chunks).toHaveLength(0);

    // the SSN never reached the embedder
    expect(capturingEmbedder.seen.some((t) => t.includes('123-45-6789'))).toBe(false);
  });

  it('block case: the blocked file is skipped, not retried, on the next run', async () => {
    const before = capturingEmbedder.seen.length;
    const rerun = await ingest(10);
    expect(rerun.processed).toBe(0);
    expect(rerun.remaining).toBe(0);
    // no new embedding work — nothing re-ingested
    expect(capturingEmbedder.seen.length).toBe(before);
    const blockId = fileIds[BLOCK_REL];
    const [row] = await admin`SELECT status FROM workspace_file_content WHERE file_index_id = ${blockId}`;
    expect(row.status).toBe('blocked_dlp');
  });

  it('enrichment case: the LLM prompt is built from redacted text, never the raw value', async () => {
    const capturing = new CapturingInvoke();
    const res = await withOrgTx((db) => createEnrichmentService(db, { invoke: capturing.invoke }).run(org, 10));
    expect(res.errors).toEqual([]);
    // only the redacted (extracted) file is enrichable; the blocked file is not
    expect(capturing.prompts.length).toBe(1);
    const prompt = capturing.prompts[0];
    expect(prompt).toContain('[REDACTED:credit_card]');
    expect(prompt).not.toContain('4111');
    expect(prompt).not.toContain(RAW_CARD_DIGITS);
  });

  it('transition case: a clean file that later blocks purges its stale chunks + regex entities', async () => {
    // A separate file, added here so it does not perturb the batch counts above.
    const transitionId = randomUUID();
    const parent = TRANSITION_REL.slice(0, TRANSITION_REL.lastIndexOf('/'));
    const name = TRANSITION_REL.split('/').pop()!;
    await admin`INSERT INTO workspace_file_index
                  (id, org_id, source_id, rel_path, parent_path, name, is_dir, ext, size, mtime)
                VALUES (${transitionId}, ${org}, ${source}, ${TRANSITION_REL}, ${parent}, ${name},
                        false, 'md', 100, now())`;

    // v1: clean bytes ingest → extracted, with chunks and a regex PO entity.
    const clean = await ingestWith({ [TRANSITION_REL]: TRANSITION_CLEAN_BYTES }, 10);
    expect(clean.errors).toEqual([]);
    expect(clean.processed).toBe(1);

    const [cleanRow] = await admin`SELECT status FROM workspace_file_content
                                   WHERE file_index_id = ${transitionId}`;
    expect(cleanRow.status).toBe('extracted');
    const chunksBefore = await admin`SELECT id FROM workspace_content_chunks
                                     WHERE file_index_id = ${transitionId}`;
    expect(chunksBefore.length).toBeGreaterThan(0);
    const entitiesBefore = await admin`SELECT id FROM workspace_content_entities
                                       WHERE file_index_id = ${transitionId} AND origin = 'regex'`;
    expect(entitiesBefore.length).toBeGreaterThan(0);

    // Bump the snapshot so the file is pending again, then feed v2 bytes that
    // trip the SSN block detector. Different bytes ⇒ no same-hash short-circuit,
    // so DLP re-applies and the file transitions extracted → blocked_dlp.
    await admin`UPDATE workspace_file_index SET size = 200, mtime = now()
                WHERE id = ${transitionId}`;
    const blocked = await ingestWith({ [TRANSITION_REL]: TRANSITION_BLOCK_BYTES }, 10);
    expect(blocked.errors).toEqual([]);
    expect(blocked.processed).toBe(1);

    const [blockedRow] = await admin`SELECT status, extracted_text FROM workspace_file_content
                                     WHERE file_index_id = ${transitionId}`;
    expect(blockedRow.status).toBe('blocked_dlp');
    expect(blockedRow.extracted_text).toBeNull();

    // The stale chunks from the clean ingest must be gone — the passages/chunk
    // scope reads straight from this table with no status join, so any survivor
    // stays retrievable after the block.
    const chunksAfter = await admin`SELECT id FROM workspace_content_chunks
                                    WHERE file_index_id = ${transitionId}`;
    expect(chunksAfter).toHaveLength(0);

    // The regex-derived entities from the clean ingest must be gone too.
    const entitiesAfter = await admin`SELECT id FROM workspace_content_entities
                                      WHERE file_index_id = ${transitionId} AND origin = 'regex'`;
    expect(entitiesAfter).toHaveLength(0);
  });

  it('force re-scan flips a stored clean file to blocked_dlp after tightening the config (no byte change)', async () => {
    const forceId = randomUUID();
    fileIds[FORCE_REL] = forceId;
    const parent = FORCE_REL.slice(0, FORCE_REL.lastIndexOf('/'));
    const name = FORCE_REL.split('/').pop()!;
    await admin`INSERT INTO workspace_file_index
                  (id, org_id, source_id, rel_path, parent_path, name, is_dir, ext, size, mtime)
                VALUES (${forceId}, ${org}, ${source}, ${FORCE_REL}, ${parent}, ${name}, false, 'md', 100, now())`;

    // v1: clean ingest under DLP_CONFIG (email off) → extracted, chunks + PO entity.
    const clean = await ingestWith({ [FORCE_REL]: FORCE_CLEAN_BYTES }, 10);
    expect(clean.errors).toEqual([]);
    expect(clean.transient).toBeNull();
    const [cleanRow] = await admin`SELECT status, extracted_text FROM workspace_file_content
                                   WHERE file_index_id = ${forceId}`;
    expect(cleanRow.status).toBe('extracted');
    expect(cleanRow.extracted_text as string).toContain('alex@example.com'); // email survived (off)
    const chunksBefore = await admin`SELECT id FROM workspace_content_chunks WHERE file_index_id = ${forceId}`;
    expect(chunksBefore.length).toBeGreaterThan(0);
    const entitiesBefore = await admin`SELECT id FROM workspace_content_entities
                                       WHERE file_index_id = ${forceId} AND origin = 'regex'`;
    expect(entitiesBefore.length).toBeGreaterThan(0);

    // Tighten the org config so email now BLOCKS — same bytes, new verdict.
    await admin`UPDATE workspace_org_settings SET dlp_config = ${JSON.stringify(DLP_CONFIG_EMAIL_BLOCK)}::jsonb
                WHERE org_id = ${org}`;

    // Forced sweep re-applies DLP to every eligible file — supply the full
    // estate's current bytes so no read aborts the sweep.
    const forced = await ingestForce({
      [REDACT_REL]: REDACT_BYTES,
      [BLOCK_REL]: BLOCK_BYTES,
      [TRANSITION_REL]: TRANSITION_BLOCK_BYTES,
      [FORCE_REL]: FORCE_CLEAN_BYTES,
    }, 50);
    expect(forced.errors).toEqual([]);
    expect(forced.transient).toBeNull();

    const [forcedRow] = await admin`SELECT status, extracted_text, dlp_findings FROM workspace_file_content
                                    WHERE file_index_id = ${forceId}`;
    expect(forcedRow.status).toBe('blocked_dlp');
    expect(forcedRow.extracted_text).toBeNull();
    const findings = forcedRow.dlp_findings as Array<{ detector: string; action: string }>;
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ detector: 'email', action: 'block' }),
    ]));

    // Stale chunks + regex entities from the clean pass must be purged — the
    // passages/chunk scope has no status join, so any survivor stays retrievable.
    const chunksAfter = await admin`SELECT id FROM workspace_content_chunks WHERE file_index_id = ${forceId}`;
    expect(chunksAfter).toHaveLength(0);
    const entitiesAfter = await admin`SELECT id FROM workspace_content_entities
                                      WHERE file_index_id = ${forceId} AND origin = 'regex'`;
    expect(entitiesAfter).toHaveLength(0);
  });

  it('a transient read failure leaves the file pending (no row) and it re-ingests once the source is back', async () => {
    const transientId = randomUUID();
    fileIds[TRANSIENT_REL] = transientId;
    const parent = TRANSIENT_REL.slice(0, TRANSIENT_REL.lastIndexOf('/'));
    const name = TRANSIENT_REL.split('/').pop()!;
    await admin`INSERT INTO workspace_file_index
                  (id, org_id, source_id, rel_path, parent_path, name, is_dir, ext, size, mtime)
                VALUES (${transientId}, ${org}, ${source}, ${TRANSIENT_REL}, ${parent}, ${name}, false, 'md', 100, now())`;

    // Source down: the only pending file read-fails → the run aborts and writes
    // nothing for it.
    const down = await ingestWithReader(new DownReader(TRANSIENT_REL), 10);
    expect(down.transient).not.toBeNull();
    expect(down.transient!.reason).toMatch(/reader:.*ECONNREFUSED/);
    expect(down.processed).toBe(0);
    const absent = await admin`SELECT id FROM workspace_file_content WHERE file_index_id = ${transientId}`;
    expect(absent).toHaveLength(0); // fully pending: no failed/blocked row parked it

    // Source back: the still-pending file ingests cleanly.
    const back = await ingestWith({ [TRANSIENT_REL]: TRANSIENT_BYTES }, 10);
    expect(back.errors).toEqual([]);
    expect(back.transient).toBeNull();
    expect(back.processed).toBe(1);
    const [row] = await admin`SELECT status FROM workspace_file_content WHERE file_index_id = ${transientId}`;
    expect(row.status).toBe('extracted');
  });
});
