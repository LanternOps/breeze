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

import { downloadRoutes } from './download';

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
});
