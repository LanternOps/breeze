import { describe, it, expect, vi } from 'vitest';
import { PSA_PROVIDERS } from '@breeze/shared';
import { createPsaCompanyImportSource, psaCompanyToImportRow } from './companyImport';
import {
  ORG_IMPORT_CAPABLE_PSA_PROVIDERS,
  PSA_COMPANY_LIST_CAP,
  PsaCapabilityError
} from './types';

const listing = (companies: Array<{ id: string; name: string; externalId?: string }>, truncated = false) =>
  vi.fn().mockResolvedValue({ companies, truncated });

describe('ORG_IMPORT_CAPABLE_PSA_PROVIDERS', () => {
  it('accounts for EVERY shared provider exactly once', () => {
    // The point of this assertion: adding a provider to @breeze/shared without
    // deciding whether it can import companies silently defaults it to
    // "incapable" and the feature quietly never appears for it. This fails that
    // PR instead.
    const accountedFor = [...ORG_IMPORT_CAPABLE_PSA_PROVIDERS, 'jira'].sort();
    expect(accountedFor).toEqual([...PSA_PROVIDERS].sort());
  });

  it('excludes jira — an issue tracker has no company object', () => {
    expect(ORG_IMPORT_CAPABLE_PSA_PROVIDERS).not.toContain('jira');
  });
});

describe('psaCompanyToImportRow', () => {
  it('maps name to organization and stamps the provider as externalSystem', () => {
    expect(psaCompanyToImportRow({ id: '42', name: 'Acme Ltd', externalId: 'CW-42' }, 'connectwise'))
      .toEqual({ organization: 'Acme Ltd', externalId: 'CW-42', externalSystem: 'connectwise' });
  });

  it('falls back to id when the adapter supplies no externalId', () => {
    expect(psaCompanyToImportRow({ id: '42', name: 'Acme Ltd' }, 'zendesk')).toEqual({
      organization: 'Acme Ltd',
      externalId: '42',
      externalSystem: 'zendesk'
    });
  });

  it('emits no site, so every org takes the seam default-site path', () => {
    const row = psaCompanyToImportRow({ id: '1', name: 'Acme' }, 'autotask');
    expect(row.site).toBeUndefined();
    expect(row.timezone).toBeUndefined();
    expect(row.address).toBeUndefined();
  });
});

describe('createPsaCompanyImportSource', () => {
  it('exposes the provider slug as the seam `system` value', () => {
    const source = createPsaCompanyImportSource({
      provider: 'connectwise',
      client: { getCompanies: listing([]) }
    });
    expect(source.system).toBe('connectwise');
  });

  it('refuses an import-incapable provider before any outbound call', () => {
    const getCompanies = listing([]);
    expect(() =>
      createPsaCompanyImportSource({ provider: 'jira', client: { getCompanies } })
    ).toThrow(PsaCapabilityError);
    expect(getCompanies).not.toHaveBeenCalled();
  });

  it('refuses an unknown provider string', () => {
    expect(() =>
      createPsaCompanyImportSource({ provider: 'halo', client: { getCompanies: listing([]) } })
    ).toThrow(PsaCapabilityError);
  });

  it('maps companies and passes truncation through', async () => {
    const getCompanies = listing(
      [
        { id: '1', name: 'Acme' },
        { id: '2', name: 'Globex', externalId: 'G-2' }
      ],
      true
    );
    const source = createPsaCompanyImportSource({ provider: 'servicenow', client: { getCompanies } });

    const result = await source.listCompanies({ partnerId: 'partner-1' });

    expect(result.truncated).toBe(true);
    expect(result.rows).toEqual([
      { organization: 'Acme', externalId: '1', externalSystem: 'servicenow' },
      { organization: 'Globex', externalId: 'G-2', externalSystem: 'servicenow' }
    ]);
  });

  it('requests the shared cap by default', async () => {
    const getCompanies = listing([]);
    const source = createPsaCompanyImportSource({ provider: 'freshservice', client: { getCompanies } });

    await source.listCompanies({ partnerId: 'partner-1' });

    expect(getCompanies).toHaveBeenCalledWith({ limit: PSA_COMPANY_LIST_CAP });
  });

  it('honours an explicit limit', async () => {
    const getCompanies = listing([]);
    const source = createPsaCompanyImportSource({
      provider: 'freshservice',
      client: { getCompanies },
      limit: 25
    });

    await source.listCompanies({ partnerId: 'partner-1' });

    expect(getCompanies).toHaveBeenCalledWith({ limit: 25 });
  });

  it('satisfies the OrgImportSource seam: list() yields rows only', async () => {
    const source = createPsaCompanyImportSource({
      provider: 'zendesk',
      client: { getCompanies: listing([{ id: '9', name: 'Initech' }], true) }
    });

    const rows = await source.list({ partnerId: 'partner-1' });

    // `list()` is the declared seam and has nowhere to report truncation — the
    // reason the route uses listCompanies() instead. Documented in the source.
    expect(rows).toEqual([{ organization: 'Initech', externalId: '9', externalSystem: 'zendesk' }]);
  });

  it('propagates an adapter failure rather than returning an empty list', async () => {
    const source = createPsaCompanyImportSource({
      provider: 'autotask',
      client: { getCompanies: vi.fn().mockRejectedValue(new Error('502 from PSA')) }
    });

    await expect(source.listCompanies({ partnerId: 'p' })).rejects.toThrow('502 from PSA');
  });
});
