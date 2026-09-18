import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getProviderMock, sendOpsAlertMock, getRedisMock, enqueueSyncDomainMock } = vi.hoisted(() => ({
  getProviderMock: vi.fn(),
  sendOpsAlertMock: vi.fn(),
  getRedisMock: vi.fn(),
  enqueueSyncDomainMock: vi.fn(),
}));

vi.mock('./providerRegistry', () => ({ getEmailDomainProvider: getProviderMock }));
vi.mock('../opsAlerts', () => ({ sendOpsAlert: sendOpsAlertMock }));
vi.mock('../redis', () => ({ getRedis: getRedisMock }));
vi.mock('../../jobs/sendingDomainsWorker', () => ({ enqueueSyncDomain: enqueueSyncDomainMock }));

import { PartnerLaneSendFailure } from './provider';
import { BREEZE_OUTBOUND_HEADER } from './outboundMarker';
import { sendOnPartnerLane, type PartnerLaneSendInput } from './partnerLaneSend';

const PARTNER = '11111111-1111-1111-1111-111111111111';
const DOMAIN_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_PARTNER = '33333333-3333-3333-3333-333333333333';

const sendMock = vi.fn();

function input(over: Partial<PartnerLaneSendInput> = {}): PartnerLaneSendInput {
  return {
    message: {
      from: '"Acme Support" <support@mail.acme.test>',
      to: ['customer@example.test'],
      subject: 's',
      html: '<p>h</p>',
      headers: { 'Message-ID': '<ticket-t1@tickets.example.test>' },
    },
    purpose: 'ticket.customer_notification',
    partnerId: PARTNER,
    domainId: DOMAIN_ID,
    stream: 'support',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sendMock.mockResolvedValue({ providerMessageId: 'prov-1' });
  getProviderMock.mockReturnValue({ id: 'resend', verifiesByDns: true, send: sendMock });
  // SET NX EX reservation: 'OK' = we won the hour, null = someone already alerted.
  getRedisMock.mockReturnValue({ set: vi.fn(async () => 'OK') });
  enqueueSyncDomainMock.mockResolvedValue(undefined);
  sendOpsAlertMock.mockResolvedValue(true);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('sendOnPartnerLane — the happy path', () => {
  it('delivers through the provider and reports its message id', async () => {
    await expect(sendOnPartnerLane(input())).resolves.toEqual({ delivered: true, providerMessageId: 'prov-1' });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('stamps X-Breeze-Outbound on a NEW headers object, never mutating the caller\'s', async () => {
    const params = input();
    const originalHeaders = params.message.headers!;
    await sendOnPartnerLane(params);
    const sent = sendMock.mock.calls[0]![0];
    expect(sent.headers[BREEZE_OUTBOUND_HEADER]).toBe('1');
    // The fallback message is rebuilt from these same params, and it MUST NOT
    // carry the marker (spec §8.4). Mutating in place would leak it.
    expect(originalHeaders[BREEZE_OUTBOUND_HEADER]).toBeUndefined();
    expect(params.message.headers).toBe(originalHeaders);
  });

  it('keeps the threading headers the call site set', async () => {
    await sendOnPartnerLane(input());
    expect(sendMock.mock.calls[0]![0].headers['Message-ID']).toBe('<ticket-t1@tickets.example.test>');
  });

  it('works when the call site set no headers at all', async () => {
    const params = input();
    delete params.message.headers;
    await sendOnPartnerLane(params);
    expect(sendMock.mock.calls[0]![0].headers).toEqual({ [BREEZE_OUTBOUND_HEADER]: '1' });
  });

  it('tags the message with partner_id, domain_id, stream and purpose (spec §5, §9.3)', async () => {
    await sendOnPartnerLane(input({ purpose: 'invoice.sent', stream: 'billing' }));
    const sent = sendMock.mock.calls[0]![0];
    expect(sent.partnerRef).toBe(PARTNER);
    expect(sent.tags).toEqual({
      partner_id: PARTNER, domain_id: DOMAIN_ID, stream: 'billing', purpose: 'invoice.sent',
    });
  });
});

describe('sendOnPartnerLane — definitive failures fall back (spec §8.4)', () => {
  it.each(['domain_unusable', 'lane_unavailable'] as const)('reports %s as not delivered', async (kind) => {
    sendMock.mockRejectedValue(new PartnerLaneSendFailure({ kind }));
    await expect(sendOnPartnerLane(input())).resolves.toEqual({ delivered: false, failure: kind });
  });

  it('enqueues sync-domain with the refusal text for both definitive kinds', async () => {
    sendMock.mockRejectedValue(new PartnerLaneSendFailure({ kind: 'domain_unusable' }));
    await sendOnPartnerLane(input());
    expect(enqueueSyncDomainMock).toHaveBeenCalledWith(DOMAIN_ID, { lastSendError: expect.stringContaining('domain_unusable') });

    enqueueSyncDomainMock.mockClear();
    sendMock.mockRejectedValue(new PartnerLaneSendFailure({ kind: 'lane_unavailable' }));
    await sendOnPartnerLane(input());
    expect(enqueueSyncDomainMock).toHaveBeenCalledWith(DOMAIN_ID, { lastSendError: expect.stringContaining('lane_unavailable') });
  });

  // The send path must never write partner_sending_domains itself (spec §3.1):
  // it may be running in a context that cannot write that table at all.
  it('never writes the row directly — the worker does', async () => {
    sendMock.mockRejectedValue(new PartnerLaneSendFailure({ kind: 'domain_unusable' }));
    await sendOnPartnerLane(input());
    expect(enqueueSyncDomainMock).toHaveBeenCalledTimes(1);
  });

  it('still falls back when the enqueue itself fails', async () => {
    sendMock.mockRejectedValue(new PartnerLaneSendFailure({ kind: 'domain_unusable' }));
    enqueueSyncDomainMock.mockRejectedValue(new Error('redis down'));
    await expect(sendOnPartnerLane(input())).resolves.toEqual({ delivered: false, failure: 'domain_unusable' });
  });

  it('raises an ops alert for lane_unavailable, at most once per hour', async () => {
    const set = vi.fn(async () => 'OK');
    getRedisMock.mockReturnValue({ set });
    sendMock.mockRejectedValue(new PartnerLaneSendFailure({ kind: 'lane_unavailable' }));
    await sendOnPartnerLane(input());
    expect(sendOpsAlertMock).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(expect.any(String), '1', 'EX', 3600, 'NX');

    // Second occurrence inside the hour: the reservation is refused.
    sendOpsAlertMock.mockClear();
    getRedisMock.mockReturnValue({ set: vi.fn(async () => null) });
    await sendOnPartnerLane(input());
    expect(sendOpsAlertMock).not.toHaveBeenCalled();
  });

  // The dedupe slot is PER PARTNER. A single global key means the first partner
  // to hit a paused lane silences the alert for every other partner for an
  // hour — on a busy instance that is most of them.
  it('deduplicates per partner, not globally', async () => {
    const set = vi.fn(async (key: string) => (key.includes(PARTNER) ? 'OK' : 'OK'));
    getRedisMock.mockReturnValue({ set });
    sendMock.mockRejectedValue(new PartnerLaneSendFailure({ kind: 'lane_unavailable' }));

    await sendOnPartnerLane(input());
    await sendOnPartnerLane(input({ partnerId: OTHER_PARTNER }));

    expect(sendOpsAlertMock).toHaveBeenCalledTimes(2);
    const keys = set.mock.calls.map((c) => c[0] as string);
    expect(keys[0]).toContain(PARTNER);
    expect(keys[1]).toContain(OTHER_PARTNER);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('does NOT raise an ops alert for domain_unusable', async () => {
    sendMock.mockRejectedValue(new PartnerLaneSendFailure({ kind: 'domain_unusable' }));
    await sendOnPartnerLane(input());
    expect(sendOpsAlertMock).not.toHaveBeenCalled();
  });

  it('alerts when Redis is unavailable rather than going silent', async () => {
    getRedisMock.mockReturnValue(null);
    sendMock.mockRejectedValue(new PartnerLaneSendFailure({ kind: 'lane_unavailable' }));
    await sendOnPartnerLane(input());
    expect(sendOpsAlertMock).toHaveBeenCalledTimes(1);
  });
});

describe('sendOnPartnerLane — indefinite failures throw (spec §8.4)', () => {
  it('rethrows message_rejected', async () => {
    const failure = new PartnerLaneSendFailure({ kind: 'message_rejected', detail: 'user unknown' });
    sendMock.mockRejectedValue(failure);
    await expect(sendOnPartnerLane(input())).rejects.toBe(failure);
    expect(enqueueSyncDomainMock).not.toHaveBeenCalled();
  });

  it('rethrows ambiguous — a recipient must never receive two copies', async () => {
    const failure = new PartnerLaneSendFailure({ kind: 'ambiguous', detail: 'timeout' });
    sendMock.mockRejectedValue(failure);
    await expect(sendOnPartnerLane(input())).rejects.toBe(failure);
    expect(enqueueSyncDomainMock).not.toHaveBeenCalled();
  });

  // The adapter contract says `send` throws PartnerLaneSendFailure, but a bug,
  // an SDK panic or an OOM does not read the contract. Anything unrecognised is
  // ambiguous: we do not know whether the message left.
  it('treats any non-PartnerLaneSendFailure exception as ambiguous and rethrows it', async () => {
    const boom = new TypeError('cannot read properties of undefined');
    sendMock.mockRejectedValue(boom);
    await expect(sendOnPartnerLane(input())).rejects.toBe(boom);
    expect(enqueueSyncDomainMock).not.toHaveBeenCalled();
    expect(sendOpsAlertMock).not.toHaveBeenCalled();
  });
});

describe('sendOnPartnerLane — no provider', () => {
  // resolveSender only returns the partner lane when isPartnerLaneConfigured(),
  // so this is a race (the config changed under us), not a normal state. It must
  // fall back, not throw: the message is definitively unsent.
  it('reports lane_unavailable when the registry has no provider', async () => {
    getProviderMock.mockReturnValue(null);
    await expect(sendOnPartnerLane(input())).resolves.toEqual({ delivered: false, failure: 'lane_unavailable' });
    expect(sendMock).not.toHaveBeenCalled();
  });
});
