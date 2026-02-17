import { Hono } from 'hono';
import { statSync, createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { isS3Configured, getPresignedUrl } from '../../services/s3Storage';
import { getBinarySource, getGithubViewerUrl, VIEWER_FILENAMES } from '../../services/binarySource';

export const viewerDownloadRoutes = new Hono();

const VALID_PLATFORMS = new Set(Object.keys(VIEWER_FILENAMES));

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

  const filename = VIEWER_FILENAMES[platform]!;

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
      const errName = (err as { name?: string }).name;
      const isNotFound = errName === 'NotFound' || errName === 'NoSuchKey';
      const level = isNotFound ? 'warn' : 'error';
      console[level](`[viewer-download] S3 presign failed for ${filename}, falling back to disk:`, err);
    }
  }

  // Local mode: serve from disk
  const viewerDir = resolve(process.env.VIEWER_BINARY_DIR || './viewer/bin');
  const filePath = join(viewerDir, filename);

  let fileStat: ReturnType<typeof statSync>;
  let stream: ReturnType<typeof createReadStream>;
  try {
    fileStat = statSync(filePath);
    stream = createReadStream(filePath);
  } catch (err) {
    const isNotFound = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!isNotFound) {
      console.error(`[viewer-download] Failed to read installer ${filename}:`, err);
      return c.json({ error: 'Internal server error', message: 'Failed to read installer file' }, 500);
    }
    return c.json(
      {
        error: 'Installer not found',
        message: `Viewer installer "${filename}" is not available. Ensure the installer has been built and placed in the configured VIEWER_BINARY_DIR (${viewerDir}).`,
      },
      404
    );
  }

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
        console.error(`[viewer-download] Stream error while serving ${filename}:`, err);
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
      'Content-Length': String(fileStat.size),
      'Cache-Control': 'no-cache',
    },
  });
});
