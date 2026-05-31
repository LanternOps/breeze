import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db';
import { devices, elevationRequests } from '../../db/schema';
import { writeAuditEvent } from '../../services/auditEvents';
import { getRedis } from '../../services/redis';
import { rateLimiter } from '../../services/rate-limit';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import { requireAgentRole } from '../../middleware/requireAgentRole';

// PAM Track 3: agent-side endpoint that records UAC consent.exe observations
// as `elevation_requests` rows with flow_type='uac_intercept'. Auth is the
// standard agent bearer token (agentAuthMiddleware, mounted in
// routes/agents/index.ts). The middleware attaches { deviceId, agentId,
// orgId, siteId, role } to ctx.var.agent.

// Body cap: 32 KB. Agent CommandLine fields can be long (multi-arg installer
// invocations) but anything beyond 32 KB is almost certainly junk or abuse.
const ELEVATION_REQUEST_MAX_BODY_BYTES = 32 * 1024;

// Rate limit: 10 req/s per device. UAC prompts are rare in normal use; a
// machine emitting more than this is misbehaving or being flooded. 600 in a
// 60-second window approximates 10/s while smoothing over bursts.
const ELEVATION_REQUEST_RATE_LIMIT = 600;
const ELEVATION_REQUEST_RATE_WINDOW_SECONDS = 60;

export const elevationRequestSchema = z.object({
  subject_username: z.string().min(1).max(255),
  target_executable_path: z.string().min(1).max(4096),
  target_executable_hash: z.string().max(128).optional(),
  target_executable_signer: z.string().max(255).optional(),
  pid: z.number().int().min(0).max(2 ** 32 - 1).optional(),
  parent_image: z.string().max(4096).optional(),
  command_line: z.string().max(8192).optional(),
  observed_at: z.string().datetime({ offset: true }).optional(),
});

export type ElevationRequestPayload = z.infer<typeof elevationRequestSchema>;

export const elevationRequestsRoutes = new Hono();
// Elevation-request ingest is the main agent's job; reject watchdog tokens.
elevationRequestsRoutes.use('*', requireAgentRole);

elevationRequestsRoutes.post(
  '/:id/elevation-requests',
  // Body-size check happens before zod parses, so a 32 MB payload doesn't
  // first consume zod CPU. Hono exposes the raw Request; we read the
  // Content-Length header (the body has not been buffered yet at this
  // point in the middleware chain).
  async (c, next) => {
    const lenHeader = c.req.header('content-length');
    if (lenHeader) {
      const len = Number.parseInt(lenHeader, 10);
      if (Number.isFinite(len) && len > ELEVATION_REQUEST_MAX_BODY_BYTES) {
        return c.json({ error: 'Body too large' }, 413);
      }
    }
    return next();
  },
  zValidator('json', elevationRequestSchema),
  async (c) => {
    const agentId = c.req.param('id');
    const payload = c.req.valid('json');
    const agent = c.get('agent') as
      | { deviceId?: string; orgId?: string; agentId?: string; siteId?: string }
      | undefined;

    // Rate limit per device. Keying on deviceId from the auth context
    // prevents a stolen token from inflating a different device's budget.
    // Fall back to agentId if the middleware didn't populate deviceId
    // (shouldn't happen, but defensive).
    const rateKey = agent?.deviceId ?? agentId;
    const redis = getRedis();
    const rateCheck = await rateLimiter(
      redis,
      `elevation:rate:device:${rateKey}`,
      ELEVATION_REQUEST_RATE_LIMIT,
      ELEVATION_REQUEST_RATE_WINDOW_SECONDS,
    );
    if (!rateCheck.allowed) {
      return c.json(
        {
          error: 'Rate limit exceeded',
          resetAt: rateCheck.resetAt.toISOString(),
        },
        429,
      );
    }

    const [device] = await db
      .select({
        id: devices.id,
        orgId: devices.orgId,
        siteId: devices.siteId,
      })
      .from(devices)
      .where(eq(devices.agentId, agentId))
      .limit(1);

    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const observedAt = payload.observed_at ? new Date(payload.observed_at) : new Date();
    if (Number.isNaN(observedAt.getTime())) {
      return c.json({ error: 'Invalid observed_at' }, 400);
    }

    const clientIp = getTrustedClientIpOrUndefined(c);
    const userAgent = c.req.header('user-agent') ?? null;

    // Reason: synthesized server-side. The agent only sends discovery data;
    // it doesn't get to write arbitrary reason text.
    const reason = `UAC consent UI observed for ${payload.target_executable_path}`;

    try {
      const inserted = await db
        .insert(elevationRequests)
        .values({
          orgId: device.orgId,
          siteId: device.siteId ?? null,
          deviceId: device.id,
          flowType: 'uac_intercept',
          subjectUserId: null,
          subjectUsername: payload.subject_username,
          reason,
          targetExecutablePath: payload.target_executable_path,
          targetExecutableHash: payload.target_executable_hash ?? null,
          targetExecutableSigner: payload.target_executable_signer ?? null,
          status: 'pending',
          requestedAt: observedAt,
          clientIp: clientIp ?? null,
          userAgent,
          metadata: {
            pid: payload.pid,
            parent_image: payload.parent_image,
            command_line: payload.command_line,
          },
        })
        .returning({ id: elevationRequests.id, status: elevationRequests.status });

      const row = inserted[0];
      if (!row) {
        return c.json({ error: 'Insert returned no row' }, 500);
      }

      writeAuditEvent(c, {
        orgId: agent?.orgId ?? device.orgId,
        actorType: 'agent',
        actorId: agent?.agentId ?? agentId,
        action: 'agent.elevation_request.submit',
        resourceType: 'elevation_request',
        resourceId: row.id,
        details: {
          flow_type: 'uac_intercept',
          subject_username: payload.subject_username,
          target_executable_path: payload.target_executable_path,
        },
      });

      return c.json({ id: row.id, status: row.status }, 201);
    } catch (err) {
      console.error(
        `[ElevationRequests] Failed to insert for device=${device.id} org=${device.orgId}:`,
        err,
      );
      return c.json({ error: 'Failed to record elevation request' }, 500);
    }
  },
);
