import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, jsonb, pgEnum, integer, bigint, index } from 'drizzle-orm/pg-core';
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
}, (t) => [
  // W06 (#3900): one user's ended sessions for a day window; partial so the
  // long tail of never-ended rows costs nothing. DOCUMENTS the index created by
  // migration 2026-09-25-time-entry-source-and-suggestion-decisions.sql — this
  // declaration does not create it (same situation as the note on
  // notifications.ts:57-64).
  index('remote_sessions_user_ended_idx').on(t.userId, t.endedAt).where(sql`${t.endedAt} IS NOT NULL`)
]);
