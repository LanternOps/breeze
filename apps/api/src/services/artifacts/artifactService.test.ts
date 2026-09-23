/**
 * Execution-plane W01 (spec §5.2, §8, §9, §12). Proves the properties that are
 * NOT visible from the route or the capture hook:
 *   - blob is written BEFORE the row, and a row-insert failure compensates by
 *     deleting the blob (the key would otherwise be unreachable forever),
 *   - delete removes the blob BEFORE the row (the row is the only key index),
 *   - previews are RAW head/tail bytes, redacted, NUL-stripped, ≤ 2048 chars,
 *   - resolveArtifact returns null for the wrong org — never a distinguishable
 *     "forbidden",
 *   - toArtifactDto never leaks blobKey.
 */
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  insertValues: [] as Record<string, unknown>[],
  insertRows: [] as unknown[],
  insertError: null as unknown,
  selectRows: [] as unknown[][],
  deleteWheres: [] as unknown[],
  calls: [] as string[],
}));

vi.mock('../../db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, unknown>) => {
        mocks.insertValues.push(v);
        mocks.calls.push('row:insert');
        return {
          returning: vi.fn(async () => {
            if (mocks.insertError) throw mocks.insertError;
            return mocks.insertRows.shift() ?? [];
          }),
        };
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => mocks.selectRows.shift() ?? []),
          orderBy: vi.fn(async () => mocks.selectRows.shift() ?? []),
        })),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async (w: unknown) => {
        mocks.deleteWheres.push(w);
        mocks.calls.push('row:delete');
        return undefined;
      }),
    })),
  },
}));

import {
  ARTIFACT_PREVIEW_BYTES,
  ARTIFACT_READ_MAX_CHARS,
  REDACTED_CAPTURE_SINCE,
  buildPreviews,
  createArtifact,
  deleteArtifact,
  findArtifactForCaller,
  listArtifactsForAuth,
  readArtifactWindow,
  resolveArtifact,
  sanitizeArtifactName,
  toArtifactDto,
  type ArtifactRecord,
} from './artifactService';
import { createMemoryBlobStorage, setBlobStorageForTests, type BlobStorage } from './blobStorage';

/** A BlobStorage double that only implements openRange — readArtifactWindow never calls put/openStream/delete. */
function fakeRangeStore(body: Buffer): BlobStorage {
  return {
    put: () => { throw new Error('not implemented'); },
    openStream: () => { throw new Error('not implemented'); },
    delete: () => { throw new Error('not implemented'); },
    async openRange(_key: string, start: number, endInclusive: number) {
      return Readable.from([body.subarray(start, endInclusive + 1)]);
    },
  } as unknown as BlobStorage;
}

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000a2';
const RUN = '00000000-0000-4000-8000-0000000000a3';
const ART = '00000000-0000-4000-8000-0000000000a4';
const SESSION = '00000000-0000-4000-8000-0000000000a5';

let blobs: ReturnType<typeof createMemoryBlobStorage>;

beforeEach(() => {
  mocks.insertValues.length = 0;
  mocks.insertRows.length = 0;
  mocks.selectRows.length = 0;
  mocks.deleteWheres.length = 0;
  mocks.calls.length = 0;
  mocks.insertError = null;
  blobs = createMemoryBlobStorage();
  // Trace blob ops into the SAME ordered list as the row ops, so
  // "blob before row" is provable rather than assumed.
  const realPut = blobs.put.bind(blobs);
  const realDelete = blobs.delete.bind(blobs);
  blobs.put = async (input) => { mocks.calls.push('blob:put'); return realPut(input); };
  blobs.delete = async (key) => { mocks.calls.push('blob:delete'); return realDelete(key); };
  setBlobStorageForTests(blobs);
});
afterEach(() => { setBlobStorageForTests(null); vi.clearAllMocks(); });

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: ART, orgId: ORG, runId: RUN, sessionId: null, kind: 'input_capture',
    name: 'search_logs.json', contentType: 'application/json', bytes: 20, sha256: 'a'.repeat(64),
    blobKey: 'us/2026/10/abc', headPreview: '{"rows"', tailPreview: ']}',
    sourceDeviceId: null, createdByTool: 'search_logs',
    expiresAt: new Date('2026-11-15T00:00:00Z'), createdAt: new Date('2026-10-16T00:00:00Z'),
    ...over,
  };
}

describe('sanitizeArtifactName', () => {
  it('keeps a basename, strips separators, control chars and quotes, caps at 200', () => {
    expect(sanitizeArtifactName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeArtifactName('a"b\\c\u0000d')).toBe('abcd');
    expect(sanitizeArtifactName('x'.repeat(500))).toHaveLength(200);
  });

  it('falls back to a constant when nothing survives', () => {
    expect(sanitizeArtifactName('   ')).toBe('artifact');
    expect(sanitizeArtifactName('/')).toBe('artifact');
  });
});

describe('buildPreviews (spec §5.2 — RAW bytes, never a rendered form)', () => {
  it('returns the whole content in head and tail when it is short', () => {
    const { headPreview, tailPreview } = buildPreviews('{"a":1}');
    expect(headPreview).toBe('{"a":1}');
    expect(tailPreview).toBe('{"a":1}');
  });

  it.each([Buffer.from([0xff, 0xfe, 0x61]), Buffer.from('binary\u0000data')])(
    'does not decode binary bytes even when labelled as text', (body) => {
      expect(buildPreviews(body)).toEqual({ headPreview: '', tailPreview: '' });
    },
  );

  it('caps each side at ARTIFACT_PREVIEW_BYTES and takes head from the start, tail from the end', () => {
    const raw = `HEAD${'x'.repeat(10_000)}TAIL`;
    const { headPreview, tailPreview } = buildPreviews(raw);
    expect(headPreview.startsWith('HEAD')).toBe(true);
    expect(tailPreview.endsWith('TAIL')).toBe(true);
    expect(headPreview.length).toBeLessThanOrEqual(ARTIFACT_PREVIEW_BYTES);
    expect(tailPreview.length).toBeLessThanOrEqual(ARTIFACT_PREVIEW_BYTES);
  });

  it('strips NUL (Postgres text rejects it) and redacts bare secrets', () => {
    const { headPreview } = buildPreviews('tok=sk-ant-abcdefghijklmnopqrstuv\u0000end');
    expect(headPreview).not.toContain('\u0000');
    expect(headPreview).not.toContain('sk-ant-abcdefghijklmnopqrstuv');
    expect(headPreview).toContain('[REDACTED]');
  });
});

describe('createArtifact', () => {
  it('writes the blob BEFORE the row and returns the stored bytes/sha256', async () => {
    mocks.insertRows.push([row()]);
    const record = await createArtifact({
      orgId: ORG, runId: RUN, kind: 'input_capture', name: 'search_logs.json',
      contentType: 'application/json', body: Buffer.from('{"rows":[1,2,3,4,5]}'),
      maxBytes: 1024, createdByTool: 'search_logs', region: 'us',
    });
    expect(mocks.calls).toEqual(['blob:put', 'row:insert']);
    expect(record.id).toBe(ART);
    const written = mocks.insertValues[0]!;
    expect(written.bytes).toBe(20);
    expect(String(written.sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(written.blobKey)).toMatch(/^us\/\d{4}\/\d{2}\//);
  });

  it.each([
    ['report.pdf', 'application/pdf'],
    ['data.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['unknown.bin', 'application/octet-stream'],
  ])('stores %s with an appropriate MIME type and no preview when the content is real binary', async (name, contentType) => {
    mocks.insertRows.push([row()]);
    // Real binary bytes (PDF magic + invalid UTF-8 tail), not text wearing a
    // binary name — previews are gated on CONTENT now, not the type label.
    const binary = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0xff, 0xfe, 0x00, 0x01]);
    await createArtifact({
      orgId: ORG, runId: RUN, kind: 'output', name, contentType: 'application/octet-stream',
      body: Readable.from([binary]), maxBytes: 1024,
      createdByTool: 'workspace_collect', region: 'us',
    });
    expect(mocks.insertValues[0]).toMatchObject({ contentType, headPreview: '', tailPreview: '' });
  });

  it('promotes an application/octet-stream artifact to text/plain when its content is UTF-8 text with a preview', async () => {
    mocks.insertRows.push([row()]);
    await createArtifact({
      orgId: ORG, runId: RUN, kind: 'output', name: 'findings', contentType: 'application/octet-stream',
      body: Buffer.from('alpha finding: high risk'), maxBytes: 1024,
      createdByTool: 'workspace_collect', region: 'us',
    });
    // Promoted so isTextArtifactContentType (the render-time gate in toArtifactDto
    // and the web preview toggle) doesn't blank a preview we already know is safe,
    // printable text just because no known extension named it.
    expect(mocks.insertValues[0]).toMatchObject({
      contentType: 'text/plain', headPreview: 'alpha finding: high risk',
    });
  });

  it('gives no preview to an application/octet-stream artifact containing NUL bytes, and does not promote it', async () => {
    mocks.insertRows.push([row()]);
    await createArtifact({
      orgId: ORG, runId: RUN, kind: 'output', name: 'blob1', contentType: 'application/octet-stream',
      body: Buffer.from('lead-in\u0000trail'), maxBytes: 1024,
      createdByTool: 'workspace_collect', region: 'us',
    });
    expect(mocks.insertValues[0]).toMatchObject({
      contentType: 'application/octet-stream', headPreview: '', tailPreview: '',
    });
  });

  it('gives no preview to an application/octet-stream artifact with real binary (PDF magic) content', async () => {
    mocks.insertRows.push([row()]);
    await createArtifact({
      orgId: ORG, runId: RUN, kind: 'output', name: 'blob2', contentType: 'application/octet-stream',
      body: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0xff, 0xfe, 0x00, 0x01]),
      maxBytes: 1024, createdByTool: 'workspace_collect', region: 'us',
    });
    expect(mocks.insertValues[0]).toMatchObject({ headPreview: '', tailPreview: '' });
  });

  it('preserves previews for generic workspace CSV outputs', async () => {
    mocks.insertRows.push([row()]);
    await createArtifact({
      orgId: ORG, runId: RUN, kind: 'output', name: 'results.CSV', contentType: 'application/octet-stream',
      body: Buffer.from('name,total\nAlpha,60'), maxBytes: 1024,
      createdByTool: 'workspace_collect', region: 'us',
    });
    expect(mocks.insertValues[0]).toMatchObject({ contentType: 'text/csv', headPreview: 'name,total\nAlpha,60' });
  });

  it('compensates by deleting the blob when the row insert fails, and rethrows', async () => {
    mocks.insertError = Object.assign(new Error('insert boom'), { code: '23503' });
    await expect(createArtifact({
      orgId: ORG, runId: RUN, kind: 'output', name: 'out.txt', contentType: 'text/plain',
      body: Buffer.from('hello'), maxBytes: 1024, createdByTool: 'workspace_collect', region: 'eu',
    })).rejects.toThrow('insert boom');
    expect(mocks.calls).toEqual(['blob:put', 'row:insert', 'blob:delete']);
    expect(blobs.objects.size).toBe(0);
  });

  it('accepts a stream body and defaults expiry to 30 days', async () => {
    mocks.insertRows.push([row()]);
    await createArtifact({
      orgId: ORG, runId: null, kind: 'step_stdout', name: 'step-1.out',
      contentType: 'text/plain; charset=utf-8',
      body: Readable.from([Buffer.from('abc'), Buffer.from('def')]),
      maxBytes: 1024, createdByTool: 'workspace_run', region: 'us',
    });
    const written = mocks.insertValues[0]!;
    expect(written.bytes).toBe(6);
    const days = ((written.expiresAt as Date).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });
});

describe('resolveArtifact (spec §5.2 — null covers both not-found and forbidden)', () => {
  it('returns the record for the owning org', async () => {
    mocks.selectRows.push([row()]);
    expect((await resolveArtifact(ART, { orgId: ORG }))?.id).toBe(ART);
  });

  it('returns null — not a distinguishable error — when the row belongs to another org', async () => {
    mocks.selectRows.push([]); // the org predicate excluded it
    expect(await resolveArtifact(ART, { orgId: OTHER_ORG })).toBeNull();
  });

  it('returns null for a handle that is not a uuid, without querying', async () => {
    expect(await resolveArtifact('not-a-uuid', { orgId: ORG })).toBeNull();
    expect(mocks.calls).toEqual([]);
  });

  it('returns null when a runId scope is supplied and the row belongs to another run', async () => {
    mocks.selectRows.push([]);
    expect(await resolveArtifact(ART, { orgId: ORG, runId: '00000000-0000-4000-8000-0000000000ff' })).toBeNull();
  });
});

describe('deleteArtifact — blob first, then row (the row is the only key index)', () => {
  it('deletes in that order', async () => {
    const record = { ...row(), blobKey: 'us/2026/10/k1' } as unknown as ArtifactRecord;
    await deleteArtifact(record);
    expect(mocks.calls).toEqual(['blob:delete', 'row:delete']);
  });

  it('leaves the row in place when the blob delete throws, so the erasure is rerunnable', async () => {
    blobs.delete = async () => { mocks.calls.push('blob:delete'); throw new Error('bucket down'); };
    await expect(deleteArtifact(row() as unknown as ArtifactRecord)).rejects.toThrow('bucket down');
    expect(mocks.calls).toEqual(['blob:delete']);
  });
});

describe('listArtifactsForAuth / toArtifactDto', () => {
  it('suppresses previews already stored for binary artifacts', () => {
    const dto = toArtifactDto(row({ contentType: 'application/pdf', headPreview: '%PDF', tailPreview: 'binary' }) as ArtifactRecord);
    expect(dto.headPreview).toBe('');
    expect(dto.tailPreview).toBe('');
  });

  it('shows the preview for an octet-stream artifact that createArtifact promoted to text/plain', () => {
    const dto = toArtifactDto(row({
      contentType: 'text/plain', headPreview: 'alpha finding: high risk', tailPreview: 'high risk',
    }) as ArtifactRecord);
    expect(dto.headPreview).toBe('alpha finding: high risk');
    expect(dto.tailPreview).toBe('high risk');
  });

  it('keeps octet-stream and no preview for a genuinely binary artifact (never promoted)', () => {
    const dto = toArtifactDto(row({
      contentType: 'application/octet-stream', headPreview: '', tailPreview: '',
    }) as ArtifactRecord);
    expect(dto.contentType).toBe('application/octet-stream');
    expect(dto.headPreview).toBe('');
    expect(dto.tailPreview).toBe('');
  });

  it('never exposes blobKey and renders the download path', async () => {
    mocks.selectRows.push([row()]);
    const auth = { orgCondition: () => undefined } as never;
    const [dto] = (await listArtifactsForAuth(RUN, auth)).map(toArtifactDto);
    expect(dto).toBeDefined();
    expect(Object.keys(dto!)).not.toContain('blobKey');
    expect(dto!.downloadPath).toBe(`/api/v1/ai/artifacts/${ART}`);
    expect(dto!.expiresAt).toBe('2026-11-15T00:00:00.000Z');
  });
});

describe('readArtifactWindow (A-W05 D13a)', () => {
  const record = (bytes: number) => ({
    id: ART, orgId: ORG, runId: RUN, sessionId: null, kind: 'input_capture',
    name: 't.json', contentType: 'application/json', bytes, sha256: '',
    blobKey: 'k', headPreview: '', tailPreview: '', sourceDeviceId: null,
    createdByTool: 't', expiresAt: new Date(), createdAt: new Date(),
  }) as ArtifactRecord;

  it('never splits a multi-byte character and reports the byte offset actually consumed', async () => {
    // 'é' is 2 bytes; a 3-char window must stop before a partial 4th char.
    const body = Buffer.from('ab' + 'é'.repeat(10), 'utf8'); // 22 bytes
    setBlobStorageForTests(fakeRangeStore(body));
    const w = await readArtifactWindow(record(body.length), 0, 3);
    expect(w.text).toBe('abé');
    expect(w.nextOffset).toBe(4);
    expect(w.hasMore).toBe(true);
    const rest = await readArtifactWindow(record(body.length), w.nextOffset, 6000);
    expect(rest.text).toBe('é'.repeat(9));
    expect(rest.hasMore).toBe(false);
    expect(rest.nextOffset).toBe(22);
  });

  it('clamps maxChars to ARTIFACT_READ_MAX_CHARS and returns an empty window past the end', async () => {
    const body = Buffer.from('x'.repeat(10_000));
    setBlobStorageForTests(fakeRangeStore(body));
    expect((await readArtifactWindow(record(10_000), 0, 99_999)).text).toHaveLength(ARTIFACT_READ_MAX_CHARS);
    expect(await readArtifactWindow(record(10_000), 10_000, 10)).toEqual({ text: '', nextOffset: 10_000, hasMore: false });
  });

  it('reads from a non-zero offset', async () => {
    const body = Buffer.from('0123456789');
    setBlobStorageForTests(fakeRangeStore(body));
    const w = await readArtifactWindow(record(body.length), 4, 3);
    expect(w.text).toBe('456');
    expect(w.nextOffset).toBe(7);
    expect(w.hasMore).toBe(true);
  });
});

describe('findArtifactForCaller (A-W05 D13a/Q4) — input validation short-circuits before any query', () => {
  it('returns null without querying for a non-uuid handle', async () => {
    expect(await findArtifactForCaller('not-a-uuid', { orgId: ORG, runId: RUN })).toBeNull();
    expect(mocks.calls).toEqual([]);
  });

  it('returns null without querying for a non-uuid orgId', async () => {
    expect(await findArtifactForCaller(ART, { orgId: 'not-a-uuid', runId: RUN })).toBeNull();
    expect(mocks.calls).toEqual([]);
  });

  it('returns null without querying when the anchor carries neither a run nor a session — "no anchor" is never "any artifact of this org"', async () => {
    expect(await findArtifactForCaller(ART, { orgId: ORG })).toBeNull();
    expect(mocks.calls).toEqual([]);
  });

  it('returns the record when the anchor matches (run-anchored)', async () => {
    mocks.selectRows.push([row({ runId: RUN, sessionId: null })]);
    expect((await findArtifactForCaller(ART, { orgId: ORG, runId: RUN }))?.id).toBe(ART);
  });

  it('returns the record when the anchor matches (session-anchored, no run)', async () => {
    mocks.selectRows.push([row({ runId: null, sessionId: SESSION })]);
    expect((await findArtifactForCaller(ART, { orgId: ORG, sessionId: SESSION }))?.id).toBe(ART);
  });

  it('conceals a row the predicate excluded (cross-session, cross-run, expired, export_dataset, or pre-cutoff) as a plain null — never a distinguishable "forbidden"', async () => {
    mocks.selectRows.push([]);
    expect(await findArtifactForCaller(ART, { orgId: ORG, sessionId: SESSION })).toBeNull();
  });
});
