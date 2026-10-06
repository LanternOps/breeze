import { pgTable, uuid, boolean, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { partners } from './orgs';
import { users } from './users';
import type { AssuranceFloorOverrides } from '@breeze/shared';

/** One approval-security policy row per MSP (partner). Partner-axis (Shape 3). */
export const authenticatorPolicies = pgTable('authenticator_policies', {
  partnerId: uuid('partner_id')
    .primaryKey()
    .references(() => partners.id, { onDelete: 'cascade' }),
  // Raise-only overrides of the Breeze default floor. {} = use defaults.
  floorOverrides: jsonb('floor_overrides').$type<AssuranceFloorOverrides>().notNull().default({}),
  // Enforcement choice. true = required (after enforceFrom) at every tier;
  // false = explicitly not required; null = inherit the platform default
  // (required for high/critical from APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM).
  // See services/authenticatorPolicy.ts resolveEffectivePolicy.
  requireEnrollment: boolean('require_enrollment'),
  enforceFrom: timestamp('enforce_from', { withTimezone: true }),
  updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type AuthenticatorPolicy = typeof authenticatorPolicies.$inferSelect;
export type NewAuthenticatorPolicy = typeof authenticatorPolicies.$inferInsert;
