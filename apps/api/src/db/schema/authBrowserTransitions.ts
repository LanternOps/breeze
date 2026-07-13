import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { refreshTokenFamilies } from './refreshTokenFamilies';

export type AuthBrowserTransitionState = 'active' | 'logout_pending' | 'retired';

/**
 * Cross-tab browser authentication authority. The binding value itself is
 * never persisted: bindingDigest is a domain-separated server HMAC.
 *
 * RLS: system-only security infrastructure. Tenant contexts must not be able
 * to correlate the accounts or refresh families used by the same browser.
 */
export const authBrowserTransitions = pgTable(
  'auth_browser_transitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bindingDigest: varchar('binding_digest', { length: 64 }).notNull(),
    generation: bigint('generation', { mode: 'number' }).notNull().default(1),
    state: varchar('state', { length: 24 })
      .$type<AuthBrowserTransitionState>()
      .notNull()
      .default('active'),
    activeOperationId: uuid('active_operation_id'),
    activeOperationExpiresAt: timestamp('active_operation_expires_at', { withTimezone: true }),
    currentUserId: uuid('current_user_id'),
    currentFamilyId: uuid('current_family_id'),
    logoutId: uuid('logout_id'),
    completionNonceDigest: varchar('completion_nonce_digest', { length: 64 }),
    logoutExpiresAt: timestamp('logout_expires_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    bindingDigestUnique: unique('auth_browser_transitions_binding_digest_unique').on(
      table.bindingDigest,
    ),
    idGenerationUnique: unique('auth_browser_transitions_id_generation_unique').on(
      table.id,
      table.generation,
    ),
    currentFamilyOwnerFk: foreignKey({
      columns: [table.currentFamilyId, table.currentUserId],
      foreignColumns: [refreshTokenFamilies.familyId, refreshTokenFamilies.userId],
      name: 'auth_browser_transitions_current_family_owner_fk',
    }),
    generationCheck: check(
      'auth_browser_transitions_generation_chk',
      sql`${table.generation} >= 1`,
    ),
    digestCheck: check(
      'auth_browser_transitions_digest_chk',
      sql`${table.bindingDigest} ~ '^[0-9a-f]{64}$'
        AND (${table.completionNonceDigest} IS NULL OR ${table.completionNonceDigest} ~ '^[0-9a-f]{64}$')`,
    ),
    operationPairCheck: check(
      'auth_browser_transitions_operation_pair_chk',
      sql`(${table.activeOperationId} IS NULL) = (${table.activeOperationExpiresAt} IS NULL)`,
    ),
    currentFamilyPairCheck: check(
      'auth_browser_transitions_current_family_pair_chk',
      sql`(${table.currentUserId} IS NULL) = (${table.currentFamilyId} IS NULL)`,
    ),
    stateCheck: check(
      'auth_browser_transitions_state_chk',
      sql`(
          ${table.state} = 'active'
          AND ${table.logoutId} IS NULL
          AND ${table.completionNonceDigest} IS NULL
          AND ${table.logoutExpiresAt} IS NULL
          AND ${table.retiredAt} IS NULL
        ) OR (
          ${table.state} = 'logout_pending'
          AND ${table.logoutId} IS NOT NULL
          AND ${table.completionNonceDigest} IS NOT NULL
          AND ${table.logoutExpiresAt} IS NOT NULL
          AND ${table.logoutExpiresAt} > ${table.updatedAt}
          AND ${table.retiredAt} IS NULL
        ) OR (
          ${table.state} = 'retired'
          AND ${table.retiredAt} IS NOT NULL
          AND ${table.activeOperationId} IS NULL
          AND ${table.activeOperationExpiresAt} IS NULL
        )`,
    ),
    logoutExpiresIdx: index('auth_browser_transitions_logout_expires_idx').on(
      table.logoutExpiresAt,
    ),
    currentFamilyIdx: index('auth_browser_transitions_current_family_idx').on(
      table.currentFamilyId,
    ),
  }),
);

/**
 * One-time durable handoff between the SSO callback and /sso/exchange. Only a
 * SHA-256 digest of the unpredictable exchange code is stored.
 */
export const ssoTokenExchangeGrants = pgTable(
  'sso_token_exchange_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    codeDigest: varchar('code_digest', { length: 64 }).notNull(),
    browserTransitionId: uuid('browser_transition_id').notNull(),
    browserGeneration: bigint('browser_generation', { mode: 'number' }).notNull(),
    userId: uuid('user_id').notNull(),
    familyId: uuid('family_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    codeDigestUnique: unique('sso_token_exchange_grants_code_digest_unique').on(
      table.codeDigest,
    ),
    transitionGenerationFk: foreignKey({
      columns: [table.browserTransitionId, table.browserGeneration],
      foreignColumns: [authBrowserTransitions.id, authBrowserTransitions.generation],
      name: 'sso_token_exchange_grants_transition_generation_fk',
    }),
    familyOwnerFk: foreignKey({
      columns: [table.familyId, table.userId],
      foreignColumns: [refreshTokenFamilies.familyId, refreshTokenFamilies.userId],
      name: 'sso_token_exchange_grants_family_owner_fk',
    }),
    lifecycleCheck: check(
      'sso_token_exchange_grants_lifecycle_chk',
      sql`${table.codeDigest} ~ '^[0-9a-f]{64}$'
        AND ${table.browserGeneration} >= 1
        AND ${table.expiresAt} > ${table.createdAt}
        AND (${table.consumedAt} IS NULL OR ${table.consumedAt} >= ${table.createdAt})`,
    ),
    expiresIdx: index('sso_token_exchange_grants_expires_idx').on(table.expiresAt),
    transitionIdx: index('sso_token_exchange_grants_transition_idx').on(
      table.browserTransitionId,
      table.browserGeneration,
    ),
  }),
);

export type AuthBrowserTransition = typeof authBrowserTransitions.$inferSelect;
export type NewAuthBrowserTransition = typeof authBrowserTransitions.$inferInsert;
export type SsoTokenExchangeGrant = typeof ssoTokenExchangeGrants.$inferSelect;
export type NewSsoTokenExchangeGrant = typeof ssoTokenExchangeGrants.$inferInsert;
