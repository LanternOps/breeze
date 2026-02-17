import { Hono } from 'hono';
import { randomUUID, createHash } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir, unlink, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { devices } from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';
import { getDeviceWithOrgCheck } from './devices/helpers';
import { sendCommandToAgent, type AgentCommand } from './agentWs';

const TEMP_DIR = join(tmpdir(), 'breeze-dev-push');
const TTL_MS = 5 * 60 * 1000; // 5 minutes

// In-memory map: token → { filePath, timer, agentId }
const pendingDownloads = new Map<
  string,
  { filePath: string; timer: ReturnType<typeof setTimeout>; agentId: string }
>();

function cleanupDownload(token: string) {
  const entry = pendingDownloads.get(token);
  if (entry) {
    clearTimeout(entry.timer);
    unlink(entry.filePath).catch((err) => {
      if (err.code !== 'ENOENT') {
        console.error(`[DevPush] Failed to clean up temp file ${entry.filePath}:`, err);
      }
    });
    pendingDownloads.delete(token);
  }
}

function resolveDownloadBaseUrl(): string | null {
  const raw = process.env.PUBLIC_API_URL || process.env.BREEZE_SERVER;
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

export const devPushRoutes = new Hono();

// Guard: only in non-production or when explicitly enabled
devPushRoutes.use('*', async (c, next) => {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const devPushEnabled = process.env.DEV_PUSH_ENABLED === 'true';

  if (nodeEnv === 'production' && !devPushEnabled) {
    return c.json({ error: 'Dev push is disabled in production' }, 403);
  }
  await next();
});

const MAX_BINARY_SIZE = 100 * 1024 * 1024; // 100MB

// POST /dev/push — upload binary + trigger agent update
devPushRoutes.post('/push', authMiddleware, requireScope('organization', 'partner', 'system'), async (c) => {
  const auth = c.get('auth');

  const body = await c.req.parseBody({ all: true });
  const agentId = typeof body.agentId === 'string' ? body.agentId : '';
  const version =
    typeof body.version === 'string' && body.version
      ? body.version
      : `dev-${Math.floor(Date.now() / 1000)}`;
  const file = body.binary;

  if (!agentId) {
    return c.json({ error: 'agentId is required' }, 400);
  }

  if (!(file instanceof File)) {
    return c.json({ error: 'binary file is required' }, 400);
  }

  if (file.size > MAX_BINARY_SIZE) {
    return c.json({ error: `Binary too large (max ${MAX_BINARY_SIZE / 1024 / 1024}MB)` }, 413);
  }

  // Verify device access
  const device = await getDeviceWithOrgCheck(agentId, auth);
  if (!device) {
    return c.json({ error: 'Device not found or access denied' }, 404);
  }

  // Save binary to temp dir
  await mkdir(TEMP_DIR, { recursive: true });
  const downloadToken = randomUUID();
  const filePath = join(TEMP_DIR, `${downloadToken}.bin`);

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Write file and compute checksum
  const writeStream = createWriteStream(filePath);
  const hash = createHash('sha256');

  await new Promise<void>((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
    hash.update(buffer);
    writeStream.end(buffer);
  });

  const checksum = hash.digest('hex');

  // Register ephemeral download with TTL auto-cleanup
  const timer = setTimeout(() => cleanupDownload(downloadToken), TTL_MS);
  pendingDownloads.set(downloadToken, { filePath, timer, agentId: device.agentId });

  // Build download URL from configured canonical origin (not request headers).
  const downloadBaseUrl = resolveDownloadBaseUrl();
  if (!downloadBaseUrl) {
    cleanupDownload(downloadToken);
    return c.json({ error: 'PUBLIC_API_URL or BREEZE_SERVER must be set for dev push' }, 500);
  }
  const downloadUrl = `${downloadBaseUrl}/api/v1/dev/push/download/${downloadToken}`;

  // Send dev_update command to agent via WebSocket
  const commandId = `dev-push-${downloadToken}`;
  const command: AgentCommand = {
    id: commandId,
    type: 'dev_update',
    payload: {
      downloadUrl,
      checksum,
      version,
    },
  };

  const sent = sendCommandToAgent(device.agentId, command);

  return c.json({
    commandId,
    downloadToken,
    checksum,
    version,
    agentId: device.agentId,
    deviceId: device.id,
    wsSent: sent,
    downloadUrl,
  });
});

// GET /dev/push/download/:token — agent downloads the binary
devPushRoutes.get('/push/download/:token', async (c) => {
  const token = c.req.param('token');
  const entry = pendingDownloads.get(token);

  if (!entry) {
    return c.json({ error: 'Download token not found or expired' }, 404);
  }

  // Verify agent bearer token matches the target device
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Authorization required' }, 401);
  }
  const bearerToken = authHeader.slice(7).trim();
  if (!bearerToken) {
    return c.json({ error: 'Authorization required' }, 401);
  }

  const tokenHash = createHash('sha256').update(bearerToken).digest('hex');
  const [agentDevice] = await db
    .select({ id: devices.id })
    .from(devices)
    .where(
      and(
        eq(devices.agentId, entry.agentId),
        eq(devices.agentTokenHash, tokenHash)
      )
    )
    .limit(1);

  if (!agentDevice) {
    return c.json({ error: 'Invalid agent credentials' }, 401);
  }

  // Stream the file
  try {
    const fileStats = await stat(entry.filePath);
    const stream = createReadStream(entry.filePath);

    // Clean up after download
    stream.on('end', () => {
      cleanupDownload(token);
    });

    return new Response(stream as unknown as ReadableStream, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileStats.size.toString(),
        'Content-Disposition': 'attachment; filename="breeze-agent"',
      },
    });
  } catch (err: any) {
    cleanupDownload(token);
    if (err?.code === 'ENOENT') {
      return c.json({ error: 'Binary file not found' }, 404);
    }
    console.error(`[DevPush] Error streaming binary for token ${token}:`, err);
    return c.json({ error: 'Failed to stream binary' }, 500);
  }
});
