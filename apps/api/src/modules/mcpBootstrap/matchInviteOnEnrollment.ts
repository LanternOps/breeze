/**
 * Closes the deployment-invite funnel when an agent enrolls.
 *
 * Task 5.3 of the MCP bootstrap plan: when a device enrolls using a child
 * enrollment key that was minted by `send_deployment_invites`, flip the
 * corresponding `deployment_invites` row from `clicked`/`sent` to `enrolled`
 * so `get_fleet_status` can report accurate funnel metrics.
 *
 * This is best-effort — a manual enrollment (no matching invite row) or a
 * second heartbeat from an already-enrolled device is a silent no-op. Errors
 * never bubble; they're logged and swallowed so they cannot fail the
 * enrollment response.
 *
 * Match rule: `deployment_invites.enrollment_key_id` stores the child-key id
 * that `sendDeploymentInvites` minted, and the agent enrolls with that same
 * child key, so an equality match on the key id is sufficient. No parent
 * traversal is required (the enrollment_keys table has no parentId column).
 *
 * Idempotent: the `isNull(enrolledAt)` guard means re-enrollments of the same
 * device don't clobber the first-enrolled timestamp.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db as defaultDb } from '../../db';
import { deploymentInvites } from '../../db/schema';

export type MatchInviteDb = Pick<typeof defaultDb, 'update'>;

export async function matchDeploymentInviteOnEnrollment(
  params: { enrollmentKeyId: string; deviceId: string; now?: Date },
  db: MatchInviteDb = defaultDb,
): Promise<void> {
  const { enrollmentKeyId, deviceId, now = new Date() } = params;
  try {
    await db
      .update(deploymentInvites)
      .set({
        status: 'enrolled',
        enrolledAt: now,
        deviceId,
      })
      .where(
        and(
          eq(deploymentInvites.enrollmentKeyId, enrollmentKeyId),
          isNull(deploymentInvites.enrolledAt),
        ),
      );
  } catch (err) {
    // Best-effort: never let an invite-match failure break enrollment.
    console.error(
      '[mcpBootstrap] matchDeploymentInviteOnEnrollment failed (non-fatal):',
      err instanceof Error ? err.message : err,
    );
  }
}
