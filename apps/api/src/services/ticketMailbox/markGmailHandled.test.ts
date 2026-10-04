import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { gmail_v1 } from '@googleapis/gmail';
import { markGmailHandled, resetHandledLabelCache, assertUsableHandledLabelName } from './googleMailboxClient';
import { gmailHandledConfig } from './gmailHandledConfig';

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

describe('gmailHandledConfig', () => {
  it('is OFF when GMAIL_HANDLED_LABEL is unset or blank (connector stays read-only)', () => {
    expect(gmailHandledConfig({}).enabled).toBe(false);
    expect(gmailHandledConfig({ GMAIL_HANDLED_LABEL: '   ' }).enabled).toBe(false);
  });
  it('is ON with archive by default when a label is set; archive can be turned off', () => {
    expect(gmailHandledConfig({ GMAIL_HANDLED_LABEL: 'Breeze' })).toMatchObject({ enabled: true, labelName: 'Breeze', archive: true });
    expect(gmailHandledConfig({ GMAIL_HANDLED_LABEL: 'Breeze', GMAIL_ARCHIVE_ON_HANDLE: 'false' }).archive).toBe(false);
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

  it('refuses a reserved system label name and a same-named system label', async () => {
    expect(() => assertUsableHandledLabelName('TRASH')).toThrow(/system label/);
    expect(() => assertUsableHandledLabelName('CATEGORY_PROMOTIONS')).toThrow(/system label/);
    const f = fakeGmail({ labels: [{ id: 'SYS', name: 'Handled', type: 'system' }] });
    await expect(markGmailHandled(f.gmail, MB, 'm4', opts())).rejects.toThrow(/system label/);
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
