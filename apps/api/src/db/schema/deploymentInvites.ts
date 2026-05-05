import { foreignKey, pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { partners, organizations, enrollmentKeys } from './orgs';
import { apiKeys } from './apiKeys';
import { devices } from './devices';

export const deploymentInvites = pgTable('deployment_invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  enrollmentKeyId: uuid('enrollment_key_id').notNull().references(() => enrollmentKeys.id, { onDelete: 'cascade' }),
  invitedEmail: text('invited_email').notNull(),
  invitedByApiKeyId: uuid('invited_by_api_key_id').references(() => apiKeys.id),
  customMessage: text('custom_message'),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  clickedAt: timestamp('clicked_at', { withTimezone: true }),
  enrolledAt: timestamp('enrolled_at', { withTimezone: true }),
  deviceId: uuid('device_id').references(() => devices.id),
  status: text('status').notNull().default('sent'),
}, (table) => ({
  deploymentInvitesOrgPartnerFk: foreignKey({
    columns: [table.orgId, table.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
    name: 'deployment_invites_org_partner_fk',
  }),
}));

export type DeploymentInvite = typeof deploymentInvites.$inferSelect;
export type NewDeploymentInvite = typeof deploymentInvites.$inferInsert;
