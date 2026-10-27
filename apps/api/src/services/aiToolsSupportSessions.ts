/**
 * `manage_support_sessions` (full-control W13, #6783, PR B): the AI twin of the
 * Quick Support routes (routes/remote/supportSessions.ts) for reading and
 * ending sessions.
 *
 *  - `list` / `get` (t1): the caller's own partner's sessions, as an explicit
 *    projection — no `codeHash`, no `claimedFromIp`; the attribution label is
 *    fenced (W13-D8, quorum QW7).
 *  - `end` (supervised, quorum QW2): `endSupportSession` sends the temporary
 *    client its self-destruct command, clears its credential hashes and
 *    decommissions the device — irreversible on a customer machine. Agent
 *    proposals are allowed (an approved end only removes access).
 *  - `create` is NOT built (W13-D14): its one-time join code (and the
 *    landing URL that embeds it) would reach the model context, the transcript
 *    and the intent result; the sealed-reveal carrier
 *    (actionIntents/secretBearingTools.ts) only knows temporary passwords
 *    today. Technicians start sessions in the web app.
 *
 * Scope (W13-D8, quorum QW6): REST relies on RLS (the hidden Quick Support org
 * hangs off the partner) and `end` runs in a system context, so the tool adds
 * an app-layer partner predicate and refuses non-partner scope and every site-
 * or device-restricted session.
 */
import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { devices, organizations, remoteSessions, supportSessions } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { mfaGatedToolError } from './aiToolMfaGate';
import { endSupportSession } from './quickSupportEnd';
import { SUPPORT_SESSION_ACTIONS } from './aiToolSchemasDeviceOps';
import { auditToolWrite, bounded, clampLimit, json, jsonError, notFound, thrown } from './aiToolsSoftwareShared';

type Action = (typeof SUPPORT_SESSION_ACTIONS)[number];
type SessionRow = typeof supportSessions.$inferSelect;

const LIVE_REMOTE_STATUSES = ['pending', 'connecting', 'active'] as const;

function scopeDenied(auth: AuthContext): string | null {
  if (auth.scope !== 'partner' && auth.scope !== 'system') {
    return jsonError('Quick Support requires partner scope', 'ACCESS_DENIED');
  }
  if (auth.allowedSiteIds !== undefined || auth.allowedDeviceIds !== undefined) {
    return jsonError('Quick Support sessions belong to no site; a site- or device-restricted session cannot use them', 'ACCESS_DENIED');
  }
  return null;
}

/** App-layer partner predicate (REST relies on RLS alone). System scope: unrestricted, as REST. */
function partnerCondition(auth: AuthContext): SQL | undefined {
  return auth.scope === 'system' ? undefined : eq(organizations.partnerId, auth.partnerId ?? '00000000-0000-0000-0000-000000000000');
}

async function loadSessions(auth: AuthContext, where: SQL | undefined, limit: number): Promise<SessionRow[]> {
  const conditions = [partnerCondition(auth), where].filter((c): c is SQL => c !== undefined);
  const rows = await db
    .select({ session: supportSessions })
    .from(supportSessions)
    .innerJoin(organizations, eq(organizations.id, supportSessions.orgId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(supportSessions.createdAt))
    .limit(limit);
  return rows.map((r) => r.session);
}

/** Same derivation as the route's toView, as an explicit projection (no code hash, no claiming IP). */
async function views(sessions: SessionRow[]) {
  const probeable = sessions.filter((s) => s.deviceId && (s.status === 'ready' || s.status === 'claimed'));
  const deviceIds = [...new Set(probeable.map((s) => s.deviceId!))];
  const online = new Set<string>();
  const live = new Set<string>();
  if (deviceIds.length > 0) {
    for (const row of await db.select({ id: devices.id, status: devices.status }).from(devices).where(inArray(devices.id, deviceIds))) {
      if (row.status === 'online') online.add(row.id);
    }
    for (const row of await db.select({ deviceId: remoteSessions.deviceId }).from(remoteSessions)
      .where(and(inArray(remoteSessions.deviceId, deviceIds), inArray(remoteSessions.status, [...LIVE_REMOTE_STATUSES])))) {
      live.add(row.deviceId);
    }
  }
  return sessions.map((s) => ({
    id: s.id,
    status: s.status === 'ready' && s.deviceId && live.has(s.deviceId) ? 'active' : s.status,
    deviceId: s.deviceId,
    deviceOnline: !!s.deviceId && online.has(s.deviceId),
    attributedOrgId: s.attributedOrgId,
    attributionLabel: s.attributionLabel,
    createdAt: s.createdAt,
    codeExpiresAt: s.codeExpiresAt,
    hardExpiresAt: s.hardExpiresAt,
    claimedAt: s.claimedAt,
    endedAt: s.endedAt,
    endedReason: s.endedReason,
  }));
}

export function registerSupportSessionTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('manage_support_sessions', {
    tier: 1,
    domain: 'devices',
    searchHint: 'Quick Support sessions (temporary remote-support clients): list, check, end',
    definition: {
      name: 'manage_support_sessions',
      description: 'Actions: list, get, end Quick Support sessions. end removes the temporary client from the person\'s machine and needs approval. Start a session in the web app.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...SUPPORT_SESSION_ACTIONS], description: 'The action to perform' },
          sessionId: { type: 'string', description: 'get / end: support session UUID' },
          limit: { type: 'number', description: 'Max sessions, list only (default 50, max 100)' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      const action = input.action as Action;
      if (!SUPPORT_SESSION_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      const denied = scopeDenied(auth);
      if (denied) return denied;
      try {
        if (action === 'list') {
          const rows = await loadSessions(auth, undefined, clampLimit(input.limit, 50, 100));
          return bounded({ sessions: await views(rows) });
        }
        if (typeof input.sessionId !== 'string') return jsonError('sessionId is required', 'VALIDATION_ERROR');
        const [session] = await loadSessions(auth, eq(supportSessions.id, input.sessionId), 1);
        if (!session) return notFound('Support session');
        if (action === 'get') return bounded({ session: (await views([session]))[0] });

        const mfa = mfaGatedToolError('manage_support_sessions', action, auth);
        if (mfa) return mfa;
        if (session.status === 'ended' || session.status === 'expired') {
          return jsonError('Support session already ended', 'CONFLICT');
        }
        const result = await endSupportSession(session.id, 'tech');
        auditToolWrite(auth, {
          orgId: session.orgId,
          action: 'support_session_ended',
          resourceType: 'remote_session',
          resourceId: session.id,
          details: {
            sessionId: session.id, reason: 'tech',
            agentDisconnect: result.disconnect, commandDelivered: result.commandDelivered,
          },
        });
        return json({
          ended: result.ended, sessionId: session.id, commandDelivered: result.commandDelivered,
          ...(result.commandDelivered ? {} : { note: 'The client was offline; it removes itself when its session timer runs out.' }),
        });
      } catch (error) {
        return thrown('manage_support_sessions', error);
      }
    },
  });
}
