import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, jsonb, pgEnum, integer, bigint, index, check } from 'drizzle-orm/pg-core';
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
  // Exact command generation currently authorized to report the endpoint's
  // answer/consent verdict. Re-offering replaces this value, invalidating a
  // delayed result from the superseded start command.
  desktopStartCommandId: text('desktop_start_command_id'),
  desktopPromptMode: text('desktop_prompt_mode').$type<'off' | 'notify' | 'consent'>(),
  iceCandidates: jsonb('ice_candidates').default([]),
  startedAt: timestamp('started_at'),
  endedAt: timestamp('ended_at'),
  durationSeconds: integer('duration_seconds'),
  bytesTransferred: bigint('bytes_transferred', { mode: 'bigint' }),
  recordingUrl: text('recording_url'),
  errorMessage: text('error_message'),
  // users.permissions_epoch as it stood when this session was created — the
  // durable baseline the revocation-lease renew recheck compares against.
  // Redis holds only the lease TTL, so a renew after a Redis flush re-derives
  // the baseline from here. NULL on rows predating the revocation lease.
  permissionsEpochSnapshot: bigint('permissions_epoch_snapshot', { mode: 'number' }),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (t) => [
  // W06 (#3900): one user's ended sessions for a day window; partial so the
  // long tail of never-ended rows costs nothing. DOCUMENTS the index created by
  // migration 2026-09-25-time-entry-source-and-suggestion-decisions.sql — this
  // declaration does not create it (same situation as the note on
  // notifications.ts:57-64).
  index('remote_sessions_user_ended_idx').on(t.userId, t.endedAt).where(sql`${t.endedAt} IS NOT NULL`),
  check(
    'remote_sessions_desktop_prompt_mode_check',
    sql`${t.desktopPromptMode} IS NULL OR ${t.desktopPromptMode} IN ('off', 'notify', 'consent')`,
  ),
  check(
    'remote_sessions_desktop_start_binding_check',
    sql`(${t.desktopStartCommandId} IS NULL AND ${t.desktopPromptMode} IS NULL) OR (${t.desktopStartCommandId} IS NOT NULL AND ${t.desktopPromptMode} IS NOT NULL)`,
  ),
]);
