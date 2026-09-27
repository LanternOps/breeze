import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ============================================================
// Mocks — must appear before any import of the source
// ============================================================

const peekShortCodeMock = vi.fn();
const redeemShortCodeMock = vi.fn();
const anonymousInstallerDistributionAllowedMock = vi.fn<(...args: unknown[]) => Promise<boolean>>();
anonymousInstallerDistributionAllowedMock.mockResolvedValue(true);
const enforcePublicInstallerIpRateLimitMock = vi.fn<(...args: unknown[]) => Promise<Response | null>>();
enforcePublicInstallerIpRateLimitMock.mockResolvedValue(null);
const checkInstallerSignSpendMock = vi.fn<(...args: unknown[]) => Promise<Response | null>>();
checkInstallerSignSpendMock.mockResolvedValue(null);

vi.mock('../../routes/enrollmentKeys', () => ({
  peekShortCode: (...args: unknown[]) => peekShortCodeMock(...args),
  redeemShortCode: (...args: unknown[]) => redeemShortCodeMock(...args),
  anonymousInstallerDistributionAllowed: (...args: unknown[]) =>
    anonymousInstallerDistributionAllowedMock(...args),
  enforcePublicInstallerIpRateLimit: (...args: unknown[]) =>
    enforcePublicInstallerIpRateLimitMock(...args),
  checkInstallerSignSpend: (...args: unknown[]) =>
    checkInstallerSignSpendMock(...args),
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

vi.mock('../../services/installerBuilder', () => ({
  buildWindowsInstallerZip: (...args: unknown[]) => buildWindowsInstallerZipMock(...args),
  buildMacosInstallerZip: (...args: unknown[]) => buildMacosInstallerZipMock(...args),
  fetchRegularMsi: () => fetchRegularMsiMock(),
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
  beforeEach(() => {
    // Realistic default for tests that don't care about the trust-gate
    // lookup itself: a valid, trust-allowed link.
    peekShortCodeMock.mockResolvedValue({ id: 'key-1', orgId: 'org-1', siteId: 'site-1' });
  });

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

  // This route previously built and served a fully credentialed installer
  // with no trust check and no rate limiting — unlike its /s/:code and
  // /public-download siblings. These pin parity.
  it('enforces the per-IP rate limit before building an installer', async () => {
    enforcePublicInstallerIpRateLimitMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Too many requests. Please try again later.' }), {
        status: 429,
      }),
    );
    const res = await buildApp().request('/i/abc1234567/download/win');
    expect(res.status).toBe(429);
    expect(peekShortCodeMock).not.toHaveBeenCalled();
    expect(redeemShortCodeMock).not.toHaveBeenCalled();
  });

  it('denies distribution when the org is not trust-allowed for anonymous installers', async () => {
    anonymousInstallerDistributionAllowedMock.mockResolvedValueOnce(false);
    const res = await buildApp().request('/i/abc1234567/download/win');
    expect(res.status).toBe(404);
    expect(anonymousInstallerDistributionAllowedMock).toHaveBeenCalledWith('org-1', 'invite-landing');
    expect(redeemShortCodeMock).not.toHaveBeenCalled();
  });

  it('rejects when the per-code signing-spend budget is exhausted', async () => {
    checkInstallerSignSpendMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: 'Installer signing rate limit reached for this enrollment link. Try again later.' }),
        { status: 429 },
      ),
    );
    const res = await buildApp().request('/i/abc1234567/download/win');
    expect(res.status).toBe(429);
    expect(checkInstallerSignSpendMock).toHaveBeenCalledWith(expect.anything(), 'abc1234567');
    expect(redeemShortCodeMock).not.toHaveBeenCalled();
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
    // macOS no longer fetches a pkg server-side — install.sh downloads the
    // arch-matched pkg at install time; only the zip is built here.
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
