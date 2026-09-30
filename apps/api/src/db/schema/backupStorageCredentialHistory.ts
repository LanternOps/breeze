import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './orgs';
import { users } from './users';
import { backupConfigs } from './backup';

/**
 * The storage keys each S3 backup destination has used, with evidence that
 * replaced keys were disabled (services/backupStorageCredentialHistory.ts,
 * migrations/2026-11-12-100000-backup-storage-credential-history.sql).
 *
 * Tenancy: direct org_id (shape 1), no device_id. `config_id` is SET NULL so
 * the history outlives its destination. `sealed_previous_secret` is
 * application-encrypted, bound to the row id (encryptedColumnRegistry).
 */
export const backupStorageCredentialHistory = pgTable(
  'backup_storage_credential_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    configId: uuid('config_id').references(() => backupConfigs.id, { onDelete: 'set null' }),
    storageIdentity: text('storage_identity').notNull(),
    /** sha256 hex of `<access key id>|<storage identity>`; the key id itself is never stored. */
    accessKeyFingerprint: text('access_key_fingerprint').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
    /** Set for keys in use before brokered writes were required; NULL for keys configured afterwards. */
    broadcastUntil: timestamp('broadcast_until', { withTimezone: true }),
    /** When the destination stopped using the key. NULL = its current key. */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    /** Encrypted replaced connection settings, kept only to check the old key. */
    sealedPreviousSecret: text('sealed_previous_secret'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** probe_denied | provider_admin_confirmed | operator_attested */
    revocationEvidence: text('revocation_evidence'),
    evidenceDetail: text('evidence_detail'),
    verifiedByUserId: uuid('verified_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    lastProbeAt: timestamp('last_probe_at', { withTimezone: true }),
    /** still_live | inconclusive */
    lastProbeOutcome: text('last_probe_outcome'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index('backup_storage_credential_history_org_idx').on(table.orgId),
    configIdx: index('backup_storage_credential_history_config_idx').on(table.configId),
    fingerprintIdx: index('backup_storage_credential_history_fingerprint_idx').on(table.accessKeyFingerprint),
    verifiedByIdx: index('backup_storage_credential_history_verified_by_idx').on(table.verifiedByUserId),
    outstandingIdx: index('backup_storage_credential_history_outstanding_idx')
      .on(table.orgId)
      .where(sql`broadcast_until IS NOT NULL AND revoked_at IS NULL`),
    currentUq: uniqueIndex('backup_storage_credential_history_current_uq')
      .on(table.configId)
      .where(sql`superseded_at IS NULL AND config_id IS NOT NULL`),
  }),
);
