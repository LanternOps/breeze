import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { randomUUID, createHash } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir, unlink, stat, statfs, readdir } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { Readable, Transform } from 'stream';
import { dirname, join } from 'path';
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { devices } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { apiKeyAuthMiddleware, requireApiKeyScope } from '../middleware/apiKeyAuth';
import { getDeviceByAgentWithOrgCheck } from './devices/helpers';
import { sendCommandToAgent, type AgentCommand } from './agentWs';
import { PERMISSIONS } from '../services/permissions';
import { canAccessDeviceSite, resolvePrincipalSitePermissions, type DeviceSitePermissions } from '../services/deviceSiteAccess';

// #6621: staged uploads must never live under os.tmpdir() — the container's
// /tmp is a small tmpfs shared with tsx's compile cache, so a ~34 MB Windows
// agent upload hit ENOSPC. Same class as RECOVERY_MEDIA_WORK_DIR (D7): default
// to a sibling of the durable data dir (PATCH_REPORT_STORAGE_PATH → /data),
// overridable with DEV_PUSH_WORK_DIR. Resolved per request so env changes apply.
function resolveWorkDir(): string {
  const override = process.env.DEV_PUSH_WORK_DIR?.trim();
  if (override) return override;
  const patchReportPath = process.env.PATCH_REPORT_STORAGE_PATH || './data/patch-reports';
  return join(dirname(patchReportPath), 'dev-push');
}

function isEnospc(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOSPC';
}
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

// Files orphaned by a process restart (the token map is in-memory) are swept
// once past the TTL. Best-effort; never blocks a push.
const warnUnlink = (path: string) => (err: NodeJS.ErrnoException) => {
  if (err?.code !== 'ENOENT') console.warn(`[DevPush] failed to remove staged file ${path}:`, err);
};

async function sweepStaleFiles(dir: string): Promise<void> {
  try {
    const names = await readdir(dir);
    const cutoff = Date.now() - 2 * TTL_MS;
    await Promise.all(
      names
        .filter((n) => n.endsWith('.bin'))
        .map(async (n) => {
          const full = join(dir, n);
          const st = await stat(full).catch(() => null);
          if (st && 'mtimeMs' in st && st.mtimeMs < cutoff) await unlink(full).catch(warnUnlink(full));
        }),
    );
  } catch (err) {
    console.warn(`[DevPush] stale-file sweep of ${dir} failed:`, err);
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

async function getDeviceByAgentWithAccess(
  agentId: string,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>,
  permissions: DeviceSitePermissions | undefined,
) {
  const device = await getDeviceByAgentWithOrgCheck(agentId, auth);
  if (!device) return null;

  if (!canAccessDeviceSite(permissions, device.siteId)) {
    return 'SITE_ACCESS_DENIED' as const;
  }

  return device;
}

// Auth middleware that accepts JWT (Authorization: Bearer) or API key (X-API-Key)
async function devPushAuth(c: Context, next: Next) {
  const apiKeyHeader = c.req.header('X-API-Key');
  if (apiKeyHeader) {
    return apiKeyAuthMiddleware(c, async () => {
      await requireApiKeyScope('devices:execute')(c, next);
    });
  }
  return authMiddleware(c, async () => {
    await requireScope('organization', 'partner', 'system')(c, async () => {
      await requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action)(c, async () => {
        await requireMfa()(c, next);
      });
    });
  });
}

// POST /dev/push — upload binary + trigger agent update
devPushRoutes.post('/push', bodyLimit({ maxSize: 150 * 1024 * 1024, onError: (c) => c.json({ error: 'Binary too large (max 150MB)' }, 413) }), devPushAuth, async (c) => {
  // Build auth context from either JWT or API key
  const jwtAuth = c.get('auth') as AuthContext | undefined;
  const apiKey = c.get('apiKey') as { orgId: string; scopes: string[] } | undefined;

  const auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'> = jwtAuth ?? {
    scope: 'organization' as const,
    orgId: apiKey!.orgId,
    accessibleOrgIds: [apiKey!.orgId],
    canAccessOrg: (orgId: string) => orgId === apiKey!.orgId,
  };

  const body = await c.req.parseBody({ all: true });
  const agentId = typeof body.agentId === 'string' ? body.agentId : '';
  const version =
    typeof body.version === 'string' && body.version
      ? body.version
      : `dev-${Math.floor(Date.now() / 1000)}`;
  const file = body.binary;

  const allowedComponents = ['agent', 'desktop-helper', 'user-helper'] as const;
  type Component = (typeof allowedComponents)[number];
  const rawComponent = typeof body.component === 'string' ? body.component : 'agent';
  if (!allowedComponents.includes(rawComponent as Component)) {
    return c.json(
      { error: `invalid component ${rawComponent}; must be one of: ${allowedComponents.join(', ')}` },
      400,
    );
  }
  const component: Component = rawComponent as Component;

  if (!agentId) {
    return c.json({ error: 'agentId is required' }, 400);
  }

  if (!(file instanceof File)) {
    return c.json({ error: 'binary file is required' }, 400);
  }

  if (file.size > MAX_BINARY_SIZE) {
    return c.json({ error: `Binary too large (max ${MAX_BINARY_SIZE / 1024 / 1024}MB)` }, 413);
  }

  // agentId comes from multipart parsing. Authorize before copying the parsed
  // binary into a buffer, writing files, registering a download or dispatching.
  const device = await getDeviceByAgentWithAccess(agentId, auth, resolvePrincipalSitePermissions(c));
  if (device === 'SITE_ACCESS_DENIED') {
    return c.json({ error: 'Access to this site denied' }, 403);
  }
  if (!device) {
    return c.json({ error: 'Device not found or access denied' }, 404);
  }

  // Stage the binary under the work dir (never os.tmpdir()).
  const workDir = resolveWorkDir();
  await mkdir(workDir, { recursive: true });

  // Preflight: fail with a clear 507 instead of a mid-write ENOSPC.
  try {
    const fs = await statfs(workDir);
    const free = Number(fs.bavail) * Number(fs.bsize);
    if (free < file.size) {
      return c.json(
        {
          error:
            `Insufficient space in dev-push staging directory ${workDir}: ` +
            `need ${file.size} bytes, ${free} available. Set DEV_PUSH_WORK_DIR to a larger volume.`,
        },
        507,
      );
    }
  } catch (err) {
    // statfs unsupported/failed: don't block the push; a real ENOSPC is still caught below.
    console.warn(`[DevPush] free-space preflight skipped for ${workDir}:`, err);
  }
  void sweepStaleFiles(workDir);

  const downloadToken = randomUUID();
  const filePath = join(workDir, `${downloadToken}.bin`);

  // Stream to disk (no second in-memory copy), hashing as we go.
  const hash = createHash('sha256');
  const hasher = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(file.stream() as any), hasher, createWriteStream(filePath));
  } catch (err) {
    await unlink(filePath).catch(warnUnlink(filePath));
    if (isEnospc(err)) {
      return c.json({ error: `Ran out of space writing to dev-push staging directory ${workDir}. Set DEV_PUSH_WORK_DIR to a larger volume.` }, 507);
    }
    console.error(`[DevPush] failed staging ${file.size} bytes to ${workDir}:`, err);
    throw err;
  }

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
      component,
    },
  };

  const sent = sendCommandToAgent(device.agentId, command);

  return c.json({
    commandId,
    downloadToken,
    checksum,
    version,
    component,
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
  const agentDevice = await withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({
        id: devices.id,
        agentTokenSuspendedAt: devices.agentTokenSuspendedAt,
      })
      .from(devices)
      .where(
        and(
          eq(devices.agentId, entry.agentId),
          eq(devices.agentTokenHash, tokenHash)
        )
      )
      .limit(1);
    return row;
  });

  if (!agentDevice) {
    return c.json({ error: 'Invalid agent credentials' }, 401);
  }

  // Task 18: auto-suspended tokens fail closed at every auth gate.
  if (agentDevice.agentTokenSuspendedAt) {
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
    const tokenHash = createHash('sha256').update(token).digest('hex').slice(0, 16);
    console.error(`[DevPush] Error streaming binary for tokenHash ${tokenHash}:`, err);
    return c.json({ error: 'Failed to stream binary' }, 500);
  }
});
