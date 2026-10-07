import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { gmail_v1 } from '@googleapis/gmail';
import { markGmailHandled, resetHandledLabelCache, assertUsableHandledLabelName, handledLabelCacheSize } from './googleMailboxClient';
import { HandledLabelError, isUsableHandledLabelName } from './handledLabel';
import { handledErrorCode } from './markIngestedGmailHandled';

type Label = { id: string; name: string; type?: string };

function fakeGmail(opts: { labels?: Label[]; createId?: string; createThrows?: unknown; modifyThrowsOnce?: unknown; modifyThrows?: unknown }) {
  let labels = opts.labels ?? [];
  const list = vi.fn(async () => ({ data: { labels } }));
  const create = vi.fn(async () => {
    if (opts.createThrows) throw opts.createThrows;
    return { data: { id: opts.createId } };
  });
  let thrownOnce = false;
  const modify = vi.fn(async (..._args: unknown[]) => {
    if (opts.modifyThrows) throw opts.modifyThrows;
    if (opts.modifyThrowsOnce && !thrownOnce) { thrownOnce = true; throw opts.modifyThrowsOnce; }
    return { data: {} };
  });
  const gmail = { users: { labels: { list, create }, messages: { modify } } } as unknown as gmail_v1.Gmail;
  return { gmail, list, create, modify, setLabels: (l: Label[]) => { labels = l; } };
}

const MB = 'support@example.com';
const opts = (o: Partial<{ accountSub: string; labelName: string; archive: boolean; labelCacheTtlMs: number }> = {}) =>
  ({ accountSub: 'sub-A', labelName: 'Handled', archive: true, labelCacheTtlMs: 600_000, ...o });

describe('isUsableHandledLabelName', () => {
  it('accepts ordinary and nested user label names', () => {
    expect(isUsableHandledLabelName('Breeze')).toBe(true);
    expect(isUsableHandledLabelName('Breeze/Ticketed')).toBe(true);
    expect(isUsableHandledLabelName('x'.repeat(100))).toBe(true);
  });
  it('counts length in characters (code points), as the DB char_length CHECK does', () => {
    // Each emoji is one character but two UTF-16 units.
    expect(isUsableHandledLabelName('\u{1F600}'.repeat(60))).toBe(true);
    expect(isUsableHandledLabelName('\u{1F600}'.repeat(100))).toBe(true);
    expect(isUsableHandledLabelName('\u{1F600}'.repeat(101))).toBe(false);
  });
  it('refuses blank, padded, over-long and system label names (any case)', () => {
    for (const bad of ['', '   ', ' Breeze', 'x'.repeat(101), 'INBOX', 'inbox', 'Trash', 'SPAM', 'category_updates']) {
      expect(isUsableHandledLabelName(bad), bad).toBe(false);
    }
  });
});

describe('handledErrorCode', () => {
  it('maps marking failures to the fixed codes stored on the connection', () => {
    expect(handledErrorCode(Object.assign(new Error('x'), { status: 403 }))).toBe('access_denied');
    expect(handledErrorCode(Object.assign(new Error('x'), { status: 401 }))).toBe('access_denied');
    expect(handledErrorCode(Object.assign(new Error('x'), { status: 429 }))).toBe('rate_limited');
    expect(handledErrorCode(Object.assign(new Error('x'), { status: 503 }))).toBe('unavailable');
    expect(handledErrorCode(new Error('socket hang up'))).toBe('unavailable');
    expect(handledErrorCode(Object.assign(new Error('x'), { status: 400 }))).toBe('failed');
    expect(handledErrorCode(new HandledLabelError('system label'))).toBe('label_invalid');
  });
});

describe('markGmailHandled', () => {
  beforeEach(() => resetHandledLabelCache());

  it('uses an existing user label and archives (removes INBOX) by default', async () => {
    const f = fakeGmail({ labels: [{ id: 'L1', name: 'Handled', type: 'user' }] });
    await markGmailHandled(f.gmail, MB, 'm1', opts());
    expect(f.create).not.toHaveBeenCalled();
    expect(f.modify).toHaveBeenCalledWith({ userId: 'me', id: 'm1', requestBody: { addLabelIds: ['L1'], removeLabelIds: ['INBOX'] } });
  });

  it('label-only mode does not remove INBOX', async () => {
    const f = fakeGmail({ labels: [{ id: 'L1', name: 'Handled', type: 'user' }] });
    await markGmailHandled(f.gmail, MB, 'm1', opts({ archive: false }));
    expect(f.modify).toHaveBeenCalledWith({ userId: 'me', id: 'm1', requestBody: { addLabelIds: ['L1'], removeLabelIds: [] } });
  });

  it('creates the label when missing, then applies it', async () => {
    const f = fakeGmail({ labels: [], createId: 'Lnew' });
    await markGmailHandled(f.gmail, MB, 'm2', opts());
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.modify.mock.calls[0]![0]).toMatchObject({ requestBody: { addLabelIds: ['Lnew'] } });
  });

  it('recovers from a concurrent-create 409 by re-listing', async () => {
    const f = fakeGmail({ labels: [], createThrows: Object.assign(new Error('exists'), { response: { status: 409 } }) });
    f.list.mockResolvedValueOnce({ data: { labels: [] } }).mockResolvedValueOnce({ data: { labels: [{ id: 'Lrace', name: 'Handled', type: 'user' }] } });
    await markGmailHandled(f.gmail, MB, 'm3', opts());
    expect(f.modify.mock.calls[0]![0]).toMatchObject({ requestBody: { addLabelIds: ['Lrace'] } });
  });

  it('never reuses a cached label id after the mailbox address moves to another Google account', async () => {
    const a = fakeGmail({ labels: [{ id: 'LA', name: 'Handled', type: 'user' }] });
    await markGmailHandled(a.gmail, MB, 'm1', opts({ accountSub: 'sub-A' }));
    const b = fakeGmail({ labels: [{ id: 'LB', name: 'Handled', type: 'user' }] });
    await markGmailHandled(b.gmail, MB, 'm2', opts({ accountSub: 'sub-B' }));
    expect(b.list).toHaveBeenCalledTimes(1);
    expect(b.modify.mock.calls[0]![0]).toMatchObject({ requestBody: { addLabelIds: ['LB'] } });
  });

  it('caches the label id within the TTL and re-resolves with TTL=0', async () => {
    const f = fakeGmail({ labels: [{ id: 'L1', name: 'Handled', type: 'user' }] });
    await markGmailHandled(f.gmail, MB, 'a', opts());
    await markGmailHandled(f.gmail, MB, 'b', opts());
    expect(f.list).toHaveBeenCalledTimes(1);
    resetHandledLabelCache();
    await markGmailHandled(f.gmail, MB, 'c', opts({ labelCacheTtlMs: 0 }));
    await markGmailHandled(f.gmail, MB, 'd', opts({ labelCacheTtlMs: 0 }));
    expect(f.list).toHaveBeenCalledTimes(3);
  });

  it('bounds the label cache: past its size limit the oldest entry is evicted and re-resolved', async () => {
    const CAP = 1_000;
    const labels = Array.from({ length: CAP + 1 }, (_, i) => ({ id: `id-${i}`, name: `L${i}`, type: 'user' }));
    const g = fakeGmail({ labels });
    for (let i = 0; i <= CAP; i++) await markGmailHandled(g.gmail, MB, `m${i}`, opts({ labelName: `L${i}` }));
    expect(g.list).toHaveBeenCalledTimes(CAP + 1);
    // L0 was the oldest and was evicted when L1000 went in; L1000 is still cached.
    await markGmailHandled(g.gmail, MB, 'again-0', opts({ labelName: 'L0' }));
    expect(g.list).toHaveBeenCalledTimes(CAP + 2);
    await markGmailHandled(g.gmail, MB, 'again-1000', opts({ labelName: `L${CAP}` }));
    expect(g.list).toHaveBeenCalledTimes(CAP + 2);
  });

  it('drops expired label cache entries instead of keeping them', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const labels = Array.from({ length: 1_000 }, (_, i) => ({ id: `id-${i}`, name: `L${i}`, type: 'user' }));
      const g = fakeGmail({ labels: [...labels, { id: 'id-new', name: 'New', type: 'user' }] });
      for (let i = 0; i < 1_000; i++) await markGmailHandled(g.gmail, MB, `m${i}`, opts({ labelName: `L${i}`, labelCacheTtlMs: 60_000 }));
      expect(handledLabelCacheSize()).toBe(1_000);
      // A lookup of an expired entry removes it.
      vi.setSystemTime(new Date('2026-01-01T00:02:00Z'));
      await markGmailHandled(g.gmail, MB, 'x', opts({ labelName: 'L5', labelCacheTtlMs: 60_000 }));
      expect(handledLabelCacheSize()).toBe(1_000);
      // At the bound, inserting sweeps every expired entry first.
      await markGmailHandled(g.gmail, MB, 'y', opts({ labelName: 'New', labelCacheTtlMs: 60_000 }));
      expect(handledLabelCacheSize()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a reserved system label name and a same-named system label', async () => {
    expect(() => assertUsableHandledLabelName('TRASH')).toThrow(HandledLabelError);
    expect(() => assertUsableHandledLabelName('CATEGORY_PROMOTIONS')).toThrow(/system label/);
    const f = fakeGmail({ labels: [{ id: 'SYS', name: 'Handled', type: 'system' }] });
    // Typed, so the caller records label_invalid instead of retrying it as transient.
    await expect(markGmailHandled(f.gmail, MB, 'm4', opts())).rejects.toBeInstanceOf(HandledLabelError);
    expect(f.modify).not.toHaveBeenCalled();
  });

  it('self-heals a deleted/recreated label: a 404 on modify re-resolves and retries with the NEW id', async () => {
    const f = fakeGmail({ labels: [{ id: 'Lold', name: 'Handled', type: 'user' }], modifyThrowsOnce: Object.assign(new Error('gone'), { response: { status: 404 } }) });
    f.list
      .mockResolvedValueOnce({ data: { labels: [{ id: 'Lold', name: 'Handled', type: 'user' }] } })
      .mockResolvedValueOnce({ data: { labels: [{ id: 'Lnew', name: 'Handled', type: 'user' }] } });
    await expect(markGmailHandled(f.gmail, MB, 'm6', opts())).resolves.toBeUndefined();
    expect(f.modify).toHaveBeenCalledTimes(2);
    expect(f.modify.mock.calls[0]![0]).toMatchObject({ requestBody: { addLabelIds: ['Lold'] } });
    expect(f.modify.mock.calls[1]![0]).toMatchObject({ requestBody: { addLabelIds: ['Lnew'] } });
  });

  it('rethrows a non-label error (500) without retrying', async () => {
    const f = fakeGmail({ labels: [{ id: 'L1', name: 'Handled', type: 'user' }], modifyThrows: Object.assign(new Error('boom'), { response: { status: 500 } }) });
    await expect(markGmailHandled(f.gmail, MB, 'm5', opts())).rejects.toThrow('boom');
    expect(f.modify).toHaveBeenCalledTimes(1);
  });
});
