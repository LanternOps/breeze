import { pgTable, uuid, text, timestamp, jsonb, pgEnum, integer, bigint } from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { users } from './users';
import { organizations } from './orgs';

export const remoteSessionTypeEnum = pgEnum('remote_session_type', ['terminal', 'desktop', 'file_transfer']);
export const remoteSessionStatusEnum = pgEnum('remote_session_status', ['pending', 'connecting', 'active', 'disconnected', 'failed', 'denied']);

export const remoteSessions = pgTable('remote_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
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
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow().notNull()
});
