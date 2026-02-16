import { Hono } from 'hono';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { isS3Configured, getPresignedUrl } from '../../services/s3Storage';
import { getBinarySource, getGithubViewerUrl } from '../../services/binarySource';

export const viewerDownloadRoutes = new Hono();

const VALID_PLATFORMS = new Set(['macos', 'windows', 'linux']);

const PLATFORM_FILES: Record<string, string> = {
  macos: 'breeze-viewer-macos.dmg',
  windows: 'breeze-viewer-windows.msi',
  linux: 'breeze-viewer-linux.AppImage',
};

viewerDownloadRoutes.get('/download/:platform', async (c) => {
  const platform = c.req.param('platform');

  if (!VALID_PLATFORMS.has(platform)) {
    return c.json(
      {
        error: 'Invalid platform',
        message: `Supported values: macos, windows, linux. Got: ${platform}`,
      },
      400
    );
  }

  const filename = PLATFORM_FILES[platform]!;

  // GitHub redirect mode — no local binaries needed
  if (getBinarySource() === 'github') {
    return c.redirect(getGithubViewerUrl(platform), 302);
  }

  // Local mode: try S3 presigned redirect first (bandwidth offload)
  if (isS3Configured()) {
    try {
      const s3Key = `viewer/${filename}`;
      const url = await getPresignedUrl(s3Key);
      return c.redirect(url, 302);
    } catch (err) {
      console.error(`[viewer-download] S3 presign failed for ${filename}, falling back to disk:`, err);
    }
  }

  // Local mode: serve from disk
  const viewerDir = resolve(process.env.VIEWER_BINARY_DIR || './viewer/bin');
  const filePath = join(viewerDir, filename);

  if (!existsSync(filePath)) {
    return c.json(
      {
        error: 'Installer not found',
        message: `Viewer installer "${filename}" is not available. Ensure the installer has been built and placed in the configured VIEWER_BINARY_DIR (${viewerDir}).`,
      },
      404
    );
  }

  const stat = statSync(filePath);
  const stream = createReadStream(filePath);

  const webStream = new ReadableStream({
    start(controller) {
      stream.on('data', (chunk: string | Buffer) => {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        controller.enqueue(new Uint8Array(bytes));
      });
      stream.on('end', () => {
        controller.close();
      });
      stream.on('error', (err) => {
        controller.error(err);
      });
    },
    cancel() {
      stream.destroy();
    },
  });

  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(stat.size),
      'Cache-Control': 'no-cache',
    },
  });
});
