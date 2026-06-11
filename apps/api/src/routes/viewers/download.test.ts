import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/s3Storage', () => ({
  isS3Configured: vi.fn(() => false),
  getPresignedUrl: vi.fn(),
}));

vi.mock('../../services/binarySource', () => ({
  getBinarySource: vi.fn(() => 'local'),
  getGithubViewerUrl: vi.fn(),
  VIEWER_FILENAMES: {
    linux: 'Breeze Viewer.AppImage',
    macos: 'Breeze Viewer.dmg',
    windows: 'Breeze Viewer Setup.exe',
  },
}));

import { viewerDownloadRoutes } from './download';

describe('public viewer downloads', () => {
  const originalViewerDir = process.env.VIEWER_BINARY_DIR;

  beforeEach(() => {
    process.env.VIEWER_BINARY_DIR = '/tmp/breeze-secret-viewer-binaries';
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (originalViewerDir === undefined) delete process.env.VIEWER_BINARY_DIR;
    else process.env.VIEWER_BINARY_DIR = originalViewerDir;
    vi.restoreAllMocks();
  });

  it('does not disclose VIEWER_BINARY_DIR in public 404 responses', async () => {
    const res = await viewerDownloadRoutes.request('/download/linux');
    const body = await res.text();

    expect(res.status).toBe(404);
    expect(body).not.toContain('/tmp/breeze-secret-viewer-binaries');
    expect(body).not.toContain('VIEWER_BINARY_DIR');
    expect(console.warn).toHaveBeenCalledWith(
      '[viewer-download] Local installer missing',
      { filename: 'Breeze Viewer.AppImage' },
    );
  });
});
