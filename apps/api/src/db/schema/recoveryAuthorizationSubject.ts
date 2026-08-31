import { sql } from 'drizzle-orm';
import { check, timestamp, varchar, text, type AnyPgColumn } from 'drizzle-orm/pg-core';

type RecoveryAuthorizationPrincipalKind =
  | 'user_session'
  | 'client_user'
  | 'api_key'
  | 'oauth_grant'
  | 'ai_agent'
  | 'system'
  | 'unknown';

type RecoveryAuthorizationState =
  | 'pending'
  | 'authorized'
  | 'denied'
  | 'quarantined_authorization_unknown'
  | 'not_required';

export function recoveryAuthorizationSubjectColumns() {
  return {
    authorizationPrincipalKind: varchar('authorization_principal_kind', { length: 32 })
      .notNull()
      .default('unknown')
      .$type<RecoveryAuthorizationPrincipalKind>(),
    authorizationPrincipalId: text('authorization_principal_id'),
    authorizationGrantRevision: varchar('authorization_grant_revision', { length: 255 }),
    authorizationState: varchar('authorization_state', { length: 40 })
      .notNull()
      .default('pending')
      .$type<RecoveryAuthorizationState>(),
    authorizationDenialCode: varchar('authorization_denial_code', { length: 64 }),
    authorizationCheckedAt: timestamp('authorization_checked_at', { withTimezone: true }),
  };
}

type RecoveryAuthorizationColumns = {
  authorizationPrincipalKind: AnyPgColumn;
  authorizationPrincipalId: AnyPgColumn;
  authorizationGrantRevision: AnyPgColumn;
  authorizationState: AnyPgColumn;
};

export function recoveryAuthorizationSubjectChecks(
  tableName: string,
  table: RecoveryAuthorizationColumns,
) {
  return {
    authorizationPrincipalKindCheck: check(
      `${tableName}_authorization_principal_kind_chk`,
      sql`${table.authorizationPrincipalKind} IN ('user_session', 'client_user', 'api_key', 'oauth_grant', 'ai_agent', 'system', 'unknown')`,
    ),
    authorizationStateCheck: check(
      `${tableName}_authorization_state_chk`,
      sql`${table.authorizationState} IN ('pending', 'authorized', 'denied', 'quarantined_authorization_unknown', 'not_required')`,
    ),
    authorizationSubjectTupleCheck: check(
      `${tableName}_authorization_subject_tuple_chk`,
      sql`(
        (${table.authorizationPrincipalKind} = 'unknown'
          AND ${table.authorizationPrincipalId} IS NULL
          AND ${table.authorizationGrantRevision} IS NULL)
        OR
        (${table.authorizationPrincipalKind} <> 'unknown'
          AND length(btrim(${table.authorizationPrincipalId})) > 0
          AND length(btrim(${table.authorizationGrantRevision})) > 0)
      )`,
    ),
  };
}
