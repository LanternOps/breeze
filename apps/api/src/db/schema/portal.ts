import { pgTable, uuid, varchar, text, integer, timestamp, boolean, jsonb, pgEnum } from 'drizzle-orm/pg-core';
import { organizations, partners } from './orgs';
import { devices } from './devices';
import { users } from './users';

export const ticketStatusEnum = pgEnum('ticket_status', ['new', 'open', 'pending', 'on_hold', 'resolved', 'closed']);
export const ticketPriorityEnum = pgEnum('ticket_priority', ['low', 'normal', 'high', 'urgent']);
export const ticketSourceEnum = pgEnum('ticket_source', ['portal', 'email', 'alert', 'manual', 'api', 'ai']);
export const ticketCommentTypeEnum = pgEnum('ticket_comment_type', ['comment', 'internal', 'status_change', 'assignment', 'time_entry', 'system']);

export const portalBranding = pgTable('portal_branding', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id).unique(),
  logoUrl: text('logo_url'),
  faviconUrl: text('favicon_url'),
  primaryColor: varchar('primary_color', { length: 50 }),
  secondaryColor: varchar('secondary_color', { length: 50 }),
  accentColor: varchar('accent_color', { length: 50 }),
  customDomain: varchar('custom_domain', { length: 255 }),
  domainVerified: boolean('domain_verified').notNull().default(false),
  welcomeMessage: text('welcome_message'),
  supportEmail: varchar('support_email', { length: 255 }),
  supportPhone: varchar('support_phone', { length: 50 }),
  footerText: text('footer_text'),
  customCss: text('custom_css'),
  enableTickets: boolean('enable_tickets').notNull().default(true),
  enableAssetCheckout: boolean('enable_asset_checkout').notNull().default(true),
  enableSelfService: boolean('enable_self_service').notNull().default(true),
  enablePasswordReset: boolean('enable_password_reset').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const portalUsers = pgTable('portal_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  email: varchar('email', { length: 255 }).notNull(),
  name: varchar('name', { length: 255 }),
  passwordHash: text('password_hash'),
  linkedUserId: uuid('linked_user_id').references(() => users.id),
  receiveNotifications: boolean('receive_notifications').notNull().default(true),
  lastLoginAt: timestamp('last_login_at'),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const tickets = pgTable('tickets', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  ticketNumber: varchar('ticket_number', { length: 50 }).notNull().unique(),
  submittedBy: uuid('submitted_by').references(() => portalUsers.id),
  submitterEmail: varchar('submitter_email', { length: 255 }),
  submitterName: varchar('submitter_name', { length: 255 }),
  subject: varchar('subject', { length: 255 }).notNull(),
  description: text('description'),
  category: varchar('category', { length: 100 }),
  status: ticketStatusEnum('status').notNull().default('new'),
  priority: ticketPriorityEnum('priority').notNull().default('normal'),
  assignedTo: uuid('assigned_to').references(() => users.id),
  assignedTeam: uuid('assigned_team'),
  deviceId: uuid('device_id').references(() => devices.id),
  tags: text('tags').array().default([]),
  customFields: jsonb('custom_fields'),
  externalTicketId: varchar('external_ticket_id', { length: 255 }),
  externalTicketUrl: text('external_ticket_url'),
  firstResponseAt: timestamp('first_response_at'),
  resolvedAt: timestamp('resolved_at'),
  closedAt: timestamp('closed_at'),
  partnerId: uuid('partner_id').references(() => partners.id),
  categoryId: uuid('category_id'), // FK created in SQL; no .references() here to avoid an import cycle with schema/tickets.ts
  pendingReason: text('pending_reason'),
  dueDate: timestamp('due_date'),
  responseSlaMinutes: integer('response_sla_minutes'),
  resolutionSlaMinutes: integer('resolution_sla_minutes'),
  slaBreachedAt: timestamp('sla_breached_at'),
  slaBreachReason: text('sla_breach_reason'),
  slaPausedAt: timestamp('sla_paused_at'),
  slaPausedMinutes: integer('sla_paused_minutes').default(0),
  source: ticketSourceEnum('source').notNull().default('portal'),
  internalNumber: varchar('internal_number', { length: 20 }),
  emailMessageId: text('email_message_id'),
  emailThreadKey: text('email_thread_key'),
  closedBy: uuid('closed_by').references(() => users.id),
  resolutionNote: text('resolution_note'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const ticketComments = pgTable('ticket_comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id),
  portalUserId: uuid('portal_user_id').references(() => portalUsers.id),
  userId: uuid('user_id').references(() => users.id),
  authorName: varchar('author_name', { length: 255 }),
  authorType: varchar('author_type', { length: 50 }),
  content: text('content').notNull(),
  isPublic: boolean('is_public').notNull().default(true),
  attachments: jsonb('attachments').default([]),
  commentType: ticketCommentTypeEnum('comment_type').notNull().default('comment'),
  oldValue: text('old_value'),
  newValue: text('new_value'),
  deletedAt: timestamp('deleted_at'),
  createdAt: timestamp('created_at').defaultNow().notNull()
});

export const assetCheckouts = pgTable('asset_checkouts', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  checkedOutTo: uuid('checked_out_to').references(() => portalUsers.id),
  checkedOutToName: varchar('checked_out_to_name', { length: 255 }),
  checkedOutAt: timestamp('checked_out_at').defaultNow().notNull(),
  expectedReturnAt: timestamp('expected_return_at'),
  checkedInAt: timestamp('checked_in_at'),
  checkedInBy: uuid('checked_in_by').references(() => users.id),
  checkoutNotes: text('checkout_notes'),
  checkinNotes: text('checkin_notes'),
  condition: varchar('condition', { length: 100 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});
