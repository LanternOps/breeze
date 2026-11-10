/**
 * #11412 W01 (origin #9246): install-argument defaults and the write-time
 * placeholder rule for built-in integration packages.
 *
 * - Blank install args on a built-in integration package default to the
 *   package's own template when the version's file type is the package's
 *   (SentinelOne MSI → SITE_TOKEN={s1_site_token} /q /NORESTART), not the
 *   generic msiexec line the dispatch resolver refuses.
 * - Args that drop the template's single-brace placeholders are refused at
 *   write (400 install_args_missing_placeholders) instead of at dispatch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  existingVersion: null as Record<string, unknown> | null,
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        where: async () => (h.existingVersion ? [h.existingVersion] : []),
      }),
    })),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('./sentry', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('./s3Storage', () => ({ deleteObjects: vi.fn() }));

import type { AuthContext } from '../middleware/auth';
import {
  defaultSilentArgsForCatalogItem,
  integrationInstallArgsError,
  prepareSoftwareVersionCreate,
  prepareSoftwareVersionUpdate,
} from './softwareCatalogOps';

const S1_TEMPLATE = 'SITE_TOKEN={s1_site_token} /q /NORESTART';
const GENERIC_MSI = {
  install: 'msiexec /i "{file}" /qn /norestart',
  uninstall: 'msiexec /x "{file}" /qn /norestart',
};

const partnerAdmin = {
  principal: 'user',
  scope: 'partner',
  partnerId: 'partner-123',
  orgId: null,
  partnerOrgAccess: 'all',
  accessibleOrgIds: ['org-1'],
  user: { id: 'user-1', email: 'admin@example.test', name: 'Admin' },
} as unknown as AuthContext;

const orgUser = {
  principal: 'user',
  scope: 'organization',
  partnerId: 'partner-123',
  orgId: 'org-1',
  accessibleOrgIds: ['org-1'],
  canAccessOrg: (id: string) => id === 'org-1',
  user: { id: 'user-2', email: 'tech@example.test', name: 'Tech' },
} as unknown as AuthContext;

function catalogRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cat-s1',
    orgId: null,
    partnerId: 'partner-123',
    integrationProvider: 'sentinelone',
    builtinPackageKey: null,
    name: 'SentinelOne Agent',
    vendor: 'SentinelOne',
    description: null,
    category: 'security',
    iconUrl: null,
    websiteUrl: null,
    isManaged: true,
    createdAt: new Date(),
    deletedAt: null,
    ...overrides,
  } as Parameters<typeof prepareSoftwareVersionCreate>[0]['catalogItem'];
}

const noExecuteGate = async () => null;

describe('defaultSilentArgsForCatalogItem', () => {
  it('sentinelone + msi → the package template, generic uninstall', () => {
    expect(defaultSilentArgsForCatalogItem({ integrationProvider: 'sentinelone' }, 'msi')).toEqual({
      install: S1_TEMPLATE,
      uninstall: GENERIC_MSI.uninstall,
    });
  });

  it('sentinelone + exe → null (not the package\'s file type, no generic default for exe)', () => {
    expect(defaultSilentArgsForCatalogItem({ integrationProvider: 'sentinelone' }, 'exe')).toBeNull();
  });

  it('sentinelone + MSI (upper case) → the template', () => {
    expect(defaultSilentArgsForCatalogItem({ integrationProvider: 'sentinelone' }, 'MSI')?.install).toBe(S1_TEMPLATE);
  });

  it('huntress + exe → the Huntress template, no uninstall default', () => {
    expect(defaultSilentArgsForCatalogItem({ integrationProvider: 'huntress' }, 'exe')).toEqual({
      install: '/ACCT_KEY="{huntress_acct_key}" /ORG_KEY="{huntress_org_key}" /S',
      uninstall: null,
    });
  });

  it('null provider + msi → the generic msiexec pair', () => {
    expect(defaultSilentArgsForCatalogItem({ integrationProvider: null }, 'msi')).toEqual(GENERIC_MSI);
  });

  it('unknown provider string + msi → the generic msiexec pair', () => {
    expect(defaultSilentArgsForCatalogItem({ integrationProvider: 'not-a-provider' }, 'msi')).toEqual(GENERIC_MSI);
  });

  it('null file type → null', () => {
    expect(defaultSilentArgsForCatalogItem({ integrationProvider: 'sentinelone' }, null)).toBeNull();
  });
});

describe('integrationInstallArgsError', () => {
  it('S1 msi with the generic msiexec line → refused with install_args_missing_placeholders', () => {
    expect(integrationInstallArgsError({ integrationProvider: 'sentinelone' }, 'msi', 'msiexec /i "{file}" /qn'))
      .toEqual({
        error: 'Install arguments for SentinelOne Agent must include {s1_site_token}',
        issues: ['install_args_missing_placeholders'],
      });
  });

  it('S1 msi with the tenant-variable double-brace form → refused', () => {
    expect(integrationInstallArgsError({ integrationProvider: 'sentinelone' }, 'msi', 'SITE_TOKEN={{s1_site_token}} /q'))
      .not.toBeNull();
  });

  it('S1 msi with blank/null args → refused', () => {
    expect(integrationInstallArgsError({ integrationProvider: 'sentinelone' }, 'msi', null)).not.toBeNull();
    expect(integrationInstallArgsError({ integrationProvider: 'sentinelone' }, 'msi', '')).not.toBeNull();
  });

  it('S1 msi with the template → null', () => {
    expect(integrationInstallArgsError({ integrationProvider: 'sentinelone' }, 'msi', S1_TEMPLATE)).toBeNull();
  });

  it('S1 exe with anything → null (not the package\'s file type)', () => {
    expect(integrationInstallArgsError({ integrationProvider: 'sentinelone' }, 'exe', '/S')).toBeNull();
  });

  it('Huntress exe missing one of its two placeholders → names both', () => {
    expect(integrationInstallArgsError({ integrationProvider: 'huntress' }, 'exe', '/ACCT_KEY="{huntress_acct_key}" /S'))
      .toEqual({
        error: 'Install arguments for Huntress EDR Agent must include {huntress_acct_key} and {huntress_org_key}',
        issues: ['install_args_missing_placeholders'],
      });
  });

  it('a custom (non-integration) package → never refused', () => {
    expect(integrationInstallArgsError({ integrationProvider: null }, 'msi', 'msiexec /i "{file}" /qn')).toBeNull();
  });
});

describe('prepareSoftwareVersionCreate on a built-in integration package', () => {
  it('blank silentInstallArgs + fileType msi on the S1 row → the template', async () => {
    const result = await prepareSoftwareVersionCreate({
      auth: partnerAdmin,
      catalogItem: catalogRow(),
      requestedOrgId: undefined,
      payload: { version: '24.1.2', fileType: 'msi', downloadUrl: 'https://example.test/s1.msi' },
      denyUnlessDevicesExecute: noExecuteGate,
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('expected ok');
    expect(result.values.silentInstallArgs).toBe(S1_TEMPLATE);
    expect(result.values.silentUninstallArgs).toBe(GENERIC_MSI.uninstall);
  });

  it('non-blank args carrying the placeholder are kept verbatim', async () => {
    const args = 'SITE_TOKEN={s1_site_token} /qn /norestart WSC=false';
    const result = await prepareSoftwareVersionCreate({
      auth: partnerAdmin,
      catalogItem: catalogRow(),
      requestedOrgId: undefined,
      payload: { version: '24.1.2', fileType: 'msi', downloadUrl: 'https://example.test/s1.msi', silentInstallArgs: args },
      denyUnlessDevicesExecute: noExecuteGate,
    });
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.values.silentInstallArgs).toBe(args);
  });

  it('non-blank args without the placeholder → 400 install_args_missing_placeholders', async () => {
    const result = await prepareSoftwareVersionCreate({
      auth: partnerAdmin,
      catalogItem: catalogRow(),
      requestedOrgId: undefined,
      payload: { version: '24.1.2', fileType: 'msi', downloadUrl: 'https://example.test/s1.msi', silentInstallArgs: 'msiexec /i "{file}" /qn' },
      denyUnlessDevicesExecute: noExecuteGate,
    });
    expect(result).toEqual({
      ok: false,
      status: 400,
      body: {
        error: 'Install arguments for SentinelOne Agent must include {s1_site_token}',
        issues: ['install_args_missing_placeholders'],
      },
    });
  });

  it('a custom org-owned package keeps the generic msiexec default and is never refused', async () => {
    const result = await prepareSoftwareVersionCreate({
      auth: orgUser,
      catalogItem: catalogRow({ id: 'cat-custom', orgId: 'org-1', partnerId: null, integrationProvider: null, name: 'Custom' }),
      requestedOrgId: undefined,
      payload: { version: '1.0', fileType: 'msi', downloadUrl: 'https://example.test/custom.msi', silentInstallArgs: 'msiexec /i "{file}" /qn' },
      denyUnlessDevicesExecute: noExecuteGate,
    });
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.values.silentInstallArgs).toBe('msiexec /i "{file}" /qn');

    const blank = await prepareSoftwareVersionCreate({
      auth: orgUser,
      catalogItem: catalogRow({ id: 'cat-custom', orgId: 'org-1', partnerId: null, integrationProvider: null, name: 'Custom' }),
      requestedOrgId: undefined,
      payload: { version: '1.0', fileType: 'msi', downloadUrl: 'https://example.test/custom.msi' },
      denyUnlessDevicesExecute: noExecuteGate,
    });
    if (!blank.ok) throw new Error('expected ok');
    expect(blank.values.silentInstallArgs).toBe(GENERIC_MSI.install);
  });
});

describe('prepareSoftwareVersionUpdate on a built-in integration package', () => {
  beforeEach(() => {
    h.existingVersion = {
      id: 'ver-1',
      catalogId: 'cat-s1',
      fileType: 'msi',
      s3Key: 'software/partner/partner-123/cat-s1/ver-1/s1.msi',
      silentInstallArgs: S1_TEMPLATE,
      supportedOs: ['windows'],
      installScriptsEnabled: false,
      preInstallScript: null,
      postInstallScript: null,
    };
  });

  it('setting silentInstallArgs: null on an S1 msi version → refused', async () => {
    const result = await prepareSoftwareVersionUpdate({
      auth: partnerAdmin,
      catalogItem: catalogRow(),
      requestedOrgId: undefined,
      versionId: 'ver-1',
      payload: { silentInstallArgs: null },
      denyUnlessDevicesExecute: noExecuteGate,
    });
    expect(result).toMatchObject({ ok: false, status: 400, body: { issues: ['install_args_missing_placeholders'] } });
  });

  it('replacing the args with a placeholder-less line → refused', async () => {
    const result = await prepareSoftwareVersionUpdate({
      auth: partnerAdmin,
      catalogItem: catalogRow(),
      requestedOrgId: undefined,
      versionId: 'ver-1',
      payload: { silentInstallArgs: '/qn /norestart' },
      denyUnlessDevicesExecute: noExecuteGate,
    });
    expect(result).toMatchObject({ ok: false, status: 400, body: { issues: ['install_args_missing_placeholders'] } });
  });

  it('changing only releaseNotes is not checked, even on a version whose stored args lack the placeholder', async () => {
    h.existingVersion = { ...h.existingVersion!, silentInstallArgs: GENERIC_MSI.install };
    const result = await prepareSoftwareVersionUpdate({
      auth: partnerAdmin,
      catalogItem: catalogRow(),
      requestedOrgId: undefined,
      versionId: 'ver-1',
      payload: { releaseNotes: 'pinned build' },
      denyUnlessDevicesExecute: noExecuteGate,
    });
    expect(result).toMatchObject({ ok: true, updates: { releaseNotes: 'pinned build' } });
  });

  it('args carrying the placeholder are accepted', async () => {
    const result = await prepareSoftwareVersionUpdate({
      auth: partnerAdmin,
      catalogItem: catalogRow(),
      requestedOrgId: undefined,
      versionId: 'ver-1',
      payload: { silentInstallArgs: 'SITE_TOKEN={s1_site_token} /qn' },
      denyUnlessDevicesExecute: noExecuteGate,
    });
    expect(result).toMatchObject({ ok: true, updates: { silentInstallArgs: 'SITE_TOKEN={s1_site_token} /qn' } });
  });

  it('a custom org-owned package is never refused', async () => {
    h.existingVersion = { ...h.existingVersion!, catalogId: 'cat-custom', s3Key: 'software/org-1/cat-custom/ver-1/x.msi' };
    const result = await prepareSoftwareVersionUpdate({
      auth: orgUser,
      catalogItem: catalogRow({ id: 'cat-custom', orgId: 'org-1', partnerId: null, integrationProvider: null, name: 'Custom' }),
      requestedOrgId: undefined,
      versionId: 'ver-1',
      payload: { silentInstallArgs: null },
      denyUnlessDevicesExecute: noExecuteGate,
    });
    expect(result).toMatchObject({ ok: true, updates: { silentInstallArgs: null } });
  });
});
