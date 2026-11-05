import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  select: vi.fn(),
  open: vi.fn(),
  build: vi.fn(),
  fetchMaterial: vi.fn(),
  released: { value: true },
  allowlist: ['download.example.test'] as string[],
}));

vi.mock('../db', () => ({
  db: {},
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));
vi.mock('./secretCrypto', () => ({ decryptForColumn: vi.fn() }));
vi.mock('./edrProviders/installerTenant', () => ({ selectInstallerTenant: m.select }));
vi.mock('./edrProviders/installerMaterial', () => ({ openInstallerMaterial: m.open }));
vi.mock('./edrProviders/registry', () => ({
  getEdrProvider: () => ({
    get installerHostAllowlist() { return m.allowlist; },
    buildInstaller: m.build,
    fetchInstallerMaterial: m.fetchMaterial,
  }),
}));
vi.mock('./edrProviders/guardedFetch', async (importOriginal) => importOriginal());
vi.mock('./builtinDeploymentPackages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./builtinDeploymentPackages')>();
  return {
    ...actual,
    getBuiltinPackage: (provider: 'bitdefender') => ({ ...actual.BUILTIN_PACKAGES[provider], released: m.released.value }),
  };
});

import { resolveEdrInstaller } from './edrInstallerResolver';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const TENANT = '00000000-0000-4000-8000-0000000000c1';
const L = 'Bitdefender GravityZone';
const URL_OK = 'https://download.example.test/setupdownloader_synthetic.exe';
const SPEC = {
  downloadUrl: URL_OK,
  fileName: 'setupdownloader_synthetic.exe',
  fileType: 'exe' as const,
  silentInstallArgs: '/bdparams /silent',
  checksum: null,
};
const resolve = () => resolveEdrInstaller({
  provider: 'bitdefender',
  orgId: ORG,
  downloadUrlTemplate: '{edr_installer_url}',
  silentInstallArgsTemplate: '{edr_installer_args}',
});
const OK_SELECTION = { kind: 'ok', tenantId: TENANT, connectionId: 'conn', sealedMaterial: 'sealed', expiresAt: null };
const ENVELOPE = { v: 1, provider: 'bitdefender', fetchedAt: '2026-11-05T00:00:00.000Z', expiresAt: null, data: { any: 'thing' } };

beforeEach(() => {
  vi.clearAllMocks();
  m.released.value = true;
  m.allowlist = ['download.example.test'];
  m.select.mockResolvedValue(OK_SELECTION);
  m.open.mockReturnValue(ENVELOPE);
  m.build.mockReturnValue(SPEC);
});

describe('resolveEdrInstaller, framework providers', () => {
  it('happy path: the adapter spec from the tenant material, no checksum, no template substitution', async () => {
    await expect(resolve()).resolves.toEqual({
      downloadUrl: URL_OK,
      silentInstallArgs: '/bdparams /silent',
      fileName: 'setupdownloader_synthetic.exe',
      fileType: 'exe',
      checksum: null,
    });
    expect(m.select).toHaveBeenCalledWith('bitdefender', ORG);
    expect(m.open).toHaveBeenCalledWith(TENANT, 'sealed');
    expect(m.build).toHaveBeenCalledWith(ENVELOPE.data, 'windows');
  });

  it('never fetches from the vendor at dispatch', async () => {
    await resolve();
    expect(m.fetchMaterial).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['no tenant', { kind: 'not_mapped' }, `Organization not mapped to ${L}`],
    ['two tenants', { kind: 'ambiguous', count: 2 }, `Organization maps to 2 ${L} tenants — map it to one`],
    ['a dead connection', { kind: 'inactive' }, `${L} integration is disconnected`],
    ['no material', { kind: 'material_missing' }, `${L} installer link not fetched yet — run Sync in Integrations`],
    ['expired material', { kind: 'material_expired' }, `${L} installer link has expired — run Sync in Integrations`],
  ])('%s is refused with the exact message', async (_label, selection, error) => {
    m.select.mockResolvedValue(selection);
    await expect(resolve()).resolves.toEqual({ error });
    expect(m.open).not.toHaveBeenCalled();
  });

  it('while unreleased, refuses before reading anything', async () => {
    m.released.value = false;
    await expect(resolve()).resolves.toEqual({ error: `${L} installs are not available yet` });
    expect(m.select).not.toHaveBeenCalled();
  });

  const UNREADABLE = `${L} installer link could not be read — reconnect the integration`;

  it('material that does not open is refused', async () => {
    m.open.mockReturnValue(null);
    await expect(resolve()).resolves.toEqual({ error: UNREADABLE });
    expect(m.build).not.toHaveBeenCalled();
  });

  it('material sealed for another provider is refused', async () => {
    m.open.mockReturnValue({ ...ENVELOPE, provider: 'emsisoft' });
    await expect(resolve()).resolves.toEqual({ error: UNREADABLE });
    expect(m.build).not.toHaveBeenCalled();
  });

  it('material the adapter calls invalid is refused', async () => {
    m.build.mockReturnValue({ error: 'material_invalid' });
    await expect(resolve()).resolves.toEqual({ error: UNREADABLE });
  });

  it('a stored link whose host has since left the allowlist is refused', async () => {
    m.allowlist = ['other.example.test'];
    await expect(resolve()).resolves.toEqual({ error: UNREADABLE });
  });

  it('a stored link that is no longer https is refused', async () => {
    m.build.mockReturnValue({ ...SPEC, downloadUrl: 'http://download.example.test/setupdownloader_synthetic.exe' });
    await expect(resolve()).resolves.toEqual({ error: UNREADABLE });
  });

  it('a file name whose extension does not match the file type is refused (the agent would reject it)', async () => {
    m.build.mockReturnValue({ ...SPEC, fileName: 'setupdownloader_synthetic.msi' });
    await expect(resolve()).resolves.toEqual({ error: UNREADABLE });
  });

  it('a platform the adapter cannot install is refused', async () => {
    m.build.mockReturnValue({ error: 'platform_unsupported' });
    await expect(resolve()).resolves.toEqual({ error: `${L} installer is not available for this platform` });
  });

  it('no refusal ever quotes the link', async () => {
    m.allowlist = ['other.example.test'];
    expect(JSON.stringify(await resolve())).not.toContain('setupdownloader');
  });
});
