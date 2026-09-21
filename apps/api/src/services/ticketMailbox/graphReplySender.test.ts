import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('./mailboxToken', () => ({ getMailboxToken: vi.fn(async () => 'tok') }));
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
import { sendThreadedReply, sendNewMail } from './graphReplySender';

const target = { tenantId: '11111111-1111-1111-1111-111111111111', mailbox: 'support@a.com' };

describe('sendThreadedReply', () => {
  beforeEach(() => fetchMock.mockReset());

  it('createReply -> PATCH body -> send (3 calls, in order)', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ id: 'draft-9' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 202, text: async () => '' });

    await sendThreadedReply(target, 'orig-1', '<p>reply</p>');

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

  it('throws if createReply fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'denied' });
    await expect(sendThreadedReply(target, 'orig-1', '<p>x</p>')).rejects.toThrow(/403/);
  });
});

describe('sendNewMail', () => {
  beforeEach(() => fetchMock.mockReset());
  it('POSTs sendMail with the message envelope', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 202, text: async () => '' });
    await sendNewMail(target, 'cust@x.com', 'Re: hi [T-2026-0007]', '<p>hello</p>');
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/users/support%40a.com/sendMail');
    const payload = JSON.parse(opts.body);
    expect(payload.message.toRecipients[0].emailAddress.address).toBe('cust@x.com');
    expect(payload.message.subject).toBe('Re: hi [T-2026-0007]');
    expect(payload.saveToSentItems).toBe(true);
  });
});
