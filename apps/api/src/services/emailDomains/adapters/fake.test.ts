import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted: the vi.mock factory is hoisted above plain const declarations.
const { deliverRaw, getEmailService } = vi.hoisted(() => ({
  deliverRaw: vi.fn(),
  getEmailService: vi.fn(),
}));
vi.mock('../../email', () => ({ getEmailService }));

import {
  createFakeDomainProvider,
  resetFakeDomainProviderState,
  FAKE_PREEXISTING_PREFIX
} from './fake';
import { PartnerLaneSendFailure, ProviderDomainConflictError } from '../provider';

beforeEach(() => {
  deliverRaw.mockReset().mockResolvedValue(undefined);
  getEmailService.mockReset().mockReturnValue({ deliverRaw, transportKind: () => 'smtp' });
  resetFakeDomainProviderState();
});

const send = (from: string) => createFakeDomainProvider().send({
  from, to: 'customer@example.com', subject: 's', html: '<p>h</p>',
  partnerRef: 'p1', tags: { partner_id: 'p1', stream: 'support' }
});

describe('fake adapter shape', () => {
  it('declares itself as a DNS verifier', () => {
    const provider = createFakeDomainProvider();
    expect(provider.id).toBe('fake');
    expect(provider.verifiesByDns).toBe(true);
  });
});

describe('*.verify.test — verifies on the first check', () => {
  it.each(['verify.test', 'acme.verify.test', 'deep.sub.verify.test'])('%s creates already verified', async (domain) => {
    const result = await createFakeDomainProvider().createDomain({ domain, partnerRef: 'p1' });
    expect(result.state).toBe('verified');
    expect(result.providerDomainId).toBe(`fake-${domain}`);
  });

  it('reports every DNS record as verified, with a computed fqdn', async () => {
    const { records } = await createFakeDomainProvider().createDomain({ domain: 'acme.verify.test', partnerRef: 'p1' });
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.status)).toEqual(['verified', 'verified', 'verified']);
    expect(records.map((r) => r.purpose)).toEqual(['dkim', 'spf', 'return_path_mx']);
    for (const record of records) expect(record.fqdn.endsWith('acme.verify.test')).toBe(true);
  });

  it('getDomain and findDomainByName agree after creation', async () => {
    const provider = createFakeDomainProvider();
    await provider.createDomain({ domain: 'acme.verify.test', partnerRef: 'p1' });
    expect((await provider.getDomain('fake-acme.verify.test')).state).toBe('verified');
    expect((await provider.findDomainByName('acme.verify.test'))?.state).toBe('verified');
  });
});

describe('*.fail.test — fails verification and refuses to send', () => {
  it.each(['fail.test', 'acme.fail.test'])('%s creates failed with failed records', async (domain) => {
    const result = await createFakeDomainProvider().createDomain({ domain, partnerRef: 'p1' });
    expect(result.state).toBe('failed');
    expect(result.records.every((r) => r.status === 'failed')).toBe(true);
  });

  it('refuses to send from a bare fail.test address with domain_unusable', async () => {
    await expect(send('support@fail.test')).rejects.toMatchObject({ error: { kind: 'domain_unusable' } });
    expect(deliverRaw).not.toHaveBeenCalled();
  });

  it('refuses a subdomain of fail.test too', async () => {
    await expect(send('support@acme.fail.test')).rejects.toMatchObject({ error: { kind: 'domain_unusable' } });
  });

  it('refuses when the From carries a display name and angle brackets', async () => {
    await expect(send('"Acme Support" <support@acme.fail.test>'))
      .rejects.toMatchObject({ error: { kind: 'domain_unusable' } });
  });
});

describe('conflict.test — createDomain raises a conflict', () => {
  it.each(['conflict.test', 'acme.conflict.test'])('%s raises ProviderDomainConflictError', async (domain) => {
    await expect(createFakeDomainProvider().createDomain({ domain, partnerRef: 'p1' }))
      .rejects.toBeInstanceOf(ProviderDomainConflictError);
  });

  it('records nothing when it conflicts, so listDomains stays empty', async () => {
    const provider = createFakeDomainProvider();
    await expect(provider.createDomain({ domain: 'conflict.test', partnerRef: 'p1' })).rejects.toThrow();
    await expect(provider.listDomains()).resolves.toEqual([]);
  });
});

describe(`${FAKE_PREEXISTING_PREFIX}* — the adopt-and-never-delete case`, () => {
  it('findDomainByName reports a verified domain created in 2000 without any seeding', async () => {
    const found = await createFakeDomainProvider().findDomainByName('preexisting.acme.example');
    expect(found).not.toBeNull();
    expect(found!.state).toBe('verified');
    expect(found!.createdAt!.getUTCFullYear()).toBe(2000);
  });
});

describe('plain domains stay pending', () => {
  it('createDomain reports pending and findDomainByName is null before creation', async () => {
    const provider = createFakeDomainProvider();
    expect(await provider.findDomainByName('plain.example')).toBeNull();
    expect((await provider.createDomain({ domain: 'plain.example', partnerRef: 'p1' })).state).toBe('pending');
    expect((await provider.findDomainByName('plain.example'))!.state).toBe('pending');
  });
});

describe('send via the platform transport', () => {
  it('smtp transport: hands the message to deliverRaw verbatim, custom From included', async () => {
    const result = await send('"Acme" <support@plain.example>');
    expect(deliverRaw).toHaveBeenCalledWith(expect.objectContaining({
      from: '"Acme" <support@plain.example>', to: 'customer@example.com', subject: 's'
    }));
    expect(result.providerMessageId).toMatch(/^fake:/);
  });

  it('strips the provider-only fields — deliverRaw takes a RawEmailMessage', async () => {
    await send('support@plain.example');
    expect(deliverRaw.mock.calls[0]![0]).not.toHaveProperty('tags');
    expect(deliverRaw.mock.calls[0]![0]).not.toHaveProperty('partnerRef');
  });

  it('wraps an smtp transport failure as ambiguous, carrying the detail', async () => {
    deliverRaw.mockRejectedValue(new Error('smtp exploded'));
    const raised = await send('support@plain.example').catch((e: unknown) => e);
    expect(raised).toBeInstanceOf(PartnerLaneSendFailure);
    expect((raised as PartnerLaneSendFailure).error).toMatchObject({ kind: 'ambiguous', detail: 'smtp exploded' });
  });

  it('resend transport: does NOT call deliverRaw, and returns a synthetic id', async () => {
    getEmailService.mockReturnValue({ deliverRaw, transportKind: () => 'resend' });
    const result = await send('support@plain.example');
    expect(deliverRaw).not.toHaveBeenCalled();
    expect(result.providerMessageId).toMatch(/^fake-/);
  });

  it('mailgun transport: does NOT call deliverRaw, and returns a synthetic id', async () => {
    getEmailService.mockReturnValue({ deliverRaw, transportKind: () => 'mailgun' });
    const result = await send('support@plain.example');
    expect(deliverRaw).not.toHaveBeenCalled();
    expect(result.providerMessageId).toMatch(/^fake-/);
  });

  it('no email service configured: does NOT call deliverRaw, and returns a synthetic id', async () => {
    getEmailService.mockReturnValue(null);
    const result = await send('support@plain.example');
    expect(deliverRaw).not.toHaveBeenCalled();
    expect(result.providerMessageId).toMatch(/^fake-/);
  });
});

describe('deleteDomain / listDomains / state reset', () => {
  it('deleting an unknown id succeeds (404-as-success)', async () => {
    await expect(createFakeDomainProvider().deleteDomain('fake-never.example')).resolves.toBeUndefined();
  });

  it('listDomains reflects created domains and drops deleted ones', async () => {
    const provider = createFakeDomainProvider();
    await provider.createDomain({ domain: 'a.example', partnerRef: 'p1' });
    await provider.createDomain({ domain: 'b.example', partnerRef: 'p1' });
    expect((await provider.listDomains()).map((d) => d.domain).sort()).toEqual(['a.example', 'b.example']);
    await provider.deleteDomain('fake-a.example');
    expect((await provider.listDomains()).map((d) => d.domain)).toEqual(['b.example']);
  });

  it('resetFakeDomainProviderState clears state shared across provider instances', async () => {
    await createFakeDomainProvider().createDomain({ domain: 'a.example', partnerRef: 'p1' });
    resetFakeDomainProviderState();
    expect(await createFakeDomainProvider().findDomainByName('a.example')).toBeNull();
  });
});
