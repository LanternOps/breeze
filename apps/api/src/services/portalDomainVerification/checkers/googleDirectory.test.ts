import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadGoogleConnection = vi.fn();
const decryptConnectionKey = vi.fn();
const domainsList = vi.fn();
const getDirectoryDomainsClient = vi.fn();

vi.mock('../../../db', () => ({
  hasDbAccessContext: vi.fn(() => false),
  withSystemDbAccessContext: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
}));

vi.mock('../../googleHelpers', () => ({
  loadGoogleConnection: (...a: unknown[]) => loadGoogleConnection(...a),
  decryptConnectionKey: (...a: unknown[]) => decryptConnectionKey(...a),
}));
vi.mock('../../googleClient', async (orig) => ({
  ...(await orig<typeof import('../../googleClient')>()),
  getDirectoryDomainsClient: (...a: unknown[]) => getDirectoryDomainsClient(...a),
}));

import { googleDirectoryChecker } from './googleDirectory';

const target = {
  rowId: 'row-1',
  orgId: 'org-1',
  partnerId: 'partner-1',
  domain: 'acme.com',
  verificationToken: null,
};

function listing(domains: unknown[]) {
  domainsList.mockResolvedValue({ data: { domains } });
}

beforeEach(() => {
  vi.clearAllMocks();
  loadGoogleConnection.mockResolvedValue({
    id: 'conn-1',
    orgId: 'org-1',
    adminEmail: 'admin@acme.com',
    serviceAccountEmail: 'sa@project.iam.gserviceaccount.com',
    customerDomain: 'something.test',
  });
  decryptConnectionKey.mockReturnValue('{"k":1}');
  getDirectoryDomainsClient.mockReturnValue({ domains: { list: domainsList } });
});

describe('googleDirectoryChecker', () => {
  it('passes on a verified primary or secondary domain', async () => {
    listing([
      { domainName: 'acme.com', verified: true, isPrimary: true },
      { domainName: 'other.com', verified: true },
    ]);
    expect(await googleDirectoryChecker.check(target)).toEqual({
      status: 'pass',
      evidence: { via: 'google_directory', connectionId: 'conn-1', binding: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    expect(getDirectoryDomainsClient).toHaveBeenCalledWith('{"k":1}', 'admin@acme.com');
    expect(domainsList.mock.calls[0]![0]).toEqual({ customer: 'my_customer' });
    listing([{ domainName: 'ACME.com', verified: true }]);
    expect((await googleDirectoryChecker.check(target)).status).toBe('pass');
  });

  it('passes on a verified domain alias', async () => {
    listing([
      {
        domainName: 'acme.com',
        verified: true,
        domainAliases: [
          { domainAliasName: 'acme.net', verified: true },
          { domainAliasName: 'acme.org', verified: false },
        ],
      },
    ]);
    expect((await googleDirectoryChecker.check({ ...target, domain: 'acme.net' })).status).toBe('pass');
    expect(await googleDirectoryChecker.check({ ...target, domain: 'acme.org' })).toEqual({
      status: 'fail',
      reason: 'not_in_directory',
    });
  });

  it('fails not_in_directory on verified: false, and on an absent domain', async () => {
    listing([
      { domainName: 'acme.com', verified: false },
      { domainName: 'sub.other.com', verified: true },
    ]);
    expect(await googleDirectoryChecker.check(target)).toEqual({ status: 'fail', reason: 'not_in_directory' });
    expect(await googleDirectoryChecker.check({ ...target, domain: 'other.com' })).toEqual({
      status: 'fail',
      reason: 'not_in_directory',
    });
    domainsList.mockResolvedValue({ data: {} });
    expect(await googleDirectoryChecker.check(target)).toEqual({ status: 'fail', reason: 'not_in_directory' });
  });

  it('fails connection_missing when the org has no Google connection', async () => {
    loadGoogleConnection.mockResolvedValue(null);
    expect(await googleDirectoryChecker.check(target)).toEqual({ status: 'fail', reason: 'connection_missing' });
    expect(domainsList).not.toHaveBeenCalled();
  });

  it('ignores customer_domain: a connection whose customer_domain equals the domain still fails when the directory omits it', async () => {
    loadGoogleConnection.mockResolvedValue({
      id: 'conn-1',
      orgId: 'org-1',
      adminEmail: 'admin@acme.com',
      serviceAccountEmail: 'sa@project.iam.gserviceaccount.com',
      customerDomain: 'acme.com',
    });
    listing([{ domainName: 'unrelated.com', verified: true }]);
    expect(await googleDirectoryChecker.check(target)).toEqual({ status: 'fail', reason: 'not_in_directory' });
  });

  it('unauthorized_client maps to unavailable google_scope_missing', async () => {
    domainsList.mockRejectedValue(
      Object.assign(new Error('unauthorized_client: Client is unauthorized to retrieve access tokens'), { code: 401 }),
    );
    expect(await googleDirectoryChecker.check(target)).toEqual({ status: 'unavailable', reason: 'google_scope_missing' });
    domainsList.mockRejectedValue({ message: 'x', response: { data: { error: 'unauthorized_client' } } });
    expect(await googleDirectoryChecker.check(target)).toEqual({ status: 'unavailable', reason: 'google_scope_missing' });
  });

  it('403 maps to google_access_denied; 5xx and timeout map to google_unavailable', async () => {
    domainsList.mockRejectedValue(Object.assign(new Error('forbidden'), { code: 403 }));
    expect(await googleDirectoryChecker.check(target)).toEqual({ status: 'unavailable', reason: 'google_access_denied' });
    domainsList.mockRejectedValue(Object.assign(new Error('nope'), { code: 401 }));
    expect(await googleDirectoryChecker.check(target)).toEqual({ status: 'unavailable', reason: 'google_access_denied' });
    domainsList.mockRejectedValue(Object.assign(new Error('boom'), { code: 503 }));
    expect(await googleDirectoryChecker.check(target)).toEqual({ status: 'unavailable', reason: 'google_unavailable' });
    domainsList.mockRejectedValue(Object.assign(new Error('network down'), { code: 'ECONNRESET' }));
    expect(await googleDirectoryChecker.check(target)).toEqual({ status: 'unavailable', reason: 'google_unavailable' });
    loadGoogleConnection.mockRejectedValueOnce(new Error('db'));
    expect(await googleDirectoryChecker.check(target)).toEqual({ status: 'unavailable', reason: 'google_unavailable' });
    vi.useFakeTimers();
    try {
      domainsList.mockReturnValue(new Promise(() => {}));
      const p = googleDirectoryChecker.check(target);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await p).toEqual({ status: 'unavailable', reason: 'google_unavailable' });
    } finally {
      vi.useRealTimers();
    }
  });
});
