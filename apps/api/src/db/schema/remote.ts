import { pgTable, uuid, varchar, text, timestamp, jsonb, pgEnum, integer, bigint } from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { users } from './users';

export const remoteSessionTypeEnum = pgEnum('remote_session_type', ['terminal', 'desktop', 'file_transfer']);
export const remoteSessionStatusEnum = pgEnum('remote_session_status', ['pending', 'connecting', 'active', 'disconnected', 'failed']);
export const fileTransferDirectionEnum = pgEnum('file_transfer_direction', ['upload', 'download']);
export const fileTransferStatusEnum = pgEnum('file_transfer_status', ['pending', 'transferring', 'completed', 'failed']);

export const remoteSessions = pgTable('remote_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  type: remoteSessionTypeEnum('type').notNull(),
  status: remoteSessionStatusEnum('status').notNull().default('pending'),
  webrtcOffer: text('webrtc_offer'),
  webrtcAnswer: text('webrtc_answer'),
  iceCandidates: jsonb('ice_candidates').default([]),
  startedAt: timestamp('started_at'),
  endedAt: timestamp('ended_at'),
  durationSeconds: integer('duration_seconds'),
  bytesTransferred: bigint('bytes_transferred', { mode: 'bigint' }),
  recordingUrl: text('recording_url'),
  createdAt: timestamp('created_at').defaultNow().notNull()
});

export const fileTransfers = pgTable('file_transfers', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').references(() => remoteSessions.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  direction: fileTransferDirectionEnum('direction').notNull(),
  remotePath: text('remote_path').notNull(),
  localFilename: varchar('local_filename', { length: 500 }).notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'bigint' }).notNull(),
  status: fileTransferStatusEnum('status').notNull().default('pending'),
  progressPercent: integer('progress_percent').notNull().default(0),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at')
});
