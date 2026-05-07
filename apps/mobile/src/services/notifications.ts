import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import type { EventSubscription } from 'expo-notifications';
import Constants from 'expo-constants';

import { registerPushToken as apiRegisterPushToken } from './api';

// Configure how notifications are handled when the app is in the foreground.
// SDK 55: shouldShowAlert is deprecated; use shouldShowBanner + shouldShowList.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
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

  let token: string | null = null;
  try {
    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) throw new Error('EAS projectId missing — run `eas init`');
    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    token = tokenData.data;

    const platform = Platform.OS as 'ios' | 'android';
    await apiRegisterPushToken(token, platform);

    console.log('Push token registered:', token);
  } catch (error) {
    console.error('Error getting push token:', error);
    const reason = error instanceof Error ? error.message : 'unknown';
    return { status: 'failed', reason };
  }

  if (Platform.OS === 'android') {
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

    await Notifications.setNotificationChannelAsync('default', {
      name: 'Default',
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 250],
      lightColor: '#2563eb',
    });
  }

  return { status: 'ok', token };
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
 * Parse notification data for alert navigation
 */
export function parseAlertNotification(
  notification: Notifications.Notification
): { alertId: string; severity: string } | null {
  const data = notification.request.content.data;

  if (data && data.type === 'alert' && data.alertId) {
    return {
      alertId: data.alertId as string,
      severity: (data.severity as string) || 'low',
    };
  }

  return null;
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
