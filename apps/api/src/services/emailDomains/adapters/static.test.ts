import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted: the vi.mock factory below is hoisted above plain `const`
// declarations, so referencing bare top-level consts in it throws
// "Cannot access 'getEmailService' before initialization".
const { deliverRaw, getEmailService } = vi.hoisted(() => ({
  deliverRaw: vi.fn(),
  getEmailService: vi.fn(),
}));
vi.mock('../../email', () => ({ getEmailService }));

import { createStaticDomainProvider, classifyPlatformTransportError } from './static';
import { PartnerLaneSendFailure, ProviderDomainRejectedError } from '../provider';

const KEYS = ['EMAIL_DOMAINS_STATIC_ALLOWED'];
const SAVED: Record<string, string | undefined> = {};
beforeEach(() => {
  deliverRaw.mockReset().mockResolvedValue(undefined);
  getEmailService.mockReset().mockReturnValue({ deliverRaw });
  for (const k of KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; }
  process.env.EMAIL_DOMAINS_STATIC_ALLOWED = 'open.test, bound.test:acme';
});
afterEach(() => {
  for (const k of KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]!; }
});

describe('static adapter shape', () => {
  it('declares itself as an operator attestation, not a DNS verifier', () => {
    const provider = createStaticDomainProvider();
    expect(provider.id).toBe('static');
    expect(provider.verifiesByDns).toBe(false);
  });
});

describe('createDomain', () => {
  it('accepts an unbound entry for any partner and returns a pending, record-free, id-free domain', async () => {
    await expect(createStaticDomainProvider().createDomain({ domain: 'open.test', partnerRef: 'p1', partnerSlug: 'anyone' }))
      .resolves.toEqual({ providerDomainId: null, state: 'pending', records: [] });
  });

  it('accepts a bound entry for its own partner slug', async () => {
    await expect(createStaticDomainProvider().createDomain({ domain: 'bound.test', partnerRef: 'p1', partnerSlug: 'acme' }))
      .resolves.toMatchObject({ state: 'pending' });
  });

  it('refuses a bound entry for a different partner', async () => {
    await expect(createStaticDomainProvider().createDomain({ domain: 'bound.test', partnerRef: 'p2', partnerSlug: 'other' }))
      .rejects.toBeInstanceOf(ProviderDomainRejectedError);
  });

  it('refuses a bound entry when no slug is supplied', async () => {
    await expect(createStaticDomainProvider().createDomain({ domain: 'bound.test', partnerRef: 'p2' }))
      .rejects.toBeInstanceOf(ProviderDomainRejectedError);
  });

  it('refuses a domain the operator has not listed, and says who to ask', async () => {
    await expect(createStaticDomainProvider().createDomain({ domain: 'nope.com', partnerRef: 'p1', partnerSlug: 'acme' }))
      .rejects.toThrow(/administrator/i);
  });

  it('never makes an external call', async () => {
    await createStaticDomainProvider().createDomain({ domain: 'open.test', partnerRef: 'p1' });
    expect(deliverRaw).not.toHaveBeenCalled();
  });
});

describe('findDomainByName / getDomain', () => {
  it('reports a still-listed domain as pending — verification is the test send, not this call', async () => {
    const provider = createStaticDomainProvider();
    await expect(provider.findDomainByName('open.test')).resolves.toEqual({ providerDomainId: null, state: 'pending', records: [] });
    await expect(provider.getDomain('open.test')).resolves.toEqual({ providerDomainId: null, state: 'pending', records: [] });
  });

  it('reports a DELISTED domain as failed, so the operator removing it stops the sends (spec §13)', async () => {
    process.env.EMAIL_DOMAINS_STATIC_ALLOWED = 'other.com';
    await expect(createStaticDomainProvider().getDomain('open.test')).resolves.toEqual({ providerDomainId: null, state: 'failed', records: [] });
  });

  it('findDomainByName returns null for a delisted domain so W03 can tell "not there" from "broken"', async () => {
    process.env.EMAIL_DOMAINS_STATIC_ALLOWED = 'other.com';
    await expect(createStaticDomainProvider().findDomainByName('open.test')).resolves.toBeNull();
  });

  it('getDomain REVOKES a bound entry re-bound to a different partner — failed, exactly like a delisted domain', async () => {
    // The operator edited EMAIL_DOMAINS_STATIC_ALLOWED from acme.com:msp-a to
    // acme.com:msp-b. Matching on the domain alone would leave partner A
    // sending as a domain the operator has re-assigned.
    await expect(createStaticDomainProvider().getDomain('bound.test', { partnerSlug: 'other' }))
      .resolves.toEqual({ providerDomainId: null, state: 'failed', records: [] });
  });

  it('getDomain keeps a bound entry pending for its OWN partner slug', async () => {
    await expect(createStaticDomainProvider().getDomain('bound.test', { partnerSlug: 'acme' }))
      .resolves.toMatchObject({ state: 'pending' });
  });

  it('getDomain keeps an UNBOUND entry pending for any partner, and with no slug at all', async () => {
    const provider = createStaticDomainProvider();
    await expect(provider.getDomain('open.test', { partnerSlug: 'anyone' })).resolves.toMatchObject({ state: 'pending' });
    await expect(provider.getDomain('open.test')).resolves.toMatchObject({ state: 'pending' });
  });

  it('getDomain fails CLOSED on a bound entry when no slug is supplied — ownership cannot be proven', async () => {
    await expect(createStaticDomainProvider().getDomain('bound.test'))
      .resolves.toEqual({ providerDomainId: null, state: 'failed', records: [] });
  });
});

describe('deleteDomain / requestVerification / listDomains', () => {
  it('deleteDomain is a no-op: Breeze must never touch the operator\'s relay config', async () => {
    await expect(createStaticDomainProvider().deleteDomain('open.test')).resolves.toBeUndefined();
  });
  it('requestVerification is a no-op: there is no DNS to check', async () => {
    await expect(createStaticDomainProvider().requestVerification('open.test')).resolves.toBeUndefined();
  });
  it('listDomains returns [] — the drift report is hosted-only and static is self-hosted-only', async () => {
    await expect(createStaticDomainProvider().listDomains()).resolves.toEqual([]);
  });
});

describe('send', () => {
  const message = {
    from: '"Acme Support" <support@open.test>', to: 'customer@example.com', subject: 'Ticket #1',
    html: '<p>hi</p>', partnerRef: 'p1', tags: { partner_id: 'p1', stream: 'support' }
  };

  it('hands the message to the platform transport verbatim, custom From included', async () => {
    const result = await createStaticDomainProvider().send(message);
    expect(deliverRaw).toHaveBeenCalledWith(expect.objectContaining({ from: '"Acme Support" <support@open.test>', to: 'customer@example.com', subject: 'Ticket #1' }));
    expect(result.providerMessageId).toMatch(/^static:/);
  });

  it('does NOT forward provider tags — the platform transport has no tag concept', async () => {
    await createStaticDomainProvider().send(message);
    expect(deliverRaw.mock.calls[0]![0]).not.toHaveProperty('tags');
    expect(deliverRaw.mock.calls[0]![0]).not.toHaveProperty('partnerRef');
  });

  it('reports lane_unavailable when email is not configured at all', async () => {
    getEmailService.mockReturnValue(null);
    await expect(createStaticDomainProvider().send(message)).rejects.toMatchObject({ error: { kind: 'lane_unavailable' } });
  });

  it('wraps a transport failure in PartnerLaneSendFailure', async () => {
    deliverRaw.mockRejectedValue(Object.assign(new Error('boom'), {}));
    await expect(createStaticDomainProvider().send(message)).rejects.toBeInstanceOf(PartnerLaneSendFailure);
  });

  it('classifies an SMTP SendAs refusal as domain_unusable so the message falls back instead of being lost', async () => {
    deliverRaw.mockRejectedValue(Object.assign(new Error('Client does not have permissions to send as this sender'), {
      responseCode: 550,
      response: '550 5.7.60 SMTP; Client does not have permissions to send as this sender'
    }));
    await expect(createStaticDomainProvider().send(message)).rejects.toMatchObject({ error: { kind: 'domain_unusable' } });
  });
});

describe('classifyPlatformTransportError', () => {
  const smtp = (responseCode: number, response: string) =>
    Object.assign(new Error(response), { responseCode, response });

  it.each([
    [smtp(550, '550 5.7.60 SMTP; Client does not have permissions to send as this sender'), 'domain_unusable'],
    [smtp(553, '553 5.7.1 Sender address rejected: not owned by user'), 'domain_unusable'],
    [smtp(550, '550 5.7.1 Sender not allowed'), 'domain_unusable'],
    [smtp(551, '551 User not local; sender refused'), 'domain_unusable'],
    [smtp(550, '550 5.1.1 User unknown in virtual mailbox table'), 'message_rejected'],
    [smtp(550, '550 5.1.1 The email account that you tried to reach does not exist'), 'message_rejected'],
    [smtp(552, '552 5.3.4 Message size exceeds fixed maximum message size'), 'message_rejected'],
    [smtp(554, '554 5.7.1 Message rejected as spam'), 'message_rejected'],
    [smtp(421, '421 4.7.0 Try again later'), 'ambiguous'],
    [smtp(451, '451 4.3.0 Temporary server error'), 'ambiguous'],
    [new Error('Resend error: The acme.com domain is not verified.'), 'domain_unusable'],
    [new Error('Mailgun API error (401): {"message":"Domain not found: open.test"}'), 'domain_unusable'],
    [new Error('Mailgun API error (400): {"message":"to parameter is not a valid address"}'), 'message_rejected'],
    [new Error('Resend error: Too many requests'), 'ambiguous'],
    [new Error('Mailgun request timed out after 120000ms'), 'ambiguous'],
    [Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:587'), { code: 'ECONNREFUSED' }), 'ambiguous'],
    ['not even an error', 'ambiguous']
  ] as const)('classifies %s as %s', (err, kind) => {
    expect(classifyPlatformTransportError(err).kind).toBe(kind);
  });

  it('uses a false responseCode safely — nodemailer sets it to false, not undefined, when it cannot parse one', () => {
    expect(classifyPlatformTransportError(Object.assign(new Error('x'), { responseCode: false })).kind).toBe('ambiguous');
  });
});
