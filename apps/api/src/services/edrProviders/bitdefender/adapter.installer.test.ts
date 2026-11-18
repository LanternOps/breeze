import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EdrProviderRequestError, type EdrAdapterContext, type GuardedFetch } from '../types';
import { validateVendorUrl } from '../guardedFetch';
import { bitdefenderAdapter as adapter } from './adapter';

// All vendor facts here are [U] until the owner lab (W06.3): the fixtures follow
// the published Packages API and carry synthetic values only.
const fx = (n: string) => readFileSync(join(__dirname, '__fixtures__', n), 'utf8');
const COMPANY = '5f0a1b2c3d4e5f60718293a1';
const API_KEY = 'SECRETKEY0123456789abcdef';
const WINDOWS_NAME = 'setupdownloader_[aHR0cHM6Ly9leGFtcGxlLnRlc3Q=-synthetic].exe';
const WINDOWS_URL = 'https://cloud.gravityzone.bitdefender.com/Packages/BSTWIN/0/setupdownloader_%5BaHR0cHM6Ly9leGFtcGxlLnRlc3Q%3D-synthetic%5D.exe';

type Reply = { status?: number; body: string };

function makeCtx(reply: Reply) {
  const calls: Array<{ url: string; params: unknown; method: string }> = [];
  const acquire = vi.fn(async () => {});
  const fetch: GuardedFetch = vi.fn(async (url, init) => {
    const body = JSON.parse(init.body!);
    calls.push({ url, params: body.params, method: body.method });
    return { status: reply.status ?? 200, headers: new Headers(), text: async () => reply.body };
  });
  const ctx: EdrAdapterContext = {
    creds: { apiKey: API_KEY },
    baseUrl: 'https://cloud.gravityzone.bitdefender.com/api',
    region: null,
    fetch,
    limiter: { acquire },
    runCache: new Map(),
  };
  return { ctx, calls, acquire };
}

const rpc = (result: unknown): Reply => ({ body: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) });
const fetchMaterial = (reply: Reply) => {
  const { ctx } = makeCtx(reply);
  return adapter.fetchInstallerMaterial!(ctx, { vendorTenantId: COMPANY, apiHost: null });
};
const linkWith = (over: Record<string, unknown>) => [{ packageName: 'Synthetic', companyId: COMPANY, installLinkWindows: WINDOWS_URL, ...over }];

describe('GravityZone installer capability', () => {
  it('declares a generated link, a download host list and its own budget', () => {
    expect(adapter.capabilities.installer).toBe('api_generated_link');
    expect(adapter.capabilities.operationBudgets?.packages).toEqual({ perMinute: 10 });
    expect(adapter.installerHostAllowlist).toEqual(['.gravityzone.bitdefender.com', 'download.bitdefender.com']);
  });
});

describe('fetchInstallerMaterial', () => {
  it('one package: returns the Windows link, with no expiry, after asking for that company under the packages budget', async () => {
    const { ctx, calls, acquire } = makeCtx({ body: fx('installation-links-one.json') });
    const result = await adapter.fetchInstallerMaterial!(ctx, { vendorTenantId: COMPANY, apiHost: null });
    expect(result).toEqual({
      ok: true,
      data: { v: 1, packageName: 'Synthetic Package', windowsUrl: WINDOWS_URL },
      expiresAt: null,
    });
    expect(calls).toEqual([expect.objectContaining({ method: 'getInstallationLinks', params: { companyId: COMPANY } })]);
    expect(calls[0]!.url).toContain('/jsonrpc/packages');
    expect(acquire).toHaveBeenCalledWith('packages');
    expect(validateVendorUrl(WINDOWS_URL, adapter.installerHostAllowlist!).ok).toBe(true);
  });

  it('two packages: multiple_packages, never a guess', async () => {
    await expect(fetchMaterial({ body: fx('installation-links-two.json') })).resolves.toEqual({ ok: false, code: 'multiple_packages' });
  });

  it('no package: no_package', async () => {
    await expect(fetchMaterial({ body: fx('installation-links-none.json') })).resolves.toEqual({ ok: false, code: 'no_package' });
  });

  it('a package with no Windows link: malformed_response', async () => {
    await expect(fetchMaterial({ body: fx('installation-links-malformed.json') })).resolves.toEqual({ ok: false, code: 'malformed_response' });
  });

  it.each([[[null]], [['a string']], [[42]]])('an entry that is not an object (%j): malformed_response, not a thrown TypeError', async (result) => {
    await expect(fetchMaterial(rpc(result))).resolves.toEqual({ ok: false, code: 'malformed_response' });
  });

  it('a result that is not a list: malformed_response', async () => {
    await expect(fetchMaterial(rpc({ items: [] }))).resolves.toEqual({ ok: false, code: 'malformed_response' });
  });

  it('a link with no company id: malformed_response, since nothing proves which company it enrols into', async () => {
    await expect(fetchMaterial(rpc([{ packageName: 'Synthetic', installLinkWindows: WINDOWS_URL }]))).resolves.toEqual({
      ok: false, code: 'malformed_response',
    });
  });

  it('a link another company owns: malformed_response, so it can never install into the wrong company', async () => {
    await expect(fetchMaterial(rpc(linkWith({ companyId: '5f0a1b2c3d4e5f60718293a2' })))).resolves.toEqual({ ok: false, code: 'malformed_response' });
  });

  it.each([
    ['plain http', 'http://cloud.gravityzone.bitdefender.com/setupdownloader.exe'],
    // Host is interpolated so the `user:pass@host` form does not read as an email address to the PII guard.
    ['embedded credentials', `https://user:pass@${'cloud.gravityzone.bitdefender.com'}/setupdownloader.exe`],
    ['a host outside the allowlist', 'https://downloads.example.test/setupdownloader.exe'],
    ['a look-alike suffix', 'https://xgravityzone.bitdefender.com/setupdownloader.exe'],
    ['not a URL', 'setupdownloader.exe'],
  ])('%s: url_rejected', async (_label, installLinkWindows) => {
    await expect(fetchMaterial(rpc(linkWith({ installLinkWindows })))).resolves.toEqual({ ok: false, code: 'url_rejected' });
  });

  it('a link that dispatch could not build from: malformed_response at fetch time, so the operator sees it', async () => {
    const url = 'https://cloud.gravityzone.bitdefender.com/Packages/setup.zip';
    await expect(fetchMaterial(rpc(linkWith({ installLinkWindows: url })))).resolves.toEqual({ ok: false, code: 'malformed_response' });
  });

  it('the packages API refused on this key: packages_api_disabled, not a thrown reauth', async () => {
    await expect(fetchMaterial({ body: fx('error-api-not-enabled-incidents.json') })).resolves.toEqual({ ok: false, code: 'packages_api_disabled' });
  });

  it('a dead key still throws a connection-scope reauth error', async () => {
    await expect(fetchMaterial({ status: 401, body: '' })).rejects.toMatchObject({
      code: 'auth', reauth: true, scope: 'connection',
    });
  });

  it('errors name the service and status only: no URL, company id, package name or vendor text', async () => {
    const leak = `${WINDOWS_URL} ${COMPANY} Synthetic Package`;
    const error = await fetchMaterial({
      status: 200,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: leak, data: { details: leak } } }),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EdrProviderRequestError);
    const message = (error as Error).message;
    expect(message).toContain('packages.getInstallationLinks');
    for (const secret of [WINDOWS_URL, COMPANY, 'Synthetic Package']) expect(message).not.toContain(secret);
  });
});

describe('buildInstaller', () => {
  const data = { v: 1, packageName: 'Synthetic', windowsUrl: WINDOWS_URL };

  it('Windows: the decoded URL file name, silent switches and no checksum', () => {
    expect(adapter.buildInstaller!(data, 'windows')).toEqual({
      downloadUrl: WINDOWS_URL,
      fileName: WINDOWS_NAME,
      fileType: 'exe',
      silentInstallArgs: '/bdparams /silent',
      checksum: null,
    });
  });

  it.each(['macos', 'linux'] as const)('%s is refused', (platform) => {
    expect(adapter.buildInstaller!(data, platform)).toEqual({ error: 'platform_unsupported' });
  });

  it.each([
    ['garbage', 'nope'],
    ['null', null],
    ['a wrong version', { ...data, v: 2 }],
    ['an unknown key', { ...data, extra: 1 }],
    ['no URL', { v: 1, packageName: 'Synthetic' }],
  ])('%s is material_invalid', (_label, value) => {
    expect(adapter.buildInstaller!(value, 'windows')).toEqual({ error: 'material_invalid' });
  });

  it.each([
    ['not an exe', 'https://cloud.gravityzone.bitdefender.com/Packages/setup.zip'],
    ['no file name', 'https://cloud.gravityzone.bitdefender.com/'],
    ['bad percent-encoding', 'https://cloud.gravityzone.bitdefender.com/setup%E0%A4%A.exe'],
    ['an encoded forward slash', 'https://cloud.gravityzone.bitdefender.com/x%2F..%2Fsetup.exe'],
    ['an encoded backslash', 'https://cloud.gravityzone.bitdefender.com/x%5C..%5Csetup.exe'],
    ['an encoded null byte', 'https://cloud.gravityzone.bitdefender.com/setup%00.exe'],
    ['a template token', 'https://cloud.gravityzone.bitdefender.com/{{var.x}}/setup.exe'],
    ['a name too long for Windows', `https://cloud.gravityzone.bitdefender.com/${'a'.repeat(256)}.exe`],
  ])('a URL with %s is material_invalid', (_label, windowsUrl) => {
    expect(adapter.buildInstaller!({ ...data, windowsUrl }, 'windows')).toEqual({ error: 'material_invalid' });
  });

  it('is pure: the adapter module imports no db and no fetch', () => {
    const source = readFileSync(join(__dirname, 'adapter.ts'), 'utf8');
    expect(source).not.toMatch(/from\s+'[^']*\/db(\/[^']*)?'/);
    const body = /buildInstaller\(data[^]*?\n {2}\},\n/.exec(source)?.[0];
    expect(body, 'buildInstaller body').toBeTruthy();
    expect(body).not.toMatch(/\bctx\b|\bfetch\b|\bclientFor\b|\bawait\b/);
  });
});

describe('testConnection', () => {
  function connectionCtx(enabledApis: string[]) {
    const fetch: GuardedFetch = vi.fn(async (url, init) => {
      const method = JSON.parse(init.body!).method as string;
      const result = method === 'getApiKeyDetails'
        ? { enabledApis }
        : method === 'getCompanyDetails'
          ? { id: COMPANY, name: 'Example', type: 1 }
          : [];
      return { status: 200, headers: new Headers(), text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result }) };
    });
    return {
      creds: { apiKey: API_KEY },
      baseUrl: 'https://cloud.gravityzone.bitdefender.com/api',
      region: null,
      fetch,
      limiter: { acquire: async () => {} },
      runCache: new Map(),
    } satisfies EdrAdapterContext;
  }

  it('a key without the Packages API carries a note and still connects', async () => {
    const result = await adapter.testConnection(connectionCtx(['network', 'companies', 'incidents', 'quarantine']));
    expect(result).toMatchObject({ ok: true, capabilityNotes: ['packages: API not enabled on key'] });
  });

  it('a key with it carries no note', async () => {
    const result = await adapter.testConnection(connectionCtx(['network', 'companies', 'incidents', 'quarantine', 'packages']));
    expect(result).toMatchObject({ ok: true, capabilityNotes: [] });
  });
});
