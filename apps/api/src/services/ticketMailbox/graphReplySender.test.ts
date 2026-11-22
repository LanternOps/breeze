import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('./mailboxToken', () => ({ getMailboxToken: vi.fn(async () => 'tok') }));
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
import { sendThreadedReply, sendNewMail, GraphRecipientMismatchError } from './graphReplySender';

const target = { tenantId: '11111111-1111-1111-1111-111111111111', mailbox: 'support@example.com' };
const REQUESTER = 'requester@example.com';
const OPTS = { to: REQUESTER };

const rcpt = (address: string) => ({ emailAddress: { address } });
// What Graph's PATCH returns when it applied the replace: the updated message.
const patchedEcho = (to: string[] = [REQUESTER], cc: string[] = [], bcc: string[] = []) => ({
  ok: true, status: 200,
  json: async () => ({ id: 'draft-9', toRecipients: to.map(rcpt), ccRecipients: cc.map(rcpt), bccRecipients: bcc.map(rcpt) }),
});
const created = { ok: true, status: 201, json: async () => ({ id: 'draft-9' }) };
const sent = { ok: true, status: 202, text: async () => '' };
const deleted = { ok: true, status: 204, text: async () => '' };

describe('sendThreadedReply', () => {
  beforeEach(() => fetchMock.mockReset());

  it('createReply -> PATCH recipients + body -> send (3 calls, in order)', async () => {
    fetchMock.mockResolvedValueOnce(created).mockResolvedValueOnce(patchedEcho()).mockResolvedValueOnce(sent);

    await sendThreadedReply(target, 'orig-1', '<p>reply</p>', OPTS);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const createReplyCall = fetchMock.mock.calls[0]!;
    const patchDraftCall = fetchMock.mock.calls[1]!;
    const sendDraftCall = fetchMock.mock.calls[2]!;

    expect(createReplyCall[0]).toContain('/messages/orig-1/createReply');
    expect(createReplyCall[1].method).toBe('POST');
    expect(patchDraftCall[0]).toContain('/messages/draft-9');
    expect(patchDraftCall[1].method).toBe('PATCH');
    expect(JSON.parse(patchDraftCall[1].body).body).toEqual({ contentType: 'HTML', content: '<p>reply</p>' });
    expect(sendDraftCall[0]).toContain('/messages/draft-9/send');
    expect(sendDraftCall[1].method).toBe('POST');
  });

  it('replaces createReply recipients with exactly payload.to', async () => {
    fetchMock.mockResolvedValueOnce(created).mockResolvedValueOnce(patchedEcho()).mockResolvedValueOnce(sent);

    await sendThreadedReply(target, 'orig-1', '<p>reply</p>', OPTS);

    // One request carries recipients and body together.
    const patched = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(patched).toEqual({
      toRecipients: [{ emailAddress: { address: 'requester@example.com' } }],
      ccRecipients: [],
      bccRecipients: [],
      replyTo: [{ emailAddress: { address: 'support@example.com' } }],
      body: { contentType: 'HTML', content: '<p>reply</p>' },
    });
  });

  it('accepts an echo that differs only in case', async () => {
    fetchMock.mockResolvedValueOnce(created).mockResolvedValueOnce(patchedEcho(['Requester@Example.COM'])).mockResolvedValueOnce(sent);
    await expect(sendThreadedReply(target, 'orig-1', '<p>reply</p>', OPTS)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[2]![0]).toContain('/send');
  });

  it.each([
    ['still carries a Cc', patchedEcho([REQUESTER], ['colleague@example.com'])],
    ['still carries a Bcc', patchedEcho([REQUESTER], [], ['hidden@example.com'])],
    ['kept an extra To', patchedEcho([REQUESTER, 'colleague@example.com'])],
    ['kept the original To instead', patchedEcho(['colleague@example.com'])],
    ['omits the recipient lists', { ok: true, status: 200, json: async () => ({ id: 'draft-9' }) }],
  ])('deletes the draft and throws when the PATCH response %s', async (_label, patchResponse) => {
    fetchMock.mockResolvedValueOnce(created).mockResolvedValueOnce(patchResponse).mockResolvedValueOnce(deleted);

    const call = sendThreadedReply(target, 'orig-1', '<p>reply</p>', OPTS);
    await expect(call).rejects.toThrow(/recipient/);
    await expect(call).rejects.toBeInstanceOf(GraphRecipientMismatchError);

    const urls = fetchMock.mock.calls.map((c) => `${c[1]?.method ?? 'GET'} ${c[0]}`);
    expect(urls.some((u) => u.includes('/send'))).toBe(false);
    expect(fetchMock.mock.calls[2]![1].method).toBe('DELETE');
    expect(fetchMock.mock.calls[2]![0]).toMatch(/\/messages\/draft-9$/);
  });

  it('deletes the draft when send fails', async () => {
    fetchMock
      .mockResolvedValueOnce(created)
      .mockResolvedValueOnce(patchedEcho())
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' })
      .mockResolvedValueOnce(deleted);

    await expect(sendThreadedReply(target, 'orig-1', '<p>reply</p>', OPTS)).rejects.toThrow(/500/);
    expect(fetchMock.mock.calls[3]![1].method).toBe('DELETE');
    expect(fetchMock.mock.calls[3]![0]).toMatch(/\/messages\/draft-9$/);
  });

  it('rethrows the original error when the draft cleanup itself fails', async () => {
    fetchMock
      .mockResolvedValueOnce(created)
      .mockResolvedValueOnce(patchedEcho([REQUESTER], ['colleague@example.com']))
      .mockRejectedValueOnce(new Error('network down'));

    await expect(sendThreadedReply(target, 'orig-1', '<p>reply</p>', OPTS)).rejects.toBeInstanceOf(GraphRecipientMismatchError);
  });

  it('deletes the draft when the PATCH itself fails', async () => {
    fetchMock
      .mockResolvedValueOnce(created)
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'bad' })
      .mockResolvedValueOnce(deleted);

    await expect(sendThreadedReply(target, 'orig-1', '<p>reply</p>', OPTS)).rejects.toThrow(/400/);
    expect(fetchMock.mock.calls[2]![1].method).toBe('DELETE');
  });

  it("leaves the subject alone by default so the reply keeps Graph's RE: subject", async () => {
    fetchMock.mockResolvedValueOnce(created).mockResolvedValueOnce(patchedEcho()).mockResolvedValueOnce(sent);

    await sendThreadedReply(target, 'orig-1', '<p>reply</p>', OPTS);

    const patched = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(patched).not.toHaveProperty('subject');
  });

  it('PATCHes subject together with body when a subject is passed (#12200)', async () => {
    fetchMock.mockResolvedValueOnce(created).mockResolvedValueOnce(patchedEcho()).mockResolvedValueOnce(sent);

    await sendThreadedReply(target, 'orig-1', '<p>ack</p>', {
      to: REQUESTER,
      subject: '[KQ04YOHZ-N] We received your request: printer down',
    });

    const patched = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(patched.subject).toBe('[KQ04YOHZ-N] We received your request: printer down');
    expect(patched.body).toEqual({ contentType: 'HTML', content: '<p>ack</p>' });
  });

  it('throws if createReply fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'denied' });
    await expect(sendThreadedReply(target, 'orig-1', '<p>x</p>', OPTS)).rejects.toThrow(/403/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('sendNewMail', () => {
  beforeEach(() => fetchMock.mockReset());
  it('POSTs sendMail with the message envelope', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 202, text: async () => '' });
    await sendNewMail(target, 'cust@x.com', 'Re: hi [T-2026-0007]', '<p>hello</p>');
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/users/support%40example.com/sendMail');
    const payload = JSON.parse(opts.body);
    expect(payload.message.toRecipients[0].emailAddress.address).toBe('cust@x.com');
    expect(payload.message.subject).toBe('Re: hi [T-2026-0007]');
    expect(payload.saveToSentItems).toBe(true);
  });

  it('sendNewMail sets replyTo to the mailbox', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 202, text: async () => '' });
    await sendNewMail(target, 'cust@x.com', 'Hello', '<p>hello</p>');
    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(payload.message.replyTo).toEqual([{ emailAddress: { address: 'support@example.com' } }]);
    expect(payload.message.toRecipients).toEqual([{ emailAddress: { address: 'cust@x.com' } }]);
  });
});
