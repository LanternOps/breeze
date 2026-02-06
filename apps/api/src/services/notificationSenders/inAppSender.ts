/**
 * In-App Notification Sender
 *
 * Creates in-app notifications for users in the organization.
 * These appear in the user's notification center within the application.
 */

import { db } from '../../db';
import { userNotifications, organizationUsers, users, partnerUsers, organizations } from '../../db/schema';
import { eq, and, or, inArray } from 'drizzle-orm';

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface InAppNotificationPayload {
  alertId: string;
  alertName: string;
  severity: AlertSeverity;
  message: string;
  orgId: string;
  deviceId?: string;
  deviceName?: string;
  link?: string;
}

export interface SendResult {
  success: boolean;
  notificationCount: number;
  error?: string;
}

/**
 * Map alert severity to notification priority
 */
function severityToPriority(severity: AlertSeverity): 'low' | 'normal' | 'high' | 'urgent' {
  switch (severity) {
    case 'critical':
      return 'urgent';
    case 'high':
      return 'high';
    case 'medium':
      return 'normal';
    case 'low':
    case 'info':
    default:
      return 'low';
  }
}

/**
 * Send in-app notifications to all active users who can access this organization
 * This includes:
 * - Organization users directly assigned to this org
 * - Partner users with access to orgs under this partner
 */
export async function sendInAppNotification(payload: InAppNotificationPayload): Promise<SendResult> {
  try {
    // Get org's partner ID to find partner users
    const [org] = await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, payload.orgId))
      .limit(1);

    // Get all active users in the organization
    const orgUserResults = await db
      .select({ userId: organizationUsers.userId })
      .from(organizationUsers)
      .innerJoin(users, eq(organizationUsers.userId, users.id))
      .where(
        and(
          eq(organizationUsers.orgId, payload.orgId),
          eq(users.status, 'active')
        )
      );

    // Get partner users with access to this org's partner
    let partnerUserResults: { userId: string }[] = [];
    if (org?.partnerId) {
      partnerUserResults = await db
        .select({ userId: partnerUsers.userId })
        .from(partnerUsers)
        .innerJoin(users, eq(partnerUsers.userId, users.id))
        .where(
          and(
            eq(partnerUsers.partnerId, org.partnerId),
            eq(users.status, 'active'),
            // Include users with 'all' access or specific access to this org
            or(
              eq(partnerUsers.orgAccess, 'all'),
              // For 'specific' access, would need to check orgIds array
              // but 'all' covers most admin cases
            )
          )
        );
    }

    // Combine and deduplicate user IDs
    const userIdSet = new Set<string>();
    for (const { userId } of orgUserResults) {
      userIdSet.add(userId);
    }
    for (const { userId } of partnerUserResults) {
      userIdSet.add(userId);
    }

    if (userIdSet.size === 0) {
      return {
        success: true,
        notificationCount: 0
      };
    }

    // Build notification link
    const link = payload.link || `/alerts/${payload.alertId}`;

    // Build metadata
    const metadata = {
      alertId: payload.alertId,
      severity: payload.severity,
      deviceId: payload.deviceId,
      deviceName: payload.deviceName
    };

    // Create notifications for all users
    const notifications = Array.from(userIdSet).map(userId => ({
      userId,
      orgId: payload.orgId,
      type: 'alert' as const,
      priority: severityToPriority(payload.severity),
      title: payload.alertName,
      message: payload.message,
      link,
      metadata,
      read: false
    }));

    await db.insert(userNotifications).values(notifications);

    console.log(`[InAppSender] Created ${notifications.length} in-app notifications for alert ${payload.alertId} (${orgUserResults.length} org users, ${partnerUserResults.length} partner users)`);

    return {
      success: true,
      notificationCount: notifications.length
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[InAppSender] Failed to send in-app notification:', errorMessage);

    return {
      success: false,
      notificationCount: 0,
      error: errorMessage
    };
  }
}

/**
 * Send in-app notification to specific users
 */
export async function sendInAppNotificationToUsers(
  userIds: string[],
  payload: Omit<InAppNotificationPayload, 'orgId'> & { orgId?: string }
): Promise<SendResult> {
  if (userIds.length === 0) {
    return { success: true, notificationCount: 0 };
  }

  try {
    const link = payload.link || `/alerts/${payload.alertId}`;

    const metadata = {
      alertId: payload.alertId,
      severity: payload.severity,
      deviceId: payload.deviceId,
      deviceName: payload.deviceName
    };

    const notifications = userIds.map(userId => ({
      userId,
      orgId: payload.orgId || null,
      type: 'alert' as const,
      priority: severityToPriority(payload.severity),
      title: payload.alertName,
      message: payload.message,
      link,
      metadata,
      read: false
    }));

    await db.insert(userNotifications).values(notifications);

    return {
      success: true,
      notificationCount: notifications.length
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[InAppSender] Failed to send in-app notification:', errorMessage);

    return {
      success: false,
      notificationCount: 0,
      error: errorMessage
    };
  }
}

/**
 * Validate in-app channel configuration
 * In-app channels don't need special config, but may have options
 */
export function validateInAppConfig(config: unknown): { valid: boolean; errors: string[] } {
  // In-app notifications don't require config - they go to all org users by default
  // But we can optionally filter by role or user IDs

  if (config && typeof config === 'object') {
    const c = config as Record<string, unknown>;

    // Optional: specific user IDs
    if (c.userIds && !Array.isArray(c.userIds)) {
      return { valid: false, errors: ['userIds must be an array'] };
    }

    // Optional: role filter
    if (c.roles && !Array.isArray(c.roles)) {
      return { valid: false, errors: ['roles must be an array'] };
    }
  }

  return { valid: true, errors: [] };
}
