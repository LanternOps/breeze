import { describe, it, expect, afterEach, vi } from 'vitest';
import { coveAdapter, coveCredentialsSchema, __setCoveClientFactoryForTests } from './adapter';
import { ProviderRequestError } from '../types';

const CREDS = { partnerName: 'OliveTech', username: 'api@olivetech.example', password: 'sup3r-s3cret' };
const BASE_URL = 'https://api.backup.management/jsonapi';

function stubClient(overrides: Partial<{
  login: () => Promise<{ visa: string; partnerId: string; partnerName: string }>;
  enumeratePartners: (rootId: string) => Promise<unknown[]>;
  enumerateAccountStatisticsAll: (rootId: string) => Promise<unknown[]>;
}> = {}) {
  const client = {
    login: overrides.login ?? vi.fn(async () => ({ visa: 'v', partnerId: '1000', partnerName: 'OliveTech' })),
    enumeratePartners: overrides.enumeratePartners ?? vi.fn(async () => []),
    enumerateAccountStatisticsAll: overrides.enumerateAccountStatisticsAll ?? vi.fn(async () => []),
  };
  __setCoveClientFactoryForTests(() => client as never);
  return client;
}

afterEach(() => __setCoveClientFactoryForTests(null));

describe('coveCredentialsSchema', () => {
  it('accepts a complete blob and strips unknown keys', () => {
    const parsed = coveCredentialsSchema.parse({ ...CREDS, extra: 'nope' });
    expect(parsed).toEqual(CREDS);
  });

  it.each(['partnerName', 'username', 'password'] as const)('rejects a missing %s', (field) => {
    const bad: Record<string, unknown> = { ...CREDS };
    delete bad[field];
    expect(coveCredentialsSchema.safeParse(bad).success).toBe(false);
  });

  it.each(['partnerName', 'username', 'password'] as const)('rejects a blank %s', (field) => {
    expect(coveCredentialsSchema.safeParse({ ...CREDS, [field]: '   ' }).success).toBe(false);
  });

  it('trims surrounding whitespace on the identity fields but not on the password', () => {
    // A pasted username picks up a trailing space; a password may legitimately
    // end in one, and silently trimming it turns a working credential into an
    // unexplained auth failure.
    const parsed = coveCredentialsSchema.parse({ partnerName: ' OliveTech ', username: ' api@x ', password: ' p ' });
    expect(parsed).toEqual({ partnerName: 'OliveTech', username: 'api@x', password: ' p ' });
  });

  it('rejects an oversized field rather than sending it to the vendor', () => {
    expect(coveCredentialsSchema.safeParse({ ...CREDS, password: 'x'.repeat(5001) }).success).toBe(false);
  });
});

describe('coveAdapter identity', () => {
  it('exposes the contracted key and label', () => {
    expect(coveAdapter.key).toBe('cove');
    expect(coveAdapter.label).toBe('Cove Data Protection');
  });
});

describe('coveAdapter.testConnection', () => {
  it('returns the root partner and the customer count on success', async () => {
    stubClient({
      enumeratePartners: vi.fn(async () => [{ vendorCustomerId: '2001' }, { vendorCustomerId: '2002' }]),
    });
    await expect(coveAdapter.testConnection(CREDS, BASE_URL)).resolves.toEqual({
      ok: true, rootId: '1000', rootName: 'OliveTech', customerCount: 2,
    });
  });

  it('returns ok:false with reauth:true when the login is rejected', async () => {
    stubClient({
      login: vi.fn(async () => {
        throw new ProviderRequestError('Cove login was rejected: bad password', { code: 'login_rejected', reauth: true });
      }),
    });
    const result = await coveAdapter.testConnection(CREDS, BASE_URL);
    expect(result).toMatchObject({ ok: false, reauth: true });
    // The message is shown to the operator — it must carry the vendor's reason
    // and none of the credential.
    expect((result as { error: string }).error).toContain('rejected');
    expect((result as { error: string }).error).not.toContain(CREDS.password);
  });

  it('returns ok:false with reauth:false for a transient failure', async () => {
    stubClient({
      enumeratePartners: vi.fn(async () => {
        throw new ProviderRequestError('Cove EnumeratePartners returned HTTP 503', { code: 'http_503', reauth: false });
      }),
    });
    await expect(coveAdapter.testConnection(CREDS, BASE_URL)).resolves.toMatchObject({ ok: false, reauth: false });
  });

  it('never throws — an unexpected error still comes back as ok:false', async () => {
    // The route turns this into a 200 `{success:false}` body; a throw would
    // surface as a 500 and the web card could not explain anything.
    stubClient({ login: vi.fn(async () => { throw new TypeError('boom'); }) });
    await expect(coveAdapter.testConnection(CREDS, BASE_URL)).resolves.toMatchObject({ ok: false, reauth: false });
  });

  it('rejects a credential blob that fails the schema, without calling the vendor', async () => {
    const client = stubClient();
    const result = await coveAdapter.testConnection({ username: 'x' }, BASE_URL);
    expect(result).toMatchObject({ ok: false, reauth: true });
    expect(client.login).not.toHaveBeenCalled();
  });
});

describe('coveAdapter.listCustomers / listDevices', () => {
  it('logs in once and delegates to the client', async () => {
    const client = stubClient({
      enumeratePartners: vi.fn(async () => [{ vendorCustomerId: '2001', name: 'Acme', parentId: '1000', level: 'EndCustomer', externalCode: null }]),
    });
    const customers = await coveAdapter.listCustomers(CREDS, BASE_URL, '1000');
    expect(client.login).toHaveBeenCalledTimes(1);
    expect(client.enumeratePartners).toHaveBeenCalledWith('1000');
    expect(customers).toHaveLength(1);
  });

  it('propagates a ProviderRequestError from listDevices unchanged (all-or-nothing)', async () => {
    stubClient({
      enumerateAccountStatisticsAll: vi.fn(async () => {
        throw new ProviderRequestError('page 3 failed', { code: 'http_500', reauth: false });
      }),
    });
    // NOT swallowed into an empty array: the sync job deletes vanished devices,
    // so an empty list from a failed enumeration would wipe the inventory.
    await expect(coveAdapter.listDevices(CREDS, BASE_URL, '1000'))
      .rejects.toBeInstanceOf(ProviderRequestError);
  });

  it('wraps a schema failure as a reauth ProviderRequestError', async () => {
    const client = stubClient();
    await expect(coveAdapter.listDevices({ username: 'x' }, BASE_URL, '1000'))
      .rejects.toMatchObject({ code: 'invalid_credentials', reauth: true });
    expect(client.login).not.toHaveBeenCalled();
  });
});
