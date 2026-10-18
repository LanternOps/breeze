import { describe, it, expect, vi } from 'vitest';

// Mock the DB layer so this is a pure unit test of the substitution + guard logic.
vi.mock('../db', () => ({
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
  db: {},
}));

import { substituteHuntress, substituteS1 } from './edrInstallerResolver';

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
