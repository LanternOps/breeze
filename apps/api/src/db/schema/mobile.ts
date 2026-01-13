import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, pgEnum } from 'drizzle-orm/pg-core';
import { users } from './users';
import { alertSeverityEnum } from './alerts';

export const devicePlatformEnum = pgEnum('device_platform', ['ios', 'android']);

export const mobileDevices = pgTable('mobile_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  deviceId: varchar('device_id', { length: 255 }).notNull().unique(),
  platform: devicePlatformEnum('platform').notNull(),
  model: varchar('model', { length: 255 }),
  osVersion: varchar('os_version', { length: 100 }),
  appVersion: varchar('app_version', { length: 50 }),
  fcmToken: text('fcm_token'),
  apnsToken: text('apns_token'),
  notificationsEnabled: boolean('notifications_enabled').notNull().default(true),
  alertSeverities: alertSeverityEnum('alert_severities').array().notNull().default([]),
  quietHours: jsonb('quiet_hours'),
  lastActiveAt: timestamp('last_active_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const pushNotifications = pgTable('push_notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  mobileDeviceId: uuid('mobile_device_id').notNull().references(() => mobileDevices.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  title: varchar('title', { length: 255 }).notNull(),
  body: text('body'),
  data: jsonb('data'),
  platform: devicePlatformEnum('platform').notNull(),
  messageId: varchar('message_id', { length: 255 }),
  status: varchar('status', { length: 50 }),
  sentAt: timestamp('sent_at'),
  deliveredAt: timestamp('delivered_at'),
  readAt: timestamp('read_at'),
  errorMessage: text('error_message'),
  alertId: uuid('alert_id'),
  eventType: varchar('event_type', { length: 100 }),
  createdAt: timestamp('created_at').defaultNow().notNull()
});

export const mobileSessions = pgTable('mobile_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  mobileDeviceId: uuid('mobile_device_id').notNull().references(() => mobileDevices.id),
  refreshToken: text('refresh_token').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  lastUsedAt: timestamp('last_used_at'),
  ipAddress: varchar('ip_address', { length: 45 }),
  revokedAt: timestamp('revoked_at'),
  createdAt: timestamp('created_at').defaultNow().notNull()
});
