import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    selectRows: [] as unknown[][],
    selectLocks: [] as string[],
    inserts: [] as Array<Record<string, unknown>>,
    insertReturning: [] as unknown[][],
    createArtifact: vi.fn(),
    redactForCapture: vi.fn((raw: string) => raw.replace(/hunter2/g, '[REDACTED]')),
    assertWithinCeiling: vi.fn(),
    blobDelete: vi.fn(async (_key: string) => {}),
    systemDepth: 0,
  };
});

vi.mock('../../db', () => {
  const select = vi.fn(() => {
    h.calls.push('select');
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'where', 'orderBy', 'limit']) chain[m] = () => chain;
    chain.for = (mode: string) => { h.selectLocks.push(mode); h.calls.push(`lock:${mode}`); return chain; };
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(h.selectRows.shift() ?? []).then(res, rej);
    return chain;
  });
  const insert = vi.fn(() => ({
    values: (values: Record<string, unknown>) => {
      h.calls.push('insert');
      h.inserts.push(values);
      return { returning: async () => h.insertReturning.shift() ?? [] };
    },
  }));
  return {
    db: { select, insert },
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    getCurrentDbAccessContext: vi.fn(() => (h.systemDepth > 0 ? { scope: 'system' } : undefined)),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
      h.calls.push('tx');
      h.systemDepth++;
      try { return await fn(); } finally { h.systemDepth--; }
    }),
  };
});

vi.mock('../artifacts/artifactService', async (importActual) => {
  const actual = await importActual<typeof import('../artifacts/artifactService')>();
  return { ...actual, createArtifact: (...a: unknown[]) => { h.calls.push('createArtifact'); return h.createArtifact(...a); } };
});
vi.mock('../artifacts/captureRedaction', () => ({
  redactForCapture: (raw: string) => { h.calls.push('redact'); return h.redactForCapture(raw); },
}));
vi.mock('../artifacts/blobStorage', async (importActual) => {
  const actual = await importActual<typeof import('../artifacts/blobStorage')>();
  return { ...actual, getBlobStorage: () => ({ delete: h.blobDelete }) };
});
vi.mock('./grantAuthority', async (importActual) => {
  const actual = await importActual<typeof import('./grantAuthority')>();
  return { ...actual, assertWithinCeiling: (...a: unknown[]) => { h.calls.push('ceiling'); return h.assertWithinCeiling(...a); } };
});

import { BlobStorageUnavailableError, BlobTooLargeError } from '../artifacts/blobStorage';
import { CeilingViolationError, type GrantCeiling } from './grantAuthority';
import type { WispThread } from './threads';
import {
  THREAD_ATTACHMENT_MAX_BYTES,
  THREAD_ATTACHMENT_MESSAGES,
  THREAD_ATTACHMENT_MAX_PER_THREAD,
  ThreadAttachmentError,
  addThreadAttachment,
  attachmentSeedLines,
  classifyAttachmentBytes,
  listThreadAttachments,
  type ThreadAttachment,
} from './threadAttachments';

const P1 = '11111111-1111-4111-8111-111111111111';
const G1 = '22222222-2222-4222-8222-222222222222';
const T1 = '33333333-3333-4333-8333-333333333333';
const O1 = '44444444-4444-4444-8444-444444444444';
const U1 = '55555555-5555-4555-8555-555555555555';
const A1 = '66666666-6666-4666-8666-666666666666';
const AT1 = '77777777-7777-4777-8777-777777777777';

const thread: WispThread = {
  id: T1, grantId: G1, partnerId: P1, summary: '', summaryUpdatedAt: null, lastSessionId: null,
  focusOrgId: O1, createdAt: new Date(), updatedAt: new Date(),
};

const ceiling = { grantId: G1, partnerId: P1, status: 'active' } as unknown as GrantCeiling;

const EXPIRES = new Date('2027-02-01T00:00:00Z');
const CREATED = new Date('2027-01-02T00:00:00Z');

function artifactRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: A1, orgId: O1, runId: null, sessionId: null, kind: 'input_capture', name: 'notes.redacted.txt',
    contentType: 'text/plain', bytes: 17, sha256: 'a'.repeat(64), blobKey: 'us/2027/01/k', headPreview: '',
    tailPreview: '', sourceDeviceId: null, createdByTool: 'wisp_thread_attachment', expiresAt: EXPIRES, createdAt: CREATED,
    ...overrides,
  };
}

beforeEach(() => {
  h.calls.length = 0;
  h.selectRows.length = 0;
  h.selectLocks.length = 0;
  h.inserts.length = 0;
  h.insertReturning.length = 0;
  h.systemDepth = 0;
  h.createArtifact.mockReset();
  h.assertWithinCeiling.mockReset();
  h.blobDelete.mockClear();
});

function primeHappyPath(liveCount = 0) {
  h.selectRows.push([{ id: T1 }]);          // SELECT … FOR UPDATE on the thread
  h.selectRows.push([{ n: liveCount }]);    // live attachment count
  h.createArtifact.mockResolvedValue(artifactRecord());
  h.insertReturning.push([{
    id: AT1, threadId: T1, orgId: O1, artifactId: A1, label: 'notes.txt', addedByUserId: U1, createdAt: CREATED,
  }]);
}

describe('addThreadAttachment', () => {
  it('addThreadAttachment redacts before createArtifact, names the artifact *.redacted.<ext>, passes maxBytes 5 MiB and createdByTool wisp_thread_attachment', async () => {
    primeHappyPath();
    const out = await addThreadAttachment({
      thread, ceiling, orgId: O1, label: 'notes.txt', text: 'password=hunter2 ok', addedByUserId: U1,
    });

    expect(h.assertWithinCeiling).toHaveBeenCalledWith(ceiling, { orgId: O1 });
    expect(h.calls.indexOf('redact')).toBeLessThan(h.calls.indexOf('createArtifact'));
    // Thread row locked and count read inside the same system transaction, before the artifact write.
    expect(h.selectLocks).toEqual(['update']);
    expect(h.calls.indexOf('tx')).toBeLessThan(h.calls.indexOf('lock:update'));
    expect(h.calls.indexOf('lock:update')).toBeLessThan(h.calls.indexOf('createArtifact'));
    expect(h.calls.indexOf('createArtifact')).toBeLessThan(h.calls.indexOf('insert'));

    const arg = h.createArtifact.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).toMatchObject({
      orgId: O1, runId: null, sessionId: null, kind: 'input_capture', name: 'notes.redacted.txt',
      contentType: 'text/plain', maxBytes: THREAD_ATTACHMENT_MAX_BYTES, createdByTool: 'wisp_thread_attachment',
    });
    expect(THREAD_ATTACHMENT_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(['us', 'eu']).toContain(arg.region);
    expect((arg.body as Buffer).toString('utf8')).toBe('password=[REDACTED] ok');
    expect((arg.body as Buffer).toString('utf8')).not.toContain('hunter2');

    expect(h.inserts[0]).toEqual({
      threadId: T1, partnerId: P1, orgId: O1, artifactId: A1, addedByUserId: U1, label: 'notes.txt',
    });
    expect(out).toEqual({
      id: AT1, threadId: T1, orgId: O1, artifactId: A1, label: 'notes.txt', addedByUserId: U1,
      contentType: 'text/plain', bytes: 17, expiresAt: EXPIRES, createdAt: CREATED,
    });
  });

  it('names a CSV upload *.redacted.csv with text/csv and keeps the redacted marker inside the 200-char name cap', async () => {
    primeHappyPath();
    await addThreadAttachment({ thread, ceiling, orgId: O1, label: 'export.csv', text: 'a,b\n1,2', addedByUserId: U1 });
    expect(h.createArtifact.mock.calls[0]![0]).toMatchObject({ name: 'export.redacted.csv', contentType: 'text/csv' });

    primeHappyPath();
    await addThreadAttachment({ thread, ceiling, orgId: O1, label: `${'x'.repeat(400)}.txt`, text: 'hello', addedByUserId: U1 });
    const name = (h.createArtifact.mock.calls[1]![0] as { name: string }).name;
    expect(name.length).toBeLessThanOrEqual(200);
    expect(name.endsWith('.redacted.txt')).toBe(true);
  });

  it('refuses the 21st attachment with too_many without calling createArtifact', async () => {
    expect(THREAD_ATTACHMENT_MAX_PER_THREAD).toBe(20);
    h.selectRows.push([{ id: T1 }]);
    h.selectRows.push([{ n: 20 }]);
    const err = await addThreadAttachment({ thread, ceiling, orgId: O1, label: 'n.txt', text: 'hi', addedByUserId: U1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ThreadAttachmentError);
    expect((err as ThreadAttachmentError).code).toBe('too_many');
    expect(h.createArtifact).not.toHaveBeenCalled();
    expect(h.inserts).toHaveLength(0);
  });

  it('refuses an org outside the ceiling (org_outside_ceiling) before any write', async () => {
    h.assertWithinCeiling.mockImplementation(() => { throw new CeilingViolationError('org', 'outside'); });
    const err = await addThreadAttachment({ thread, ceiling, orgId: O1, label: 'n.txt', text: 'hi', addedByUserId: U1 })
      .catch((e: unknown) => e);
    expect((err as ThreadAttachmentError).code).toBe('org_outside_ceiling');
    expect(h.calls).toEqual(['ceiling']);
    expect(h.createArtifact).not.toHaveBeenCalled();
  });

  it.each(['site', 'permission', 'tool'] as const)(
    'maps a %s ceiling violation to outside_ceiling (not org_outside_ceiling) before any write',
    async (code) => {
      h.assertWithinCeiling.mockImplementation(() => { throw new CeilingViolationError(code, `internal ${code} detail`); });
      const err = await addThreadAttachment({ thread, ceiling, orgId: O1, label: 'n.txt', text: 'hi', addedByUserId: U1 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ThreadAttachmentError);
      expect((err as ThreadAttachmentError).code).toBe('outside_ceiling');
      expect(h.createArtifact).not.toHaveBeenCalled();
    },
  );

  it('every ThreadAttachmentError code has fixed user-facing copy with no ids in it', () => {
    for (const [code, copy] of Object.entries(THREAD_ATTACHMENT_MESSAGES)) {
      expect(copy, code).toMatch(/^[A-Z]/);
      expect(copy, code).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    }
    expect(Object.keys(THREAD_ATTACHMENT_MESSAGES).sort()).toEqual(
      ['empty', 'org_outside_ceiling', 'outside_ceiling', 'store_unavailable', 'too_large', 'too_many', 'unsupported_type'],
    );
  });

  it("refuses a thread from another partner than the ceiling's (org_outside_ceiling) before any write", async () => {
    const err = await addThreadAttachment({
      thread: { ...thread, partnerId: '88888888-8888-4888-8888-888888888888' },
      ceiling, orgId: O1, label: 'n.txt', text: 'hi', addedByUserId: U1,
    }).catch((e: unknown) => e);
    expect((err as ThreadAttachmentError).code).toBe('org_outside_ceiling');
    expect(h.calls).toEqual(['ceiling']);
  });

  it('maps BlobTooLargeError → too_large and BlobStorageUnavailableError → store_unavailable', async () => {
    h.selectRows.push([{ id: T1 }], [{ n: 0 }]);
    h.createArtifact.mockRejectedValueOnce(new BlobTooLargeError(THREAD_ATTACHMENT_MAX_BYTES));
    const tooLarge = await addThreadAttachment({ thread, ceiling, orgId: O1, label: 'n.txt', text: 'hi', addedByUserId: U1 })
      .catch((e: unknown) => e);
    expect((tooLarge as ThreadAttachmentError).code).toBe('too_large');

    h.selectRows.push([{ id: T1 }], [{ n: 0 }]);
    h.createArtifact.mockRejectedValueOnce(new BlobStorageUnavailableError('down'));
    const down = await addThreadAttachment({ thread, ceiling, orgId: O1, label: 'n.txt', text: 'hi', addedByUserId: U1 })
      .catch((e: unknown) => e);
    expect((down as ThreadAttachmentError).code).toBe('store_unavailable');
    expect(h.inserts).toHaveLength(0);
  });

  it('deletes the stored blob when the transaction fails after createArtifact (the artifact row rolled back with it)', async () => {
    h.selectRows.push([{ id: T1 }], [{ n: 0 }]);
    h.createArtifact.mockResolvedValue(artifactRecord());
    h.insertReturning.push([]); // attachment insert returned nothing → throws inside the txn
    await expect(addThreadAttachment({ thread, ceiling, orgId: O1, label: 'n.txt', text: 'hi', addedByUserId: U1 }))
      .rejects.toThrow();
    expect(h.blobDelete).toHaveBeenCalledWith('us/2027/01/k');
  });

  it('refuses empty / whitespace text and NUL bytes before any write', async () => {
    const empty = await addThreadAttachment({ thread, ceiling, orgId: O1, label: 'n.txt', text: '  \n ', addedByUserId: U1 })
      .catch((e: unknown) => e);
    expect((empty as ThreadAttachmentError).code).toBe('empty');
    const nul = await addThreadAttachment({ thread, ceiling, orgId: O1, label: 'n.txt', text: 'a\u0000b', addedByUserId: U1 })
      .catch((e: unknown) => e);
    expect((nul as ThreadAttachmentError).code).toBe('unsupported_type');
    expect(h.calls.filter((c) => c !== 'ceiling')).toEqual([]);
  });
});

describe('listThreadAttachments', () => {
  it('maps joined rows to ThreadAttachment', async () => {
    h.selectRows.push([{
      id: AT1, threadId: T1, orgId: O1, artifactId: A1, label: 'notes', addedByUserId: U1,
      contentType: 'text/plain', bytes: 5, expiresAt: EXPIRES, createdAt: CREATED,
    }]);
    const rows = await listThreadAttachments(T1);
    expect(rows).toEqual([{
      id: AT1, threadId: T1, orgId: O1, artifactId: A1, label: 'notes', addedByUserId: U1,
      contentType: 'text/plain', bytes: 5, expiresAt: EXPIRES, createdAt: CREATED,
    }]);
  });
});

describe('attachmentSeedLines', () => {
  it('attachmentSeedLines renders one line per item with the handle and "" for none', () => {
    expect(attachmentSeedLines([])).toBe('');
    const items: ThreadAttachment[] = [
      { id: AT1, threadId: T1, orgId: O1, artifactId: A1, label: 'notes', addedByUserId: U1, contentType: 'text/plain', bytes: 5, expiresAt: EXPIRES, createdAt: CREATED },
      { id: 'x', threadId: T1, orgId: O1, artifactId: 'b2', label: 'export.csv', addedByUserId: null, contentType: 'text/csv', bytes: 1024, expiresAt: EXPIRES, createdAt: CREATED },
    ];
    expect(attachmentSeedLines(items)).toBe(
      `- notes — handle ${A1} (5 B, text/plain)\n- export.csv — handle b2 (1024 B, text/csv)`,
    );
  });
});

describe('classifyAttachmentBytes', () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it('accepts UTF-8 text and picks the content type by extension (JSON only when it parses)', () => {
    expect(classifyAttachmentBytes(enc('hello'), 'a.log')).toEqual({ ok: true, text: 'hello', contentType: 'text/plain', ext: 'txt' });
    expect(classifyAttachmentBytes(enc('a,b'), 'A.CSV')).toMatchObject({ ok: true, contentType: 'text/csv', ext: 'csv' });
    expect(classifyAttachmentBytes(enc('a\tb'), 'x.tsv')).toMatchObject({ ok: true, contentType: 'text/tab-separated-values', ext: 'tsv' });
    expect(classifyAttachmentBytes(enc('Subject: hi\r\n\r\nbody'), 'm.eml')).toMatchObject({ ok: true, contentType: 'message/rfc822', ext: 'eml' });
    expect(classifyAttachmentBytes(enc('{"a":1}'), 'x.json')).toMatchObject({ ok: true, contentType: 'application/json', ext: 'json' });
    expect(classifyAttachmentBytes(enc('{nope'), 'x.json')).toMatchObject({ ok: true, contentType: 'text/plain', ext: 'txt' });
    expect(classifyAttachmentBytes(enc('plain'))).toMatchObject({ ok: true, contentType: 'text/plain', ext: 'txt' });
  });

  it('refuses NUL bytes and invalid UTF-8 as unsupported_type, whatever the filename says', () => {
    expect(classifyAttachmentBytes(new Uint8Array([0x68, 0x00, 0x69]), 'a.txt')).toEqual({ ok: false, code: 'unsupported_type' });
    expect(classifyAttachmentBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]), 'a.txt')).toEqual({ ok: false, code: 'unsupported_type' });
  });

  it('refuses > 5 MiB as too_large and empty / whitespace-only as empty', () => {
    expect(classifyAttachmentBytes(new Uint8Array(THREAD_ATTACHMENT_MAX_BYTES + 1).fill(0x61))).toEqual({ ok: false, code: 'too_large' });
    expect(classifyAttachmentBytes(new Uint8Array(THREAD_ATTACHMENT_MAX_BYTES).fill(0x61))).toMatchObject({ ok: true });
    expect(classifyAttachmentBytes(new Uint8Array(0))).toEqual({ ok: false, code: 'empty' });
    expect(classifyAttachmentBytes(enc(' \n\t '))).toEqual({ ok: false, code: 'empty' });
  });
});
