import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted: both vi.mock factories below are hoisted above plain `const`
// declarations, so bare top-level consts would throw
// "Cannot access '<name>' before initialization".
const {
  domainsCreate, domainsGet, domainsVerify, domainsRemove, domainsList, emailsSend,
  deliverRaw, getEmailService,
} = vi.hoisted(() => ({
  domainsCreate: vi.fn(),
  domainsGet: vi.fn(),
  domainsVerify: vi.fn(),
  domainsRemove: vi.fn(),
  domainsList: vi.fn(),
  emailsSend: vi.fn(),
  deliverRaw: vi.fn(),
  getEmailService: vi.fn(),
}));

vi.mock('resend', () => ({
  Resend: class {
    domains = { create: domainsCreate, get: domainsGet, verify: domainsVerify, remove: domainsRemove, list: domainsList };
    emails = { send: emailsSend };
  }
}));

vi.mock('../../email', () => ({ getEmailService }));

import { createResendDomainProvider } from './resend';
import { createStaticDomainProvider } from './static';
import { createFakeDomainProvider, resetFakeDomainProviderState } from './fake';
import { PartnerLaneSendFailure, type EmailDomainProvider } from '../provider';

const KEYS = ['EMAIL_DOMAINS_RESEND_API_KEY', 'EMAIL_DOMAINS_REGION', 'EMAIL_DOMAINS_STATIC_ALLOWED'];
const SAVED: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const fn of [domainsCreate, domainsGet, domainsVerify, domainsRemove, domainsList, emailsSend]) fn.mockReset();
  deliverRaw.mockReset().mockResolvedValue(undefined);
  getEmailService.mockReset().mockReturnValue({ deliverRaw });
  resetFakeDomainProviderState();
  for (const k of KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; }
  process.env.EMAIL_DOMAINS_RESEND_API_KEY = 're_full';
  process.env.EMAIL_DOMAINS_STATIC_ALLOWED = 'contract.example';
  // Happy-path Resend doubles; individual cases override.
  domainsCreate.mockResolvedValue({ data: { id: 'dom_1', name: 'contract.example', status: 'not_started', region: 'us-east-1', created_at: '2026-09-17T10:00:00.000Z', records: [] }, error: null });
  domainsGet.mockResolvedValue({ data: { id: 'dom_1', name: 'contract.example', status: 'verified', region: 'us-east-1', created_at: '2026-09-17T10:00:00.000Z', records: [] }, error: null });
  domainsVerify.mockResolvedValue({ data: { id: 'dom_1', object: 'domain' }, error: null });
  domainsRemove.mockResolvedValue({ data: { id: 'dom_1', object: 'domain', deleted: true }, error: null });
  domainsList.mockResolvedValue({ data: { data: [], object: 'list', has_more: false }, error: null });
  emailsSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null });
});
afterEach(() => {
  for (const k of KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]!; }
});

interface AdapterCase {
  name: string;
  build: () => EmailDomainProvider;
  id: EmailDomainProvider['id'];
  verifiesByDns: boolean;
  /** A domain this adapter will accept from createDomain. */
  domain: string;
  /** The key its getDomain / deleteDomain take. */
  key: string;
  /** Whether createDomain returns a provider domain id. */
  hasProviderDomainId: boolean;
}

const ADAPTERS: AdapterCase[] = [
  { name: 'fake', build: createFakeDomainProvider, id: 'fake', verifiesByDns: true, domain: 'contract.example', key: 'fake-contract.example', hasProviderDomainId: true },
  { name: 'static', build: createStaticDomainProvider, id: 'static', verifiesByDns: false, domain: 'contract.example', key: 'contract.example', hasProviderDomainId: false },
  { name: 'resend (mocked SDK)', build: createResendDomainProvider, id: 'resend', verifiesByDns: true, domain: 'contract.example', key: 'dom_1', hasProviderDomainId: true }
];

describe.each(ADAPTERS)('EmailDomainProvider contract — $name', (adapter) => {
  it('declares its id and whether it verifies by DNS', () => {
    const provider = adapter.build();
    expect(provider.id).toBe(adapter.id);
    expect(provider.verifiesByDns).toBe(adapter.verifiesByDns);
  });

  it('implements every method of the interface', () => {
    const provider = adapter.build();
    for (const method of ['createDomain', 'findDomainByName', 'getDomain', 'requestVerification', 'deleteDomain', 'listDomains', 'send'] as const) {
      expect(typeof provider[method], method).toBe('function');
    }
  });

  it('createDomain returns a ProviderDomain whose shape the state machine can consume', async () => {
    const result = await adapter.build().createDomain({ domain: adapter.domain, partnerRef: 'p1', partnerSlug: 'acme' });
    expect(['pending', 'verified', 'at_risk', 'failed']).toContain(result.state);
    expect(Array.isArray(result.records)).toBe(true);
    if (adapter.hasProviderDomainId) expect(result.providerDomainId).toEqual(expect.any(String));
    else expect(result.providerDomainId).toBeNull();
  });

  it('every returned DNS record carries a computed fqdn and a tri-state status', async () => {
    const result = await adapter.build().createDomain({ domain: adapter.domain, partnerRef: 'p1', partnerSlug: 'acme' });
    for (const record of result.records) {
      expect(record.fqdn.endsWith(adapter.domain)).toBe(true);
      expect(['TXT', 'CNAME', 'MX']).toContain(record.type);
      expect(['pending', 'verified', 'failed']).toContain(record.status);
      expect(['dkim', 'spf', 'return_path_mx', 'other']).toContain(record.purpose);
    }
  });

  it('findDomainByName returns null for a name the provider does not hold', async () => {
    domainsList.mockResolvedValue({ data: { data: [], object: 'list', has_more: false }, error: null });
    process.env.EMAIL_DOMAINS_STATIC_ALLOWED = 'something.else';
    expect(await adapter.build().findDomainByName('never-created.example')).toBeNull();
  });

  it('deleteDomain treats an unknown key as success (404-as-success)', async () => {
    domainsRemove.mockResolvedValue({ data: null, error: { name: 'not_found', statusCode: 404, message: 'Domain not found' } });
    await expect(adapter.build().deleteDomain('definitely-not-there')).resolves.toBeUndefined();
  });

  it('listDomains returns an array', async () => {
    await expect(adapter.build().listDomains()).resolves.toEqual(expect.any(Array));
  });

  it('send returns a provider message id on success', async () => {
    const result = await adapter.build().send({
      from: `support@${adapter.domain}`, to: 'customer@example.com', subject: 's', html: '<p>h</p>',
      partnerRef: 'p1', tags: { partner_id: 'p1', domain_id: 'd1', stream: 'support', purpose: 'ticket_customer_notification' }
    });
    expect(result.providerMessageId).toEqual(expect.any(String));
    expect(result.providerMessageId.length).toBeGreaterThan(0);
  });

  it('send throws PartnerLaneSendFailure with one of the four kinds, never a bare Error', async () => {
    emailsSend.mockResolvedValue({ data: null, error: { name: 'application_error', statusCode: 500, message: 'boom' } });
    deliverRaw.mockRejectedValue(new Error('boom'));
    const provider = adapter.build();
    let raised: unknown;
    try {
      await provider.send({
        from: `support@${adapter.domain}`, to: 'customer@example.com', subject: 's', html: '<p>h</p>',
        partnerRef: 'p1', tags: {}
      });
    } catch (err) {
      raised = err;
    }
    expect(raised).toBeInstanceOf(PartnerLaneSendFailure);
    expect(['domain_unusable', 'lane_unavailable', 'message_rejected', 'ambiguous'])
      .toContain((raised as PartnerLaneSendFailure).error.kind);
  });

  it('an adapter that does not verify by DNS returns no records at all', async () => {
    const result = await adapter.build().createDomain({ domain: adapter.domain, partnerRef: 'p1', partnerSlug: 'acme' });
    if (!adapter.verifiesByDns) expect(result.records).toEqual([]);
  });
});

describe('find-then-create inputs W03 relies on (spec §5.1)', () => {
  it('fake: a freshly created domain reports a createdAt NEWER than a just-recorded attempt time', async () => {
    const attemptedAt = new Date(Date.now() - 1000);
    const provider = createFakeDomainProvider();
    await provider.createDomain({ domain: 'crashed.example', partnerRef: 'p1' });
    const found = await provider.findDomainByName('crashed.example');
    // Case 3: ours, from an attempt that crashed before the local update.
    expect(found!.createdAt!.getTime()).toBeGreaterThan(attemptedAt.getTime());
  });

  it('fake: a preexisting.* domain reports a createdAt OLDER than any attempt, and is already verified', async () => {
    const found = await createFakeDomainProvider().findDomainByName('preexisting.acme.example');
    // Case 4: pre-existing -> adopt with provider_managed = false, never delete.
    expect(found!.createdAt!.getTime()).toBeLessThan(Date.now());
    // getUTCFullYear, not getFullYear: the fixture is 2000-01-01T00:00:00Z, so
    // any timezone behind UTC reads 1999 locally and the assertion would fail
    // on a US-based machine while passing in CI.
    expect(found!.createdAt!.getUTCFullYear()).toBe(2000);
    expect(found!.state).toBe('verified');
  });

  it('resend: findDomainByName reports the provider createdAt so W03 can compare it', async () => {
    domainsList.mockResolvedValue({ data: { data: [{ id: 'dom_9', name: 'contract.example', status: 'verified', region: 'us-east-1', created_at: '2024-05-05T00:00:00.000Z' }], object: 'list', has_more: false }, error: null });
    domainsGet.mockResolvedValue({ data: { id: 'dom_9', name: 'contract.example', status: 'verified', region: 'us-east-1', created_at: '2024-05-05T00:00:00.000Z', records: [] }, error: null });
    const found = await createResendDomainProvider().findDomainByName('contract.example');
    expect(found).toMatchObject({ providerDomainId: 'dom_9', createdAt: new Date('2024-05-05T00:00:00.000Z'), state: 'verified' });
  });
});
