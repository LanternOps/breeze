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

describe('classifyPlatformTransportError prefers structured fields (W04)', () => {
  function transportError(message: string, fields: Record<string, unknown>) {
    return Object.assign(new Error(message), { name: 'EmailTransportError' }, fields);
  }

  // Structured beats text: these messages contain NO marker at all, so before
  // the structure existed every one of them fell through to `ambiguous` — and
  // an `ambiguous` sender refusal is a lost email, because §8.4 forbids
  // retrying it on the other lane.
  const TABLE: Array<[string, Record<string, unknown>, string]> = [
    ['opaque smtp 550', { transport: 'smtp', smtpResponseCode: 550 }, 'domain_unusable'],
    ['opaque smtp 553', { transport: 'smtp', smtpResponseCode: 553 }, 'domain_unusable'],
    ['opaque smtp 552', { transport: 'smtp', smtpResponseCode: 552 }, 'message_rejected'],
    ['opaque smtp 421', { transport: 'smtp', smtpResponseCode: 421 }, 'ambiguous'],
    ['opaque resend 403', { transport: 'resend', statusCode: 403 }, 'domain_unusable'],
    ['opaque mailgun 403', { transport: 'mailgun', statusCode: 403 }, 'domain_unusable'],
    ['opaque mailgun 401', { transport: 'mailgun', statusCode: 401 }, 'domain_unusable'],
    ['opaque mailgun 429', { transport: 'mailgun', statusCode: 429 }, 'lane_unavailable'],
    ['opaque resend 429', { transport: 'resend', statusCode: 429 }, 'lane_unavailable'],
    ['opaque mailgun 400', { transport: 'mailgun', statusCode: 400 }, 'message_rejected'],
    ['opaque mailgun 500', { transport: 'mailgun', statusCode: 500 }, 'ambiguous'],
  ];

  for (const [message, fields, kind] of TABLE) {
    it(`classifies ${message} as ${kind}`, () => {
      expect(classifyPlatformTransportError(transportError(message, fields)).kind).toBe(kind);
    });
  }

  // UNKNOWN 5xx WAS A LOST EMAIL. Before this, any SMTP 5xx the table did not
  // name fell through to `ambiguous`, which §8.4 forbids retrying on the other
  // lane — so a permanent sender-side refusal with an unfamiliar code was
  // thrown away rather than sent from EMAIL_FROM. 5xx is PERMANENT by
  // definition (RFC 5321 §4.2.1), so the relay definitively did not send it and
  // the platform-lane fallback is safe; 4xx is a transient deferral and stays
  // ambiguous.
  it.each([
    ['530 auth required', 530, 'domain_unusable'],
    ['535 bad credentials', 535, 'domain_unusable'],
    ['501 syntax', 501, 'domain_unusable'],
    ['521 does not accept mail', 521, 'domain_unusable'],
    ['421 service unavailable', 421, 'ambiguous'],
    ['450 mailbox busy', 450, 'ambiguous'],
  ])('classifies an unmapped SMTP %s as %s', (_label, code, kind) => {
    expect(classifyPlatformTransportError(transportError('opaque', { transport: 'smtp', smtpResponseCode: code })).kind).toBe(kind);
  });

  it('still maps 552/554 to message_rejected, not to the new 5xx default', () => {
    expect(classifyPlatformTransportError(transportError('opaque', { transport: 'smtp', smtpResponseCode: 552 })).kind).toBe('message_rejected');
    expect(classifyPlatformTransportError(transportError('opaque', { transport: 'smtp', smtpResponseCode: 554 })).kind).toBe('message_rejected');
  });

  it('lets sender-refusal TEXT win over a status code that says otherwise', () => {
    // A 400 from Resend whose body says the domain is unverified must still
    // fall back rather than be treated as a bad message.
    const err = transportError('Resend error: The acme.test domain is not verified.', { transport: 'resend', statusCode: 400 });
    expect(classifyPlatformTransportError(err).kind).toBe('domain_unusable');
  });

  it('still classifies a plain Error with no structure, by text', () => {
    expect(classifyPlatformTransportError(new Error('550 sender address rejected')).kind).toBe('domain_unusable');
    expect(classifyPlatformTransportError(new Error('user unknown')).kind).toBe('message_rejected');
    expect(classifyPlatformTransportError(new Error('socket hang up')).kind).toBe('ambiguous');
  });
});
