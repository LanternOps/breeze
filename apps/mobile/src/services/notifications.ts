import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

import { registerPushToken as apiRegisterPushToken } from './api';

// Configure how notifications are handled when the app is in the foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

/**
 * Register for push notifications and get the push token
 */
export async function registerForPushNotifications(): Promise<string | null> {
  let token: string | null = null;

  // Check if this is a physical device
  if (!Device.isDevice) {
    console.log('Push notifications require a physical device');
    return null;
  }

  // Check and request permissions
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    console.log('Push notification permission not granted');
    return null;
  }

  try {
    // Get the Expo push token
    const tokenData = await Notifications.getExpoPushTokenAsync({
      projectId: 'your-project-id', // Replace with your Expo project ID
    });
    token = tokenData.data;

    // Register the token with our backend
    const platform = Platform.OS as 'ios' | 'android';
    await apiRegisterPushToken(token, platform);

    console.log('Push token registered:', token);
  } catch (error) {
    console.error('Error getting push token:', error);
  }

  // Configure Android notification channel
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('alerts', {
      name: 'Alerts',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#FF231F7C',
      sound: 'default',
    });

    await Notifications.setNotificationChannelAsync('default', {
      name: 'Default',
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 250],
      lightColor: '#2563eb',
    });
  }

  return token;
}

/**
 * Add a listener for incoming notifications while the app is foregrounded
 */
export function addNotificationReceivedListener(
  listener: (notification: Notifications.Notification) => void
): Notifications.Subscription {
  return Notifications.addNotificationReceivedListener(listener);
}

/**
 * Add a listener for when a user taps on a notification
 */
export function addNotificationResponseReceivedListener(
  listener: (response: Notifications.NotificationResponse) => void
): Notifications.Subscription {
  return Notifications.addNotificationResponseReceivedListener(listener);
}

/**
 * Remove a notification subscription
 */
export function removeNotificationSubscription(subscription: Notifications.Subscription): void {
  Notifications.removeNotificationSubscription(subscription);
}

/**
 * Schedule a local notification
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
