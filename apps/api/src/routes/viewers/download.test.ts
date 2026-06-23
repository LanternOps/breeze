import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/s3Storage', () => ({
  isS3Configured: vi.fn(() => false),
  getPresignedUrl: vi.fn(),
  isS3NotFound: (err: unknown) => {
    const name = (err as { name?: string }).name;
    return name === 'NotFound' || name === 'NoSuchKey';
  },
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
import { isS3Configured, getPresignedUrl } from '../../services/s3Storage';

describe('public viewer downloads', () => {
  const originalViewerDir = process.env.VIEWER_BINARY_DIR;

  beforeEach(() => {
    process.env.VIEWER_BINARY_DIR = '/tmp/breeze-secret-viewer-binaries';
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (originalViewerDir === undefined) delete process.env.VIEWER_BINARY_DIR;
    else process.env.VIEWER_BINARY_DIR = originalViewerDir;
    vi.mocked(isS3Configured).mockReset();
    vi.mocked(getPresignedUrl).mockReset();
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

  it('returns 500 on a non-NotFound S3 presign error (not a masked 404) (#1808)', async () => {
    vi.mocked(isS3Configured).mockReturnValue(true);
    vi.mocked(getPresignedUrl).mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDenied' }));

    const res = await viewerDownloadRoutes.request('/download/linux');
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain('/tmp/breeze-secret-viewer-binaries');
  });

  it('treats a bare Error as a transport fault and returns 500', async () => {
    vi.mocked(isS3Configured).mockReturnValue(true);
    vi.mocked(getPresignedUrl).mockRejectedValue(new Error('opaque'));

    const res = await viewerDownloadRoutes.request('/download/linux');
    expect(res.status).toBe(500);
  });

  it('falls through to disk on a genuine NotFound S3 error', async () => {
    vi.mocked(isS3Configured).mockReturnValue(true);
    vi.mocked(getPresignedUrl).mockRejectedValue(Object.assign(new Error('missing'), { name: 'NotFound' }));

    // Disk dir is empty, so the fall-through ends in the normal 404 (not a 500).
    const res = await viewerDownloadRoutes.request('/download/linux');
    expect(res.status).toBe(404);
  });
});
