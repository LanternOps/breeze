import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/s3Storage', () => ({
  isS3Configured: vi.fn(() => false),
  getPresignedUrl: vi.fn(),
  isS3NotFound: () => false,
}));

import { viewerDownloadRoutes } from './download';

// Real binarySource (not mocked): a server-only image redirects Viewer
// downloads to the paired binaries release, which is the only one with Viewer
// installers; a full-release image redirects exactly as before.
describe('viewer download redirect follows the binaries pairing', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.BINARY_SOURCE = 'github';
    for (const name of ['BINARY_VERSION', 'BINARY_GITHUB_REPOSITORY', 'GITHUB_REPO', 'BREEZE_BINARIES_VERSION']) {
      delete process.env[name];
    }
    process.env.BREEZE_VERSION = '0.118.2';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('server-only image: 302 to the paired release', async () => {
    process.env.BREEZE_BINARIES_VERSION = '0.118.0';
    const res = await viewerDownloadRoutes.request('/download/windows');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/releases/download/v0.118.0/');
  });

  it('full-release image (pairing empty): 302 to the server version, unchanged', async () => {
    process.env.BREEZE_BINARIES_VERSION = '';
    const res = await viewerDownloadRoutes.request('/download/windows');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/releases/download/v0.118.2/');
  });
});
