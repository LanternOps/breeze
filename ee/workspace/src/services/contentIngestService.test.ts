// contentIngestService — unit tests for the W3 additive behavior: the
// transient/permanent error taxonomy, per-file write atomicity (embed OUTSIDE
// the persist tx), and force-mode DLP re-scan. Extraction, DLP, entities,
// projects and org-settings are mocked so these tests exercise the service's
// control flow only; the real DLP/extraction behavior is pinned by the
// dlpIngest integration suite.
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { WorkspaceDatabase } from '../hostTypes';
import type { ContentByteReader } from '../content/byteReader';
import type { Embedder } from '../content/embedder';
import { TransientIngestError } from './ingestErrors';

vi.mock('../content/extract', () => ({ extractContent: vi.fn() }));
vi.mock('../content/dlp', () => ({ applyDlpToText: vi.fn() }));
vi.mock('../content/entities', () => ({ extractEntities: vi.fn(() => []) }));
vi.mock('../content/projects', () => ({ deriveDeclaredProject: vi.fn(() => null) }));
vi.mock('./orgSettingsService', () => ({
  getOrgSettings: vi.fn(async () => ({
    contentEnabled: true,
    dlpConfig: { detectors: {}, customPatterns: [] },
  })),
}));

import { createContentIngestService } from './contentIngestService';
import { extractContent } from '../content/extract';
import { applyDlpToText } from '../content/dlp';

const extractMock = extractContent as unknown as Mock;
const dlpMock = applyDlpToText as unknown as Mock;

const ORG = '11111111-1111-1111-1111-111111111111';

// Flatten a drizzle SQL object to its literal fragments so we can classify a
// query (params are not needed for routing; captured separately via boundValues).
function sqlText(value: unknown): string {
  if (Array.isArray(value)) return value.map(sqlText).join('');
  if (!value || typeof value !== 'object') return '';
  const candidate = value as { value?: unknown; queryChunks?: unknown[] };
  const own = Array.isArray(candidate.value) && candidate.value.every((p) => typeof p === 'string')
    ? candidate.value.join('')
    : '';
  return own + (candidate.queryChunks ?? []).map(sqlText).join('');
}

function boundValues(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => (item && typeof item === 'object' ? boundValues(item) : [item]));
  }
  if (!value || typeof value !== 'object') return [];
  const candidate = value as { value?: unknown; queryChunks?: unknown[] };
  const own = Object.prototype.hasOwnProperty.call(candidate, 'value')
    ? (Array.isArray(candidate.value) ? candidate.value : [candidate.value])
    : [];
  return [
    ...own,
    ...(candidate.queryChunks ?? []).flatMap((item) => (item && typeof item === 'object' ? boundValues(item) : [item])),
  ];
}

function classify(text: string): string {
  if (text.includes('ORDER BY fi.rel_path')) return 'pending';
  if (text.includes('count(*)::int AS n') && text.includes('c.updated_at')) return 'forceCount';
  if (text.includes('count(*)::int AS n') && text.includes('NOT EXISTS')) return 'count';
  if (text.includes('INSERT INTO workspace_file_content')) return 'upsertContent';
  if (text.includes('UPDATE workspace_file_content')) return 'snapshotUpdate';
  if (text.includes('DELETE FROM workspace_content_chunks')) return 'deleteChunks';
  if (text.includes('INSERT INTO workspace_content_chunks')) return 'insertChunk';
  if (text.includes('DELETE FROM workspace_content_entities')) return 'deleteEntities';
  if (text.includes('INSERT INTO workspace_content_entities')) return 'insertEntity';
  if (text.includes('workspace_projects')) return 'project';
  if (text.includes('workspace_file_enrichment')) return 'enrichment';
  return 'other';
}

interface Call { kind: string; text: string; values: unknown[] }

function pendingRow(over: Record<string, unknown> = {}) {
  return {
    id: 'file-a', source_id: 'src-1', rel_path: 'Docs/a.md', name: 'a.md',
    size: 100, mtime: '2026-01-01T00:00:00Z', root_path: '\\\\srv\\share', source_kind: 'smb_share',
    content_hash: null, content_status: null, extracted_text: null, ...over,
  };
}

function makeDb(pendingRows: unknown[], remaining = 0) {
  const calls: Call[] = [];
  const execute = vi.fn(async (q: unknown) => {
    const text = sqlText(q);
    const kind = classify(text);
    calls.push({ kind, text, values: boundValues(q) });
    if (kind === 'pending') return pendingRows;
    if (kind === 'count' || kind === 'forceCount') return [{ n: remaining }];
    return [];
  });
  const db: Record<string, unknown> = { execute };
  db.transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));
  return { db: db as unknown as WorkspaceDatabase, raw: db, calls, execute };
}

function reader(fn: (rel: string) => Buffer | Promise<Buffer>): ContentByteReader {
  return { read: vi.fn(async (_src, rel: string) => fn(rel)) };
}

function recordingEmbedder(calls: Call[], opts: { throwTransient?: boolean } = {}): Embedder {
  return {
    embed: vi.fn(async (texts: string[]) => {
      calls.push({ kind: 'embed', text: '', values: [] });
      if (opts.throwTransient) throw new TransientIngestError('voyage_rate_limited:5/2rpm');
      return texts.map(() => [0.1, 0.2, 0.3]);
    }),
  };
}

const kindsOf = (calls: Call[]) => calls.map((c) => c.kind);

beforeEach(() => {
  extractMock.mockReset();
  dlpMock.mockReset();
  // Defaults: text file extracts cleanly; DLP passes it through untouched.
  extractMock.mockImplementation(async (_name: string, bytes: Buffer) => ({
    status: 'extracted', text: bytes.toString('utf8'), contentHash: 'hash-default', emailMeta: null,
  }));
  dlpMock.mockImplementation((text: string) => ({ text, findings: [], blocked: false }));
});

describe('contentIngestService.run — transient taxonomy', () => {
  it('reader ECONNREFUSED aborts the batch after N processed, writing no row for the failed file', async () => {
    const { db, calls } = makeDb([
      pendingRow({ id: 'file-a', rel_path: 'Docs/a.md', name: 'a.md' }),
      pendingRow({ id: 'file-b', rel_path: 'Docs/b.md', name: 'b.md' }),
    ]);
    const rd = reader((rel) => {
      if (rel === 'Docs/b.md') throw new Error('connect ECONNREFUSED 10.0.0.5:445');
      return Buffer.from('clean body', 'utf8');
    });
    const svc = createContentIngestService(db, { reader: rd, embedder: recordingEmbedder(calls) });

    const res = await svc.run(ORG, 10);

    expect(res.transient).not.toBeNull();
    expect(res.transient!.reason).toMatch(/reader:.*ECONNREFUSED/);
    expect(res.transient!.abortedAfter).toBe(1); // file-a processed before file-b aborted
    expect(res.processed).toBe(1);
    // Only file-a's content row was written; file-b never got a row (no failed row either).
    expect(kindsOf(calls).filter((k) => k === 'upsertContent')).toHaveLength(1);
  });

  it('embedder transient failure writes nothing and never reaches a chunk DELETE', async () => {
    const { db, calls, raw } = makeDb([pendingRow()]);
    const svc = createContentIngestService(db, {
      reader: reader(() => Buffer.from('needs embedding', 'utf8')),
      embedder: recordingEmbedder(calls, { throwTransient: true }),
    });

    const res = await svc.run(ORG, 10);

    expect(res.transient).not.toBeNull();
    expect(res.transient!.reason).toMatch(/voyage_rate_limited/);
    expect(res.transient!.abortedAfter).toBe(0);
    expect(res.processed).toBe(0);
    // embed happened, but the persist tx never opened → no content row, no chunk writes.
    expect(kindsOf(calls)).toContain('embed');
    expect(kindsOf(calls)).not.toContain('upsertContent');
    expect(kindsOf(calls)).not.toContain('deleteChunks');
    expect(kindsOf(calls)).not.toContain('insertChunk');
    expect(raw.transaction).not.toHaveBeenCalled();
  });
});

describe('contentIngestService.run — permanent path (pinned W2 behavior)', () => {
  it('a permanent extract failure writes a failed row + snapshot and the loop continues', async () => {
    extractMock.mockResolvedValue({ status: 'failed', errorReason: 'parse boom' });
    const { db, calls } = makeDb([pendingRow({ size: 100 })]);
    const svc = createContentIngestService(db, {
      reader: reader(() => Buffer.from('junk', 'utf8')),
      embedder: recordingEmbedder(calls),
    });

    const res = await svc.run(ORG, 10);

    expect(res.transient).toBeNull();
    expect(res.errors).toEqual([]);
    expect(res.processed).toBe(1);
    const upsert = calls.find((c) => c.kind === 'upsertContent')!;
    expect(upsert).toBeDefined();
    // failed status + snapshot size (100) + reason are all bound into the row.
    expect(upsert.values).toContain('failed');
    expect(upsert.values).toContain('parse boom');
    expect(upsert.values).toContain(100);
  });
});

describe('contentIngestService.run — per-file atomicity ordering', () => {
  it('embeds BEFORE opening the persist tx (embed precedes content-row write and chunk DELETE)', async () => {
    const { db, calls, raw } = makeDb([pendingRow()]);
    const svc = createContentIngestService(db, {
      reader: reader(() => Buffer.from('body to embed', 'utf8')),
      embedder: recordingEmbedder(calls),
    });

    const res = await svc.run(ORG, 10);

    expect(res.processed).toBe(1);
    expect(res.transient).toBeNull();
    expect(raw.transaction).toHaveBeenCalledTimes(1);
    const ks = kindsOf(calls);
    const iEmbed = ks.indexOf('embed');
    const iUpsert = ks.indexOf('upsertContent');
    const iDelete = ks.indexOf('deleteChunks');
    const iInsert = ks.indexOf('insertChunk');
    expect(iEmbed).toBeGreaterThanOrEqual(0);
    expect(iEmbed).toBeLessThan(iUpsert);
    expect(iEmbed).toBeLessThan(iDelete);
    expect(iDelete).toBeLessThan(iInsert);
  });
});

describe('contentIngestService.run — same-hash short-circuit vs force', () => {
  const H = 'hash-1';

  it('non-force same-hash refreshes the snapshot only and never re-applies DLP or embeds', async () => {
    extractMock.mockResolvedValue({ status: 'extracted', text: 'hello', contentHash: H, emailMeta: null });
    const { db, calls } = makeDb([pendingRow({ content_hash: H, content_status: 'extracted', extracted_text: 'hello' })]);
    const embedder = recordingEmbedder(calls);
    const svc = createContentIngestService(db, { reader: reader(() => Buffer.from('hello', 'utf8')), embedder });

    const res = await svc.run(ORG, 10);

    expect(res.processed).toBe(1);
    expect(dlpMock).not.toHaveBeenCalled();
    expect((embedder.embed as Mock)).not.toHaveBeenCalled();
    expect(kindsOf(calls)).toContain('snapshotUpdate');
    expect(kindsOf(calls)).not.toContain('upsertContent');
  });

  it('force re-applies DLP to same-hash bytes; an unchanged verdict skips the chunk rewrite', async () => {
    extractMock.mockResolvedValue({ status: 'extracted', text: 'hello', contentHash: H, emailMeta: null });
    dlpMock.mockReturnValue({ text: 'hello', findings: [], blocked: false }); // identical outcome
    const { db, calls } = makeDb([pendingRow({ content_hash: H, content_status: 'extracted', extracted_text: 'hello' })]);
    const embedder = recordingEmbedder(calls);
    const svc = createContentIngestService(db, { reader: reader(() => Buffer.from('hello', 'utf8')), embedder });

    const res = await svc.run(ORG, 10, { force: true });

    expect(res.processed).toBe(1);
    expect(dlpMock).toHaveBeenCalledTimes(1); // DLP re-applied despite same hash
    expect((embedder.embed as Mock)).not.toHaveBeenCalled(); // nothing changed → no re-embed
    expect(kindsOf(calls)).toContain('snapshotUpdate');
    expect(kindsOf(calls)).not.toContain('deleteChunks');
    expect(kindsOf(calls)).not.toContain('insertChunk');
    expect(kindsOf(calls)).not.toContain('upsertContent');
  });

  it('force reports the force-aware remaining (unvisited files), not the non-force snapshot count', async () => {
    const forceSince = new Date('2026-07-19T00:00:00Z');
    // Two rows come back for this batch (the mock ignores LIMIT); both extract
    // cleanly with matching snapshots, so the NON-force pendingCount would be 0.
    // The force-aware count instead reports 3 files this sweep has not yet
    // visited — the value that must drive phase completion.
    const { db, calls } = makeDb([
      pendingRow({ id: 'file-a', rel_path: 'a.md' }),
      pendingRow({ id: 'file-b', rel_path: 'b.md' }),
    ], 3);
    const svc = createContentIngestService(db, {
      reader: reader(() => Buffer.from('body', 'utf8')),
      embedder: recordingEmbedder(calls),
    });

    const res = await svc.run(ORG, 2, { force: true, forceSince });

    expect(res.processed).toBe(2);
    // Force-aware remaining surfaces the unvisited files, NOT 0.
    expect(res.remaining).toBe(3);
    // The count is the force-aware query (joins content, filters updated_at) —
    // never the non-force NOT EXISTS snapshot count.
    const countKinds = calls
      .filter((c) => c.kind === 'forceCount' || c.kind === 'count')
      .map((c) => c.kind);
    expect(countKinds).toContain('forceCount');
    expect(countKinds).not.toContain('count');
    // forceSince is bound as an ISO ::timestamptz string (never a raw Date).
    const forceCount = calls.find((c) => c.kind === 'forceCount')!;
    expect(forceCount.values).toContain(forceSince.toISOString());
  });

  it('force flips a previously-clean file to blocked_dlp and purges chunks + regex entities', async () => {
    extractMock.mockResolvedValue({ status: 'extracted', text: 'ssn here', contentHash: H, emailMeta: null });
    dlpMock.mockReturnValue({ text: 'ssn here', findings: [{ detector: 'ssn', action: 'block', count: 1 }], blocked: true });
    const { db, calls } = makeDb([pendingRow({ content_hash: H, content_status: 'extracted', extracted_text: 'ssn here' })]);
    const embedder = recordingEmbedder(calls);
    const svc = createContentIngestService(db, { reader: reader(() => Buffer.from('ssn here', 'utf8')), embedder });

    const res = await svc.run(ORG, 10, { force: true });

    expect(res.processed).toBe(1);
    expect(dlpMock).toHaveBeenCalledTimes(1);
    expect((embedder.embed as Mock)).not.toHaveBeenCalled();
    const upsert = calls.find((c) => c.kind === 'upsertContent')!;
    expect(upsert.values).toContain('blocked_dlp');
    expect(kindsOf(calls)).toContain('deleteChunks');
    expect(kindsOf(calls)).toContain('deleteEntities');
  });
});

// WS-1 graduation guarantee: the spec's central claim is that no un-DLP'd
// text ever reaches persistence or a vendor (the embedder). This is a
// characterization test, not TDD red-green — it pins behavior the service
// already implements (see the DLP-on-ingest block in contentIngestService.ts,
// between extractContent and any persist/embed call). A failure here means
// the graduation premise is wrong and must be escalated, not "fixed" by
// editing this test.
describe('DLP chokepoint (graduation guarantee)', () => {
  it('never calls the embedder for a DLP-blocked file', async () => {
    extractMock.mockResolvedValue({
      status: 'extracted', text: 'SSN 123-45-6789', contentHash: 'h1', emailMeta: null,
    });
    dlpMock.mockReturnValue({
      text: 'SSN [REDACTED]',
      findings: [{ detector: 'ssn', action: 'block', count: 1 }],
      blocked: true,
    });

    const { db } = makeDb([pendingRow()]);
    const embed = vi.fn(async () => [[0.1]]);
    const service = createContentIngestService(db, {
      reader: reader(() => Buffer.from('irrelevant', 'utf8')),
      embedder: { embed } as unknown as Embedder,
    });

    await service.run(ORG, 10);

    expect(embed).not.toHaveBeenCalled();
  });

  it('passes only post-DLP text to the embedder for a clean file', async () => {
    extractMock.mockResolvedValue({
      status: 'extracted', text: 'card 4111111111111111', contentHash: 'h2', emailMeta: null,
    });
    dlpMock.mockReturnValue({
      text: 'card [REDACTED]',
      findings: [{ detector: 'pan', action: 'redact', count: 1 }],
      blocked: false,
    });

    const { db } = makeDb([pendingRow()]);
    const embed = vi.fn(async () => [[0.1]]);
    const service = createContentIngestService(db, {
      reader: reader(() => Buffer.from('irrelevant', 'utf8')),
      embedder: { embed } as unknown as Embedder,
    });

    await service.run(ORG, 10);

    const embedded = embed.mock.calls.flat(2).join(' ');
    expect(embedded).not.toContain('4111111111111111');
    expect(embedded).toContain('[REDACTED]');
  });
});
