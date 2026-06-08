import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/s3Storage', () => ({
  isS3Configured: vi.fn(() => false),
  getPresignedUrl: vi.fn(),
}));

vi.mock('../../services/binarySource', () => ({
  getBinarySource: vi.fn(() => 'local'),
  getGithubAgentUrl: vi.fn(),
  getGithubAgentPkgUrl: vi.fn(),
  getGithubHelperUrl: vi.fn(),
  HELPER_FILENAMES: {
    linux: 'breeze-desktop-helper-linux-amd64',
    darwin: 'breeze-desktop-helper-darwin',
    windows: 'breeze-desktop-helper-windows.exe',
  },
}));

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadRoutes } from './download';
import { getBinarySource, getGithubAgentPkgUrl } from '../../services/binarySource';
import { isS3Configured, getPresignedUrl } from '../../services/s3Storage';

describe('public agent binary downloads', () => {
  const originalAgentDir = process.env.AGENT_BINARY_DIR;
  const originalHelperDir = process.env.HELPER_BINARY_DIR;

  beforeEach(() => {
    process.env.AGENT_BINARY_DIR = '/tmp/breeze-secret-agent-binaries';
    process.env.HELPER_BINARY_DIR = '/tmp/breeze-secret-helper-binaries';
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (originalAgentDir === undefined) delete process.env.AGENT_BINARY_DIR;
    else process.env.AGENT_BINARY_DIR = originalAgentDir;
    if (originalHelperDir === undefined) delete process.env.HELPER_BINARY_DIR;
    else process.env.HELPER_BINARY_DIR = originalHelperDir;
    vi.restoreAllMocks();
  });

  it('does not disclose AGENT_BINARY_DIR in public 404 responses', async () => {
    const res = await downloadRoutes.request('/download/linux/amd64');
    const body = await res.text();

    expect(res.status).toBe(404);
    expect(body).not.toContain('/tmp/breeze-secret-agent-binaries');
    expect(body).not.toContain('AGENT_BINARY_DIR');
    expect(console.warn).toHaveBeenCalledWith(
      '[agent-download] Local binary missing',
      { filename: 'breeze-agent-linux-amd64' },
    );
  });

  it('does not disclose HELPER_BINARY_DIR in public 404 responses', async () => {
    const res = await downloadRoutes.request('/download/helper/linux/amd64');
    const body = await res.text();

    expect(res.status).toBe(404);
    expect(body).not.toContain('/tmp/breeze-secret-helper-binaries');
    expect(body).not.toContain('HELPER_BINARY_DIR');
    expect(console.warn).toHaveBeenCalledWith(
      '[helper-download] Local binary missing',
      { filename: 'breeze-desktop-helper-linux-amd64' },
    );
  });

  it('serves the architecture-matched pkg from local disk in non-github mode', async () => {
    // Intel Macs hitting the per-arch pkg endpoint must resolve to the amd64
    // package, not a hardcoded arm64 one (the "Bad CPU type" regression).
    const res = await downloadRoutes.request('/download/darwin/amd64/pkg');
    const body = await res.text();

    expect(res.status).toBe(404);
    expect(body).not.toContain('/tmp/breeze-secret-agent-binaries');
    expect(console.warn).toHaveBeenCalledWith(
      '[pkg-download] Local package missing',
      { filename: 'breeze-agent-darwin-amd64.pkg' },
    );
  });

  it('rejects non-darwin pkg requests', async () => {
    const res = await downloadRoutes.request('/download/linux/amd64/pkg');
    expect(res.status).toBe(400);
  });
});

describe('public agent .pkg downloads — per-arch serving', () => {
  const originalAgentDir = process.env.AGENT_BINARY_DIR;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'breeze-pkg-'));
    process.env.AGENT_BINARY_DIR = tmp;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(getBinarySource).mockReturnValue('local');
    vi.mocked(isS3Configured).mockReturnValue(false);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (originalAgentDir === undefined) delete process.env.AGENT_BINARY_DIR;
    else process.env.AGENT_BINARY_DIR = originalAgentDir;
    vi.restoreAllMocks();
    vi.mocked(getBinarySource).mockReset();
    vi.mocked(isS3Configured).mockReset();
    vi.mocked(getPresignedUrl).mockReset();
    vi.mocked(getGithubAgentPkgUrl).mockReset();
  });

  it('serves amd64 and arm64 as DISTINCT packages (the Bad CPU type regression guard)', async () => {
    // The whole point of the fix: each arch must resolve to its OWN file, never
    // a hardcoded one. Write distinct bodies and prove they come back distinct.
    writeFileSync(join(tmp, 'breeze-agent-darwin-amd64.pkg'), 'AMD64-PKG-BODY');
    writeFileSync(join(tmp, 'breeze-agent-darwin-arm64.pkg'), 'ARM64-PKG-BODY');

    const amd = await downloadRoutes.request('/download/darwin/amd64/pkg');
    const arm = await downloadRoutes.request('/download/darwin/arm64/pkg');

    expect(amd.status).toBe(200);
    expect(arm.status).toBe(200);
    expect(amd.headers.get('content-disposition')).toContain('breeze-agent-darwin-amd64.pkg');
    expect(arm.headers.get('content-disposition')).toContain('breeze-agent-darwin-arm64.pkg');

    const amdBody = await amd.text();
    const armBody = await arm.text();
    expect(amdBody).toBe('AMD64-PKG-BODY');
    expect(armBody).toBe('ARM64-PKG-BODY');
    expect(amdBody).not.toBe(armBody);
  });

  it('redirects to the GitHub release asset in github mode', async () => {
    vi.mocked(getBinarySource).mockReturnValue('github');
    vi.mocked(getGithubAgentPkgUrl).mockReturnValue(
      'https://github.test/breeze-agent-darwin-amd64.pkg',
    );

    const res = await downloadRoutes.request('/download/darwin/amd64/pkg');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://github.test/breeze-agent-darwin-amd64.pkg');
    expect(getGithubAgentPkgUrl).toHaveBeenCalledWith('darwin', 'amd64');
  });

  it('redirects to a presigned S3 URL for the requested arch when S3 is configured', async () => {
    vi.mocked(isS3Configured).mockReturnValue(true);
    vi.mocked(getPresignedUrl).mockResolvedValue('https://s3.test/presigned-arm64');

    const res = await downloadRoutes.request('/download/darwin/arm64/pkg');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://s3.test/presigned-arm64');
    expect(getPresignedUrl).toHaveBeenCalledWith('agent/breeze-agent-darwin-arm64.pkg');
  });

  it('falls back to disk (and warns) when the S3 object is missing', async () => {
    vi.mocked(isS3Configured).mockReturnValue(true);
    vi.mocked(getPresignedUrl).mockRejectedValue(
      Object.assign(new Error('not found'), { name: 'NoSuchKey' }),
    );
    // No file on disk → 404 after fallback; the S3 miss is logged at warn (not error).
    const res = await downloadRoutes.request('/download/darwin/amd64/pkg');

    expect(res.status).toBe(404);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('[pkg-download] S3 presign failed'),
      expect.anything(),
    );
  });
});
