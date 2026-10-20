import { beforeEach, describe, it, expect, vi } from 'vitest';

// Mock the DB layer so this is a pure unit test of the substitution + guard
// logic. Each db.select() takes the next queued result set and records the
// table it read, so a test can prove which vendor's tables were touched.
const { queued, tablesRead, decrypt } = vi.hoisted(() => ({
  queued: [] as unknown[][],
  tablesRead: [] as unknown[],
  decrypt: vi.fn(),
}));
vi.mock('../db', () => ({
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
  db: {
    select: () => {
      const rows = queued.shift() ?? [];
      const c: Record<string, unknown> = {};
      c.from = (table: unknown) => { tablesRead.push(table); return c; };
      c.where = () => c;
      c.limit = () => Promise.resolve(rows);
      return c;
    },
  },
}));
vi.mock('./secretCrypto', () => ({ decryptForColumn: (...args: unknown[]) => decrypt(...args) }));

import { huntressIntegrations, huntressOrgMappings } from '../db/schema';
import { resolveEdrInstaller, substituteHuntress, substituteS1 } from './edrInstallerResolver';

beforeEach(() => {
  queued.length = 0;
  tablesRead.length = 0;
  decrypt.mockReset();
});

describe('substituteHuntress', () => {
  it('replaces account + org key placeholders', () => {
    const out = substituteHuntress(
      {
        downloadUrlTemplate: 'https://u/{huntress_acct_key}/x.exe',
        silentInstallArgsTemplate: '/ACCT_KEY="{huntress_acct_key}" /ORG_KEY="{huntress_org_key}" /S',
      },
      { acctKey: 'ACCT123', orgKey: 'org-abc' },
    );
    expect(out.downloadUrl).toBe('https://u/ACCT123/x.exe');
    expect(out.silentInstallArgs).toBe('/ACCT_KEY="ACCT123" /ORG_KEY="org-abc" /S');
  });
});

describe('substituteS1', () => {
  it('replaces the site token placeholder', () => {
    const out = substituteS1(
      { downloadUrlTemplate: null, silentInstallArgsTemplate: 'SITE_TOKEN={s1_site_token} /q /NORESTART' },
      { siteToken: 'eyJ-token' },
    );
    expect(out.silentInstallArgs).toBe('SITE_TOKEN=eyJ-token /q /NORESTART');
    expect(out.downloadUrl).toBeNull();
  });
});

describe('resolveEdrInstaller provider dispatch (#6960)', () => {
  it('an unknown provider is refused, never routed to the SentinelOne branch', async () => {
    const { resolveEdrInstaller } = await import('./edrInstallerResolver');
    const result = await resolveEdrInstaller({
      provider: 'controld' as never,
      orgId: '00000000-0000-4000-8000-000000000001',
      downloadUrlTemplate: 'https://example.invalid/x.exe',
      silentInstallArgsTemplate: '/S',
    });
    expect(result).toEqual({ error: expect.stringMatching(/unsupported/i) });
  });
});

describe('resolveEdrInstaller — SentinelOne refusals (#6960 W04)', () => {
  const ORG = '00000000-0000-4000-8000-0000000000a1';
  const TPL = { downloadUrlTemplate: null, silentInstallArgsTemplate: 'SITE_TOKEN={s1_site_token} /q /NORESTART' };
  const resolveS1 = () => resolveEdrInstaller({ provider: 'sentinelone', orgId: ORG, ...TPL });
  const MAPPING = { tokenEncrypted: '<encrypted-site-token>', integrationId: 'int-1' };

  it.each<[string, unknown[][], string]>([
    ['the org has no site mapping', [[]], 'Organization not mapped to SentinelOne'],
    ['the integration is disconnected', [[MAPPING], [{ isActive: false }]], 'SentinelOne integration is disconnected'],
    ['the integration row is gone', [[MAPPING], []], 'SentinelOne integration is disconnected'],
    ['the site token is empty', [[{ ...MAPPING, tokenEncrypted: '' }], [{ isActive: true }]], 'SentinelOne site token not synced — run Sync in Integrations'],
    ['the site token is NULL', [[{ ...MAPPING, tokenEncrypted: null }], [{ isActive: true }]], 'SentinelOne site token not synced — run Sync in Integrations'],
  ])('refuses when %s', async (_name, rows, message) => {
    queued.push(...rows);
    await expect(resolveS1()).resolves.toEqual({ error: message });
    expect(decrypt).not.toHaveBeenCalled();
  });

  it.each([
    ['the generic msiexec args (no placeholder)', 'msiexec /i "{file}" /qn /norestart'],
    ['no args', null],
    ['the {{s1_site_token}} tenant-variable form', 'SITE_TOKEN={{s1_site_token}} /q'],
  ])('refuses %s before reading any mapping or decrypting', async (_name, args) => {
    queued.push([MAPPING], [{ isActive: true }]);
    decrypt.mockReturnValue('<site-token>');
    const result = await resolveEdrInstaller({ provider: 'sentinelone', orgId: ORG, downloadUrlTemplate: null, silentInstallArgsTemplate: args });
    expect(result).toEqual({ error: expect.stringContaining('{s1_site_token}') });
    expect(tablesRead).toEqual([]);
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('refuses an undecryptable site token without throwing', async () => {
    queued.push([MAPPING], [{ isActive: true }]);
    decrypt.mockImplementation(() => { throw new Error('bad ciphertext'); });
    await expect(resolveS1()).resolves.toEqual({ error: 'SentinelOne site token could not be decrypted — reconnect the integration' });
  });

  it('decrypts the site token with the s1_org_mappings column binding and never reads Huntress tables', async () => {
    queued.push([MAPPING], [{ isActive: true }]);
    decrypt.mockReturnValue('<site-token>');
    await expect(resolveS1()).resolves.toEqual({ downloadUrl: null, silentInstallArgs: 'SITE_TOKEN=<site-token> /q /NORESTART' });
    expect(decrypt).toHaveBeenCalledWith('s1_org_mappings', 'registration_token', '<encrypted-site-token>');
    expect(tablesRead).not.toContain(huntressOrgMappings);
    expect(tablesRead).not.toContain(huntressIntegrations);
  });
});
