import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ============================================================
// Mocks — must appear before any import of the source
// ============================================================

const peekShortCodeMock = vi.fn();
const redeemShortCodeMock = vi.fn();

vi.mock('../../routes/enrollmentKeys', () => ({
  peekShortCode: (...args: unknown[]) => peekShortCodeMock(...args),
  redeemShortCode: (...args: unknown[]) => redeemShortCodeMock(...args),
}));

const updateWhereMock = vi.fn().mockResolvedValue(undefined);
const updateSetMock = vi.fn().mockReturnValue({ where: updateWhereMock });
const dbUpdateMock = vi.fn().mockReturnValue({ set: updateSetMock });
const withSystemDbAccessContextMock = vi.fn(
  async (fn: () => Promise<unknown>) => fn(),
);

vi.mock('../../db', () => ({
  db: {
    update: (...args: unknown[]) => dbUpdateMock(...args),
  },
  withSystemDbAccessContext: (fn: () => Promise<unknown>) =>
    withSystemDbAccessContextMock(fn),
}));

vi.mock('../../db/schema', () => ({
  deploymentInvites: {
    enrollmentKeyId: 'deploymentInvites.enrollmentKeyId',
    status: 'deploymentInvites.status',
    clickedAt: 'deploymentInvites.clickedAt',
  },
}));

const buildWindowsInstallerZipMock = vi.fn(async (..._args: unknown[]) => Buffer.from('windows-zip'));
const buildMacosInstallerZipMock = vi.fn(async (..._args: unknown[]) => Buffer.from('macos-zip'));
const fetchRegularMsiMock = vi.fn(async () => Buffer.from('fake-msi'));
const fetchMacosPkgMock = vi.fn(async () => Buffer.from('fake-pkg'));

vi.mock('../../services/installerBuilder', () => ({
  buildWindowsInstallerZip: (...args: unknown[]) => buildWindowsInstallerZipMock(...args),
  buildMacosInstallerZip: (...args: unknown[]) => buildMacosInstallerZipMock(...args),
  fetchRegularMsi: () => fetchRegularMsiMock(),
  fetchMacosPkg: () => fetchMacosPkgMock(),
}));

// ============================================================
// Import after mocks
// ============================================================
import { mountInviteLandingRoutes } from './inviteLandingRoutes';

function buildApp(): Hono {
  const app = new Hono();
  mountInviteLandingRoutes(app);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PUBLIC_API_URL = 'https://api.example.com';
  process.env.AGENT_ENROLLMENT_SECRET = '';
});

describe('GET /i/:shortCode (landing page)', () => {
  it('returns 404 for an unknown short code', async () => {
    peekShortCodeMock.mockResolvedValue(null);
    const res = await buildApp().request('/i/unknowncode');
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toMatch(/invalid|already been used/i);
  });

  it('returns HTML with Download for Windows on Windows UA', async () => {
    peekShortCodeMock.mockResolvedValue({
      id: 'key-1',
      orgId: 'org-1',
      siteId: 'site-1',
    });
    const res = await buildApp().request('/i/abc1234567', {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('Download for Windows');
    expect(html).toContain('/i/abc1234567/download/win');
  });

  it('returns Download for macOS on Mac UA', async () => {
    peekShortCodeMock.mockResolvedValue({ id: 'key-1', orgId: 'org-1', siteId: 'site-1' });
    const res = await buildApp().request('/i/abc1234567', {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605 Safari/605',
      },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Download for macOS');
    expect(html).toContain('/i/abc1234567/download/mac');
  });

  it('returns Download for Linux on Linux UA', async () => {
    peekShortCodeMock.mockResolvedValue({ id: 'key-1', orgId: 'org-1', siteId: 'site-1' });
    const res = await buildApp().request('/i/abc1234567', {
      headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Firefox/120' },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Download for Linux');
    expect(html).toContain('/i/abc1234567/download/linux');
  });

  it('defaults to Windows when UA is missing or unknown', async () => {
    peekShortCodeMock.mockResolvedValue({ id: 'key-1', orgId: 'org-1', siteId: 'site-1' });
    const res = await buildApp().request('/i/abc1234567');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Download for Windows');
  });

  it('marks deployment_invites.clickedAt on valid code', async () => {
    peekShortCodeMock.mockResolvedValue({ id: 'key-42', orgId: 'org-1', siteId: 'site-1' });
    await buildApp().request('/i/abc1234567', {
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh)' },
    });
    expect(dbUpdateMock).toHaveBeenCalledTimes(1);
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'clicked', clickedAt: expect.any(Date) }),
    );
    expect(updateWhereMock).toHaveBeenCalledTimes(1);
    // The update must run inside the system DB context or RLS silently
    // drops the update on this unauth route.
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
  });

  it('still renders HTML even if the invite-click update throws', async () => {
    peekShortCodeMock.mockResolvedValue({ id: 'key-1', orgId: 'org-1', siteId: 'site-1' });
    updateWhereMock.mockRejectedValueOnce(new Error('boom'));
    const res = await buildApp().request('/i/abc1234567', {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0)' },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Download for Windows');
    // Restore default for subsequent tests in the same suite.
    updateWhereMock.mockResolvedValue(undefined);
  });
});

describe('GET /i/:shortCode/download/:os', () => {
  it('rejects an unsupported OS param with 400', async () => {
    const res = await buildApp().request('/i/abc1234567/download/bsd');
    expect(res.status).toBe(400);
    expect(redeemShortCodeMock).not.toHaveBeenCalled();
  });

  it('returns 501 for Linux (no pre-built installer)', async () => {
    const res = await buildApp().request('/i/abc1234567/download/linux');
    expect(res.status).toBe(501);
    expect(redeemShortCodeMock).not.toHaveBeenCalled();
  });

  it('returns 404 when redeemShortCode fails', async () => {
    redeemShortCodeMock.mockResolvedValue(null);
    const res = await buildApp().request('/i/badcode/download/win');
    expect(res.status).toBe(404);
  });

  it('serves a Windows zip with enrollment baked in', async () => {
    redeemShortCodeMock.mockResolvedValue({
      id: 'child-1',
      parentId: 'parent-1',
      orgId: 'org-1',
      siteId: 'site-1',
      rawKey: 'raw-token-xyz',
      keySecretHash: null,
    });
    const res = await buildApp().request('/i/abc1234567/download/win');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toContain('breeze-agent-windows.zip');
    expect(fetchRegularMsiMock).toHaveBeenCalledTimes(1);
    expect(buildWindowsInstallerZipMock).toHaveBeenCalledTimes(1);
    const [, values] = buildWindowsInstallerZipMock.mock.calls[0]!;
    expect(values).toMatchObject({
      serverUrl: 'https://api.example.com',
      enrollmentKey: 'raw-token-xyz',
      siteId: 'site-1',
    });
  });

  it('serves a macOS zip', async () => {
    redeemShortCodeMock.mockResolvedValue({
      id: 'child-1',
      parentId: 'parent-1',
      orgId: 'org-1',
      siteId: 'site-1',
      rawKey: 'raw-token-xyz',
      keySecretHash: null,
    });
    const res = await buildApp().request('/i/abc1234567/download/mac');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('breeze-agent-macos.zip');
    expect(fetchMacosPkgMock).toHaveBeenCalledTimes(1);
    expect(buildMacosInstallerZipMock).toHaveBeenCalledTimes(1);
  });

  it('returns 500 if PUBLIC_API_URL is not set', async () => {
    delete process.env.PUBLIC_API_URL;
    delete process.env.API_URL;
    redeemShortCodeMock.mockResolvedValue({
      id: 'child-1',
      parentId: 'parent-1',
      orgId: 'org-1',
      siteId: 'site-1',
      rawKey: 'raw-token-xyz',
      keySecretHash: null,
    });
    const res = await buildApp().request('/i/abc1234567/download/win');
    expect(res.status).toBe(500);
  });

  it('returns 500 if the installer build throws', async () => {
    redeemShortCodeMock.mockResolvedValue({
      id: 'child-1',
      parentId: 'parent-1',
      orgId: 'org-1',
      siteId: 'site-1',
      rawKey: 'raw-token-xyz',
      keySecretHash: null,
    });
    buildWindowsInstallerZipMock.mockRejectedValueOnce(new Error('archive failed'));
    const res = await buildApp().request('/i/abc1234567/download/win');
    expect(res.status).toBe(500);
  });
});
