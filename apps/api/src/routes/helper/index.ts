/**
 * Helper Chat Routes
 *
 * REST + SSE endpoints for the Breeze Helper (tray) AI chat.
 * Auth: Agent bearer token (brz_ prefix) via helperAuth middleware.
 * Sessions are scoped to the device (no user ID required).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { streamSSE } from 'hono/streaming';
import { createHash } from 'crypto';
import { eq, and } from 'drizzle-orm';
import { db, withSystemDbAccessContext, withDbAccessContext } from '../../db';
import { aiSessions, aiMessages, devices } from '../../db/schema';
import { streamingSessionManager } from '../../services/streamingSessionManager';
import { buildHelperSystemPrompt } from '../../services/helperAiAgent';
import { getHelperAllowedMcpToolNames, validateHelperToolAccess, type HelperPermissionLevel } from '../../services/helperToolFilter';
import { sanitizeUserMessage } from '../../services/aiInputSanitizer';
import { storeScreenshot } from '../../services/screenshotStorage';
import { checkBudget, getRemainingBudgetUsd } from '../../services/aiCostTracker';
import { getRedis, rateLimiter } from '../../services';
import { createSessionPreToolUse, createSessionPostToolUse } from '../../services/aiAgentSdk';
import type { AuthContext } from '../../middleware/auth';
import type { ActiveSession } from '../../services/streamingSessionManager';

const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const HELPER_RATE_LIMIT = 30;
const HELPER_RATE_WINDOW_SECONDS = 60;
const DEFAULT_PERMISSION_LEVEL: HelperPermissionLevel = 'standard';

export const helperRoutes = new Hono();

// ============================================
// Helper Auth Middleware (agent token based)
// ============================================

interface HelperDevice {
  id: string;
  agentId: string;
  orgId: string;
  siteId: string;
  hostname: string;
  osType: string;
  osVersion: string;
  agentVersion: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    helperDevice: HelperDevice;
  }
}

/**
 * Authenticate helper requests using agent bearer token.
 * Similar to agentAuthMiddleware but sets helperDevice context
 * and creates a synthetic AuthContext for the streaming session manager.
 */
async function helperAuth(c: import('hono').Context, next: import('hono').Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  const token = authHeader.slice(7);
  if (!token.startsWith('brz_')) {
    return c.json({ error: 'Invalid agent token format' }, 401);
  }

  const tokenHash = createHash('sha256').update(token).digest('hex');

  const device = await withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({
        id: devices.id,
        agentId: devices.agentId,
        orgId: devices.orgId,
        siteId: devices.siteId,
        hostname: devices.hostname,
        osType: devices.osType,
        osVersion: devices.osVersion,
        agentVersion: devices.agentVersion,
        agentTokenHash: devices.agentTokenHash,
        status: devices.status,
      })
      .from(devices)
      .where(eq(devices.agentTokenHash, tokenHash))
      .limit(1);
    return row ?? null;
  });

  if (!device) {
    return c.json({ error: 'Invalid agent credentials' }, 401);
  }

  if (device.status === 'decommissioned') {
    return c.json({ error: 'Device has been decommissioned' }, 403);
  }

  if (device.status === 'quarantined') {
    return c.json({ error: 'Device is quarantined pending admin approval' }, 403);
  }

  c.set('helperDevice', {
    id: device.id,
    agentId: device.agentId,
    orgId: device.orgId,
    siteId: device.siteId,
    hostname: device.hostname,
    osType: device.osType,
    osVersion: device.osVersion,
    agentVersion: device.agentVersion,
  });

  // Set a synthetic auth context for the streaming session manager
  // Helper sessions use a synthetic "device" user identity
  const syntheticAuth: AuthContext = {
    user: {
      id: device.id, // Use device ID as the "user" ID for helper sessions
      email: `helper@${device.hostname}`,
      name: device.hostname,
    },
    token: {
      sub: device.id,
      email: `helper@${device.hostname}`,
      roleId: null,
      type: 'access' as const,
      scope: 'organization' as const,
      orgId: device.orgId,
      partnerId: null,
      iat: Math.floor(Date.now() / 1000),
      mfa: false,
    },
    partnerId: null,
    orgId: device.orgId,
    scope: 'organization',
    accessibleOrgIds: [device.orgId],
    orgCondition: (orgIdColumn) => eq(orgIdColumn, device.orgId),
    canAccessOrg: (orgId) => orgId === device.orgId,
  };

  c.set('auth', syntheticAuth);

  await withDbAccessContext(
    {
      scope: 'organization',
      orgId: device.orgId,
      accessibleOrgIds: [device.orgId],
    },
    async () => {
      await next();
    },
  );
}

helperRoutes.use('*', helperAuth);

// ============================================
// Helper Pre-flight Checks
// ============================================

async function runHelperPreFlight(
  sessionId: string,
  content: string,
  device: HelperDevice,
): Promise<
  | { ok: true; session: typeof aiSessions.$inferSelect; sanitizedContent: string; systemPrompt: string; maxBudgetUsd: number | undefined; allowedTools: string[] }
  | { ok: false; error: string; status: number }
> {
  // Fetch session
  const [session] = await db
    .select()
    .from(aiSessions)
    .where(and(eq(aiSessions.id, sessionId), eq(aiSessions.deviceId, device.id)))
    .limit(1);

  if (!session) {
    return { ok: false, error: 'Session not found', status: 404 };
  }

  if (session.status !== 'active') {
    return { ok: false, error: 'Session is not active', status: 400 };
  }

  // Check session expiration
  const sessionAge = Date.now() - new Date(session.createdAt).getTime();
  if (sessionAge > SESSION_MAX_AGE_MS) {
    await db
      .update(aiSessions)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(eq(aiSessions.id, sessionId));
    return { ok: false, error: 'Session has expired. Please start a new session.', status: 410 };
  }

  if (session.turnCount >= session.maxTurns) {
    return { ok: false, error: `Session turn limit reached (${session.maxTurns})`, status: 400 };
  }

  // Rate limit per device
  const redis = getRedis();
  if (redis) {
    const rateKey = `helper_rate:${device.id}`;
    const rateCheck = await rateLimiter(redis, rateKey, HELPER_RATE_LIMIT, HELPER_RATE_WINDOW_SECONDS);
    if (!rateCheck.allowed) {
      return { ok: false, error: 'Rate limit exceeded. Please wait before sending another message.', status: 429 };
    }
  }

  // Budget check
  try {
    const budgetError = await checkBudget(device.orgId);
    if (budgetError) return { ok: false, error: budgetError, status: 402 };
  } catch (err) {
    console.error('[Helper] Budget check failed:', err);
    return { ok: false, error: 'Unable to verify budget.', status: 500 };
  }

  // Sanitize input
  const { sanitized: sanitizedContent, flags } = sanitizeUserMessage(content);
  if (flags.length > 0) {
    console.warn('[Helper] Input sanitization flags:', flags, 'session:', sessionId);
  }

  // Permission level from session context or default
  const permissionLevel: HelperPermissionLevel =
    (session.contextSnapshot as Record<string, unknown> | null)?.permissionLevel as HelperPermissionLevel
    ?? DEFAULT_PERMISSION_LEVEL;

  const systemPrompt = session.systemPrompt ?? buildHelperSystemPrompt({
    hostname: device.hostname,
    deviceId: device.id,
    orgId: device.orgId,
    permissionLevel,
    osType: device.osType,
    osVersion: device.osVersion,
    agentVersion: device.agentVersion,
  });

  const allowedTools = getHelperAllowedMcpToolNames(permissionLevel);

  let maxBudgetUsd: number | undefined;
  try {
    const remaining = await getRemainingBudgetUsd(device.orgId);
    if (remaining !== null) maxBudgetUsd = remaining;
  } catch {
    // Non-fatal
  }

  return { ok: true, session, sanitizedContent, systemPrompt, maxBudgetUsd, allowedTools };
}

// ============================================
// Session Title Generator
// ============================================

function generateSessionTitle(content: string): string {
  const cleaned = content.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 80) return cleaned;
  const truncated = cleaned.slice(0, 80);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated) + '…';
}

// ============================================
// POST /chat/sessions — Create helper AI session
// ============================================

helperRoutes.post(
  '/chat/sessions',
  zValidator('json', z.object({
    permissionLevel: z.enum(['basic', 'standard', 'extended']).optional(),
  }).optional()),
  async (c) => {
    const device = c.get('helperDevice');
    const body = c.req.valid('json') ?? {};
    const permissionLevel: HelperPermissionLevel = body.permissionLevel ?? DEFAULT_PERMISSION_LEVEL;

    const systemPrompt = buildHelperSystemPrompt({
      hostname: device.hostname,
      deviceId: device.id,
      orgId: device.orgId,
      permissionLevel,
      osType: device.osType,
      osVersion: device.osVersion,
      agentVersion: device.agentVersion,
    });

    const [session] = await db
      .insert(aiSessions)
      .values({
        orgId: device.orgId,
        userId: null,
        deviceId: device.id,
        model: 'claude-sonnet-4-5-20250929',
        systemPrompt,
        contextSnapshot: {
          permissionLevel,
          deviceId: device.id,
          hostname: device.hostname,
          osType: device.osType,
          source: 'helper',
        },
      })
      .returning();

    if (!session) {
      return c.json({ error: 'Failed to create session' }, 500);
    }

    return c.json({ id: session.id, orgId: device.orgId }, 201);
  },
);

// ============================================
// POST /chat/sessions/:id/messages — Send message + SSE stream
// ============================================

helperRoutes.post(
  '/chat/sessions/:id/messages',
  zValidator('json', z.object({
    content: z.string().min(1).max(10000),
  })),
  async (c) => {
    const device = c.get('helperDevice');
    const auth = c.get('auth');
    const sessionId = c.req.param('id');
    const { content } = c.req.valid('json');

    // Pre-flight checks
    const preflight = await runHelperPreFlight(sessionId, content, device);
    if (!preflight.ok) {
      return c.json({ error: preflight.error }, preflight.status as 400);
    }

    const { session: dbSession, sanitizedContent, systemPrompt, maxBudgetUsd, allowedTools } = preflight;

    // Get or create streaming session
    const activeSession = await streamingSessionManager.getOrCreate(
      sessionId,
      {
        orgId: dbSession.orgId,
        sdkSessionId: dbSession.sdkSessionId,
        model: dbSession.model,
        maxTurns: dbSession.maxTurns,
        turnCount: dbSession.turnCount,
        systemPrompt: dbSession.systemPrompt,
      },
      auth,
      c,
      systemPrompt,
      maxBudgetUsd,
      allowedTools,
    );

    // Concurrent message guard
    if (!streamingSessionManager.tryTransitionToProcessing(activeSession)) {
      return c.json({ error: 'A message is already being processed for this session' }, 409);
    }

    // Save user message
    try {
      await db.insert(aiMessages).values({
        sessionId,
        role: 'user',
        content: sanitizedContent,
      });
    } catch (err) {
      console.error('[Helper] Failed to save user message:', err);
      activeSession.state = 'idle';
      return c.json({ error: 'Failed to save message' }, 500);
    }

    // Auto-generate title from first message
    if (!dbSession.title) {
      const title = generateSessionTitle(sanitizedContent);
      try {
        await db
          .update(aiSessions)
          .set({ title })
          .where(eq(aiSessions.id, sessionId));
        activeSession.eventBus.publish({ type: 'title_updated', title });
      } catch (err) {
        console.error('[Helper] Failed to auto-set session title:', err);
      }
    }

    // Push message and start timeout
    activeSession.inputController.pushMessage(sanitizedContent);
    streamingSessionManager.startTurnTimeout(activeSession);

    const subscriptionId = crypto.randomUUID();

    return streamSSE(c, async (stream) => {
      const events = activeSession.eventBus.subscribe(subscriptionId);

      try {
        for await (const event of events) {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          });
          if (event.type === 'done') break;
        }
      } catch (err) {
        console.error('[Helper] Stream error:', err);
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            type: 'error',
            message: err instanceof Error ? err.message : 'Stream failed',
          }),
        });
      } finally {
        activeSession.eventBus.unsubscribe(subscriptionId);
      }
    });
  },
);

// ============================================
// GET /config — Return helper configuration
// ============================================

helperRoutes.get('/config', async (c) => {
  const device = c.get('helperDevice');

  return c.json({
    enabled: true,
    permissionLevel: DEFAULT_PERMISSION_LEVEL,
    allowScreenCapture: true,
    sessionRetentionHours: 24,
  });
});

// ============================================
// POST /screenshots — Upload helper screenshot
// ============================================

helperRoutes.post(
  '/screenshots',
  zValidator('json', z.object({
    imageBase64: z.string().max(2_000_000),
    width: z.number().int().min(1).max(10000),
    height: z.number().int().min(1).max(10000),
    sessionId: z.string().uuid().optional(),
    reason: z.string().max(200).optional(),
  })),
  async (c) => {
    const device = c.get('helperDevice');
    const { imageBase64, width, height, sessionId, reason } = c.req.valid('json');

    const stored = await storeScreenshot({
      deviceId: device.id,
      orgId: device.orgId,
      sessionId,
      imageBase64,
      width,
      height,
      capturedBy: 'helper',
      reason,
      retentionHours: 24,
    });

    return c.json({
      id: stored.id,
      storageKey: stored.storageKey,
      sizeBytes: stored.sizeBytes,
      expiresAt: stored.expiresAt,
    });
  },
);

// ============================================
// DELETE /chat/sessions/:id — Close session
// ============================================

helperRoutes.delete('/chat/sessions/:id', async (c) => {
  const device = c.get('helperDevice');
  const sessionId = c.req.param('id');

  const [session] = await db
    .select()
    .from(aiSessions)
    .where(and(eq(aiSessions.id, sessionId), eq(aiSessions.deviceId, device.id)))
    .limit(1);

  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  await db
    .update(aiSessions)
    .set({ status: 'closed', updatedAt: new Date() })
    .where(eq(aiSessions.id, sessionId));

  streamingSessionManager.remove(sessionId);

  return c.json({ success: true });
});
