import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import type { EventSubscription } from 'expo-notifications';

import { registerPushToken as apiRegisterPushToken } from './api';

// Configure how notifications are handled when the app is in the foreground.
// SDK 55: shouldShowAlert is deprecated; use shouldShowBanner + shouldShowList.
Notifications.setNotificationHandler({
  handleNotification: async (notification) => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: shouldSetBadgeFor(
      notification.request.content.data as Record<string, unknown> | undefined
    ),
  }),
});

export type PushRegistrationOutcome =
  | { status: 'ok'; token: string }
  | { status: 'unsupported'; reason: string }
  | { status: 'failed'; reason: string };

export async function registerForPushNotifications(): Promise<PushRegistrationOutcome> {
  if (!Device.isDevice) {
    console.log('Push notifications require a physical device');
    return { status: 'unsupported', reason: 'not_physical_device' };
  }

  // Everything from here on is inside one try/catch so the outcome contract is
  // TOTAL: this function resolves to ok/unsupported/failed, never rejects.
  // The permission calls used to run before the try — a throw there became an
  // unhandled rejection in PushRegistrationGate and left the store stuck at
  // 'idle' ("Checking push registration…" forever in Settings). #3143
  let token: string | null = null;
  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      console.log('Push notification permission not granted');
      return { status: 'failed', reason: 'permission_denied' };
    }

    if (Platform.OS === 'ios') {
      // Native device push token: raw APNs token. Uses getDevicePushTokenAsync
      // — needs NO Expo projectId/account — so push works with a plain
      // Xcode/Apple build (not the Expo push relay).
      const tokenData = await Notifications.getDevicePushTokenAsync();
      token = String(tokenData.data);
    } else {
      // Android stays on the Expo push relay: the API's approval dispatcher
      // does not send to raw FCM tokens yet (deliberately skipped server-side
      // in expoPush.ts), so a native device token here would silently drop
      // approval pushes.
      //
      // The iOS-native-APNs switch removed `extra.eas.projectId` from app.json,
      // so on a stock build there is no relay to register with. That is a
      // not-built-yet state, NOT a failure: reporting it as 'failed' would show
      // Android users a red "push failed to register" banner for a feature that
      // was never wired. Android push needs either an Expo projectId restored
      // here or a real FCM sender added server-side.
      const projectId = Constants.expoConfig?.extra?.eas?.projectId;
      if (!projectId) {
        return { status: 'unsupported', reason: 'android_push_not_configured' };
      }
      const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
      token = tokenData.data;
    }

    const platform = Platform.OS as 'ios' | 'android';
    await apiRegisterPushToken(token, platform);

    console.log('Push token registered');
  } catch (error) {
    console.error('Error getting push token:', error);
    const reason = error instanceof Error ? error.message : 'unknown';
    return { status: 'failed', reason };
  }

  if (Platform.OS === 'android') {
    // Best-effort: the token is already registered with the API at this point,
    // so a channel-setup failure must not reject the promise (pre-#3143 it ran
    // after the catch and did exactly that) nor flip the outcome to 'failed' —
    // pushes still arrive, at worst with default channel presentation.
    try {
      await Notifications.setNotificationChannelAsync('alerts', {
        name: 'Alerts',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#FF231F7C',
        sound: 'default',
      });

      await Notifications.setNotificationChannelAsync('approvals', {
        name: 'Approvals',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 200, 100, 200],
        lightColor: '#1c8a9e',
        sound: 'default',
      });

      // W10 (#4336). Inert on today's builds — Android push is not wired at all
      // (see the projectId branch above) and the server skips FCM tokens for
      // ticket pushes. Registered now so the channel exists the moment either
      // side lands, rather than ticket pushes arriving on 'default'.
      await Notifications.setNotificationChannelAsync('tickets', {
        name: 'Tickets',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 200],
        lightColor: '#1c8a9e',
        sound: 'default',
      });

      await Notifications.setNotificationChannelAsync('default', {
        name: 'Default',
        importance: Notifications.AndroidImportance.DEFAULT,
        vibrationPattern: [0, 250],
        lightColor: '#2563eb',
      });
    } catch (err) {
      console.warn('[notifications] Android channel setup failed', err);
    }
  }

  return { status: 'ok', token };
}

/**
 * Re-evaluate push registration when the app returns to the foreground (#3143).
 *
 * iOS does not restart the app when the user flips the notification permission
 * in Settings, and registration otherwise runs once per login — so without
 * this, a user could tap the Settings sheet's Notifications row ("Tap to
 * manage them in Settings"), revoke the permission, come back, and the row
 * (and ApprovalGate's banner logic) would keep claiming pushes are delivered
 * for the rest of the session.
 *
 * Returns the corrected outcome to dispatch, or null when the stored status is
 * still accurate. Only the two permission-driven transitions are handled:
 *   ok --permission revoked--> failed/permission_denied
 *   failed/permission_denied --permission granted--> full re-registration
 * `unsupported` and non-permission failures are resting states a foreground
 * hop cannot change.
 */
export async function reconcilePushRegistration(
  status: 'idle' | 'ok' | 'failed' | 'unsupported',
  reason: string | null
): Promise<PushRegistrationOutcome | null> {
  if (status === 'ok') {
    const { status: perm } = await Notifications.getPermissionsAsync();
    if (perm === 'granted') return null;
    return { status: 'failed', reason: 'permission_denied' };
  }
  if (status === 'failed' && reason === 'permission_denied') {
    const { status: perm } = await Notifications.getPermissionsAsync();
    if (perm !== 'granted') return null;
    return registerForPushNotifications();
  }
  return null;
}

/**
 * Add a listener for incoming notifications while the app is foregrounded
 */
export function addNotificationReceivedListener(
  listener: (notification: Notifications.Notification) => void
): EventSubscription {
  return Notifications.addNotificationReceivedListener(listener);
}

/**
 * Add a listener for when a user taps on a notification
 */
export function addNotificationResponseReceivedListener(
  listener: (response: Notifications.NotificationResponse) => void
): EventSubscription {
  return Notifications.addNotificationResponseReceivedListener(listener);
}

/**
 * Remove a notification subscription
 */
export function removeNotificationSubscription(subscription: EventSubscription): void {
  if (subscription) {
    subscription.remove();
  }
}

/**
 * Schedule a local notification.
 * SDK 55: trigger now requires an explicit `type` field using SchedulableTriggerInputTypes.
 */
export async function scheduleLocalNotification(
  title: string,
  body: string,
  data?: Record<string, unknown>,
  seconds: number = 1
): Promise<string> {
  return await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data,
      sound: 'default',
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds,
    },
  });
}

/**
 * Cancel a scheduled notification
 */
export async function cancelScheduledNotification(notificationId: string): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(notificationId);
}

/**
 * Cancel all scheduled notifications
 */
export async function cancelAllScheduledNotifications(): Promise<void> {
  await Notifications.cancelAllScheduledNotificationsAsync();
}

/**
 * Get the current badge count
 */
export async function getBadgeCount(): Promise<number> {
  return await Notifications.getBadgeCountAsync();
}

/**
 * Set the badge count
 */
export async function setBadgeCount(count: number): Promise<void> {
  await Notifications.setBadgeCountAsync(count);
}

/**
 * Dismiss all notifications
 */
export async function dismissAllNotifications(): Promise<void> {
  await Notifications.dismissAllNotificationsAsync();
}

/**
 * Get the last notification response (when app was opened from notification)
 */
export async function getLastNotificationResponse(): Promise<Notifications.NotificationResponse | null> {
  return await Notifications.getLastNotificationResponseAsync();
}

/**
 * Parse notification data for alert navigation.
 *
 * Server side (apps/api/src/services/notifications.ts) emits FCM data
 * payloads for `alert.*` events with `alertId`, `severity`, and
 * `eventType` (e.g. `alert.triggered`). It does *not* set a `type` field
 * today, so we recognize alert pushes by `eventType` prefix or the
 * presence of `alertId` alongside any explicit `type: 'alert'` marker
 * (kept for forward compatibility).
 */
export function parseAlertNotification(
  notification: Notifications.Notification | Notifications.NotificationResponse['notification']
): { alertId: string; severity: string } | null {
  const data = notification.request.content.data;
  if (!data) return null;

  const alertId = typeof data.alertId === 'string' ? data.alertId : null;
  if (!alertId) return null;

  const eventType = typeof data.eventType === 'string' ? data.eventType : '';
  const explicitType = data.type === 'alert';
  const isAlertEvent = eventType.startsWith('alert.') || explicitType;
  if (!isAlertEvent) return null;

  return {
    alertId,
    severity: typeof data.severity === 'string' ? data.severity : 'low',
  };
}

export function parseApprovalNotification(
  notification: Notifications.Notification | Notifications.NotificationResponse['notification']
): { approvalId: string } | null {
  const data = notification.request.content.data;
  if (data && data.type === 'approval' && typeof data.approvalId === 'string') {
    return { approvalId: data.approvalId };
  }
  return null;
}

/**
 * W10 (#4336). What a ticket push carries once it has been validated.
 *
 * Deliberately narrower than the wire payload: the server also sends
 * `internalNumber` for the lock-screen body, which nothing on this side routes
 * on. Keeping the parsed shape to the routing-relevant fields means a change to
 * the presentation extras cannot break tap handling.
 */
export interface TicketPushData {
  ticketId: string;
  reason: 'assigned' | 'sla_breached';
  target?: 'response' | 'resolution';
}

/**
 * Pure parser over the notification `data` map.
 *
 * Wire contract: `buildTicketPush` in `apps/api/src/services/expoPush.ts`
 * (shipped in the API half of W07, PR #4281) emits
 * `{ type: 'ticket', ticketId, reason, target?, internalNumber? }`.
 *
 * An unrecognised `target` is dropped rather than rejecting the push: the
 * target is a label, and refusing the whole notification would strand the
 * technician on a breach the server already decided to tell them about. A bad
 * `ticketId` or `reason` IS fatal — both feed navigation.
 */
export function parseTicketData(
  data: Record<string, unknown> | null | undefined
): TicketPushData | null {
  if (!data || data.type !== 'ticket') return null;
  if (typeof data.ticketId !== 'string' || data.ticketId.length === 0) return null;
  if (data.reason !== 'assigned' && data.reason !== 'sla_breached') return null;
  const parsed: TicketPushData = { ticketId: data.ticketId, reason: data.reason };
  if (data.target === 'response' || data.target === 'resolution') parsed.target = data.target;
  return parsed;
}

export function parseTicketNotification(
  notification: Notifications.Notification | Notifications.NotificationResponse['notification']
): TicketPushData | null {
  return parseTicketData(notification.request.content.data as Record<string, unknown> | undefined);
}

/**
 * Ticket pushes never touch the app badge.
 *
 * `reconcileApprovalNotifications` SETS the badge to the pending-approval
 * count, so the badge means "approvals waiting on you" and nothing else. A
 * ticket push that bumped it would read as a phantom approval until the next
 * reconcile silently corrected it.
 */
export function shouldSetBadgeFor(data: Record<string, unknown> | null | undefined): boolean {
  return !(data && data.type === 'ticket');
}

/** The server sends a date-only `YYYY-MM-DD`; the screen puts it straight into `?date=`. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * W06 (#3900). The daily "N unlogged sessions" push.
 *
 * W06 ships only this parser: the listener wiring, quiet hours and the
 * notification category belong to W07.
 *
 * A payload with no usable date returns null rather than defaulting to today —
 * routing to a screen for the wrong day silently shows the technician the wrong
 * sessions to bill, which is worse than a tap that does nothing.
 */
export function parseTimeSuggestionsNotification(
  notification: Notifications.Notification | Notifications.NotificationResponse['notification']
): { date: string } | null {
  const data = notification.request.content.data;
  if (!data || data.type !== 'time_suggestions') return null;
  const date = data.date;
  if (typeof date !== 'string' || !ISO_DATE.test(date)) return null;
  return { date };
}

/**
 * Minimal shape of a delivered notification needed to decide whether to
 * dismiss it. Structural so the pure selector below can be tested without an
 * expo-notifications runtime.
 */
export interface PresentedApprovalNotification {
  request: {
    identifier: string;
    content: { data?: Record<string, unknown> | null };
  };
}

/**
 * Pick the delivered notifications that should be cleared from Notification
 * Center: every approval push whose request is no longer pending.
 *
 * Non-approval notifications (alerts) are never touched — dismissing the whole
 * tray would eat alert banners the technician has not read.
 */
export function staleApprovalNotificationIds(
  presented: readonly PresentedApprovalNotification[],
  pendingApprovalIds: readonly string[]
): string[] {
  const stillPending = new Set(pendingApprovalIds);
  const stale: string[] = [];
  for (const n of presented) {
    const data = n.request.content.data;
    if (!data || data.type !== 'approval' || typeof data.approvalId !== 'string') continue;
    if (stillPending.has(data.approvalId)) continue;
    stale.push(n.request.identifier);
  }
  return stale;
}

/**
 * Clear delivered approval banners for requests that are no longer pending —
 * e.g. approved in the web UI, or denied from another device.
 *
 * Best-effort: a failure here is cosmetic (a stale banner), never a decision
 * correctness problem, so it degrades to a warning rather than surfacing.
 */
export async function reconcileApprovalNotifications(
  pendingApprovalIds: readonly string[]
): Promise<void> {
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    const stale = staleApprovalNotificationIds(
      presented as unknown as PresentedApprovalNotification[],
      pendingApprovalIds
    );
    await Promise.all(stale.map((id) => Notifications.dismissNotificationAsync(id)));
    await Notifications.setBadgeCountAsync(pendingApprovalIds.length);
  } catch (err) {
    console.warn('[notifications] approval reconcile failed', err);
  }
}
