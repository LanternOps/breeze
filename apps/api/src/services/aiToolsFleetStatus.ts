/**
 * AI Fleet Status Tool
 *
 * get_fleet_status (Tier 1): Returns per-tenant device/invite funnel metrics
 * for the MCP bootstrap flow. The agent polls this during a deployment so it
 * can report "3 of 5 devices online so far" back to the user.
 *
 * The response shape is intentionally minimal and bootstrap-focused: it does
 * not overlap with `get_fleet_health` (reliability scoring) or `query_devices`
 * (general search). It's the companion read tool for `send_deployment_invites`.
 *
 * Scoped by partner via the authed API key. Readonly-scope keys can call it
 * (it's a Tier 1 read tool), so a pre-payment tenant can still see an empty
 * funnel snapshot. Task 6.2 of the MCP bootstrap plan.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { deploymentInvites } from '../db/schema/deploymentInvites';
import { devices } from '../db/schema/devices';
import type { AuthContext } from '../middleware/auth';
import type { AiTool, AiToolTier } from './aiTools';

export interface InviteFunnel {
  total_invited: number;
  invites_clicked: number;
  devices_enrolled: number;
  devices_online: number;
  recent_enrollments: Array<{
    device_id: string;
    hostname: string;
    os: string;
    invited_email: string;
    enrolled_at: string;
  }>;
}

const RECENT_ENROLLMENTS_LIMIT = 10;

/**
 * Compute the invite funnel for a partner. Exported so route/integration
 * tests can assert behavior directly without going through the aiTools dispatch.
 */
export async function computeInviteFunnel(partnerId: string): Promise<InviteFunnel> {
  const invites = await db
    .select({
      id: deploymentInvites.id,
      email: deploymentInvites.invitedEmail,
      status: deploymentInvites.status,
      clickedAt: deploymentInvites.clickedAt,
      enrolledAt: deploymentInvites.enrolledAt,
      deviceId: deploymentInvites.deviceId,
    })
    .from(deploymentInvites)
    .where(eq(deploymentInvites.partnerId, partnerId));

  const total_invited = invites.length;
  // `clicked` count uses status OR a non-null clickedAt so a row that has
  // advanced past clicked (e.g. `enrolled`) still counts in the clicked funnel.
  const invites_clicked = invites.filter(
    (i) => i.status === 'clicked' || i.status === 'enrolled' || i.clickedAt !== null,
  ).length;
  const devices_enrolled = invites.filter(
    (i) => i.status === 'enrolled' && i.deviceId !== null,
  ).length;

  const enrolledWithDevice = invites.filter((i) => i.deviceId !== null);
  const deviceIds = enrolledWithDevice
    .map((i) => i.deviceId)
    .filter((x): x is string => typeof x === 'string');

  const deviceRows = deviceIds.length === 0
    ? []
    : await db
        .select({
          id: devices.id,
          hostname: devices.hostname,
          osType: devices.osType,
          status: devices.status,
          orgId: devices.orgId,
        })
        .from(devices)
        .where(
          and(
            inArray(devices.id, deviceIds),
            // Defense-in-depth: partner scope already implied by invite row, but
            // re-scope via the device's org->partner link would require a join;
            // skip it here — RLS on `devices` + the explicit inArray on invite-
            // linked ids makes cross-tenant leakage impossible in practice.
          ),
        );

  const byDeviceId = new Map(deviceRows.map((d) => [d.id, d] as const));
  const devices_online = deviceRows.filter((d) => d.status === 'online').length;

  const recent_enrollments = enrolledWithDevice
    .filter((i) => i.enrolledAt !== null)
    .sort((a, b) => (b.enrolledAt?.getTime() ?? 0) - (a.enrolledAt?.getTime() ?? 0))
    .slice(0, RECENT_ENROLLMENTS_LIMIT)
    .map((i) => {
      const d = byDeviceId.get(i.deviceId!);
      return {
        device_id: i.deviceId!,
        hostname: d?.hostname ?? 'unknown',
        os: d?.osType ?? 'unknown',
        invited_email: i.email,
        enrolled_at: i.enrolledAt!.toISOString(),
      };
    });

  return {
    total_invited,
    invites_clicked,
    devices_enrolled,
    devices_online,
    recent_enrollments,
  };
}

export function registerFleetStatusTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('get_fleet_status', {
    tier: 1 as AiToolTier,
    definition: {
      name: 'get_fleet_status',
      description:
        'Return the deployment-invite funnel for this tenant: how many invites were sent, clicked, enrolled as devices, and are currently online. Includes up to 10 most-recent enrollments (device_id, hostname, os, invited_email, enrolled_at). Use this during MCP bootstrap to answer "how many of my invites turned into working agents?".',
      input_schema: {
        type: 'object' as const,
        properties: {},
      },
    },
    handler: async (_input: Record<string, unknown>, auth: AuthContext) => {
      try {
        if (!auth.partnerId) {
          return JSON.stringify({
            error: 'get_fleet_status requires a partner-scoped API key',
          });
        }
        const funnel = await computeInviteFunnel(auth.partnerId);
        return JSON.stringify({ invite_funnel: funnel });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal error';
        console.error('[fleet:get_fleet_status]', message, err);
        return JSON.stringify({ error: 'Operation failed. Check server logs for details.' });
      }
    },
  });
}
