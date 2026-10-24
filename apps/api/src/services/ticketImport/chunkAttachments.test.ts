/**
 * Reserve and store for one comment chunk (#8313 W1; spec
 * docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md
 * §4.3 steps 1–2): with the database and the store step faked, what is
 * reserved (and in how many transactions), what is skipped and why, which
 * reservations the chunk transaction deletes, and what each comment claims.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ outcomes: new Map<string, unknown>(), calls: [] as string[] }));
vi.mock('./storeAttachments', () => ({
  storeReservedAttachment: vi.fn(async (input: { id: string; sourceId: string }) => {
    store.calls.push(input.sourceId);
    const outcome = store.outcomes.get(input.sourceId);
    if (outcome instanceof Error) throw outcome;
    return outcome ?? { kind: 'stored', claim: { id: input.id, contentType: 'image/png', byteSize: 10, sha256: 'f'.repeat(64) } };
  }),
}));
vi.mock('../../db', () => ({ db: {} }));
vi.mock('../ticketAttachmentStorage', () => ({ objectKeyFor: (id: string) => `ticket-attachments/${id}`, putBytes: vi.fn() }));

import { hasAttachments, prepareChunkAttachments, type ChunkAttachmentsInput } from './chunkAttachments';
import type { ImportedComment } from './importedTicket';

const T0 = new Date('2021-03-04T09:00:00.000Z');

function comment(sourceId: string, attachments: ImportedComment['attachments']): ImportedComment {
  return { sourceId, createdAt: T0, isPublic: true, author: { kind: 'requester', name: 'Maya' }, content: 'x', ...(attachments ? { attachments } : {}) };
}
const file = (sourceId: string, filename: string, declaredBytes?: number) => ({ sourceId, filename, inline: false, ...(declaredBytes !== undefined ? { declaredBytes } : {}) });

function harness(chunk: ImportedComment[], states: Record<string, 'pending' | 'attached'> = {}, attachedUnderLock: string[] = []) {
  const reserveCalls: string[][] = [];
  const input: ChunkAttachmentsInput = {
    chunk,
    readStates: vi.fn(async () => new Map(Object.entries(states))),
    reserve: vi.fn(async (files) => {
      reserveCalls.push(files.map((f) => f.sourceId));
      return { merged: null, reserved: files.filter((f) => !attachedUnderLock.includes(f.sourceId)).map((f) => ({ id: `id-${f.sourceId}`, sourceId: f.sourceId })) };
    }),
    fetchAttachment: vi.fn(),
    chargeBytes: vi.fn(),
  };
  return { input, reserveCalls };
}

beforeEach(() => {
  store.outcomes.clear();
  store.calls.length = 0;
});

describe('prepareChunkAttachments', () => {
  it('a chunk with no files touches nothing', async () => {
    const { input } = harness([comment('c1', undefined), comment('c2', [])]);
    expect(hasAttachments(input.chunk)).toBe(false);
    const out = await prepareChunkAttachments(input);
    expect(out).toMatchObject({ merged: null, files: { skippedReservations: [] } });
    expect(input.readStates).not.toHaveBeenCalled();
    expect(input.reserve).not.toHaveBeenCalled();
  });

  it('skips a declared-oversize, empty or denylisted file before reserving it, and never reserves it', async () => {
    const { input, reserveCalls } = harness([comment('c1', [
      file('big', 'video.mp4', 11 * 1024 * 1024),
      file('zero', 'empty.txt', 0),
      file('exe', 'invoice.pdf.exe', 100),
      file('ok', 'photo.png', 100),
    ])]);
    const out = await prepareChunkAttachments(input);
    expect(reserveCalls).toEqual([['ok']]);
    expect(store.calls).toEqual(['ok']);
    if (out.merged) throw new Error('unexpected merge');
    const files = out.files.byComment.get('c1')!;
    expect(files.skips).toEqual([
      { sourceId: 'big', filename: 'video.mp4', reason: 'too_large' },
      { sourceId: 'zero', filename: 'empty.txt', reason: 'empty' },
      { sourceId: 'exe', filename: 'invoice.pdf.exe', reason: 'blocked_type' },
    ]);
    expect(files.claims.map((c) => c.id)).toEqual(['id-ok']);
    expect(out.files.skippedReservations).toEqual([]);
  });

  it('neither reserves nor stores a file this principal already attached; a pending one is reserved again (reused)', async () => {
    const { input, reserveCalls } = harness([comment('c1', [file('done', 'a.png', 10), file('half', 'b.png', 10), file('new', 'c.png', 10)])], {
      done: 'attached',
      half: 'pending',
    });
    const out = await prepareChunkAttachments(input);
    expect(input.readStates).toHaveBeenCalledWith(['done', 'half', 'new']);
    expect(reserveCalls).toEqual([['half', 'new']]);
    expect(store.calls).toEqual(['half', 'new']);
    if (out.merged) throw new Error('unexpected merge');
    expect(out.files.byComment.get('c1')).toEqual({ claims: [expect.objectContaining({ id: 'id-half' }), expect.objectContaining({ id: 'id-new' })], skips: [] });
  });

  it('a file attached under the lock (not returned by the reservation) is neither stored, claimed nor skipped', async () => {
    const { input } = harness([comment('c1', [file('raced', 'a.png', 10), file('mine', 'b.png', 10)])], {}, ['raced']);
    const out = await prepareChunkAttachments(input);
    expect(store.calls).toEqual(['mine']);
    if (out.merged) throw new Error('unexpected merge');
    expect(out.files.byComment.get('c1')).toEqual({ claims: [expect.objectContaining({ id: 'id-mine' })], skips: [] });
  });

  it('reserves at most 100 files per transaction, across comments', async () => {
    const chunk = [
      comment('c1', Array.from({ length: 150 }, (_, i) => file(`a${i}`, `a${i}.png`, 10))),
      comment('c2', Array.from({ length: 55 }, (_, i) => file(`b${i}`, `b${i}.png`, 10))),
    ];
    const { input, reserveCalls } = harness(chunk);
    await prepareChunkAttachments(input);
    expect(reserveCalls.map((c) => c.length)).toEqual([100, 100, 5]);
  });

  it('a permanent failure after the reservation is a skip whose reservation the chunk transaction deletes', async () => {
    store.outcomes.set('gone', { kind: 'skipped', reason: 'not_found' });
    store.outcomes.set('exe', { kind: 'skipped', reason: 'blocked_type' });
    const { input } = harness([comment('c1', [file('gone', 'lost.pdf', 10), file('ok', 'a.png', 10)]), comment('c2', [file('exe', 'tool.bin', 10)])]);
    const out = await prepareChunkAttachments(input);
    if (out.merged) throw new Error('unexpected merge');
    expect(out.files.skippedReservations).toEqual(['id-gone', 'id-exe']);
    expect(out.files.byComment.get('c1')).toEqual({
      claims: [expect.objectContaining({ id: 'id-ok' })],
      skips: [{ sourceId: 'gone', filename: 'lost.pdf', reason: 'not_found' }],
    });
    expect(out.files.byComment.get('c2')).toEqual({ claims: [], skips: [{ sourceId: 'exe', filename: 'tool.bin', reason: 'blocked_type' }] });
  });

  it('a transient failure propagates: nothing more is stored, and the reservations stay', async () => {
    store.outcomes.set('flaky', Object.assign(new Error('503'), { code: 'TICKET_IMPORT_ATTACHMENT_UNAVAILABLE' }));
    const { input } = harness([comment('c1', [file('flaky', 'a.png', 10), file('after', 'b.png', 10)])]);
    await expect(prepareChunkAttachments(input)).rejects.toMatchObject({ code: 'TICKET_IMPORT_ATTACHMENT_UNAVAILABLE' });
    expect(store.calls).toEqual(['flaky']);
  });

  it('a reservation that finds the ticket merged in Breeze stops before anything is stored', async () => {
    const { input } = harness([comment('c1', [file('a', 'a.png', 10)])]);
    input.reserve = vi.fn(async () => ({ merged: { mergedIntoTicketId: 'survivor' } }));
    expect(await prepareChunkAttachments(input)).toEqual({ merged: { mergedIntoTicketId: 'survivor' } });
    expect(store.calls).toEqual([]);
  });

  it('sanitizes the name before the denylist and the note', async () => {
    const { input } = harness([comment('c1', [file('p', 'C:\\temp\\"setup".EXE.', 10)])]);
    const out = await prepareChunkAttachments(input);
    if (out.merged) throw new Error('unexpected merge');
    expect(out.files.byComment.get('c1')!.skips).toEqual([{ sourceId: 'p', filename: 'setup.EXE.', reason: 'blocked_type' }]);
  });
});
