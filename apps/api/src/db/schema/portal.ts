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
  // Parked: the checkout/checkin API and admin toggle exist, but
  // the customer portal never received the Check out / Check in UI, so an org
  // with this on gets an "Equipment" page that duplicates Devices and can't
  // borrow anything. Off by default until the portal side ships.
  enableAssetCheckout: boolean('enable_asset_checkout').notNull().default(false),
  enableSelfService: boolean('enable_self_service').notNull().default(true),
  enablePasswordReset: boolean('enable_password_reset').notNull().default(true),
  // Portal visibility Wave 1 (#4562): per-org gates for the customer portal
  // left-nav sections. Fail-closed defaults — false for every existing org.
  enableDashboard: boolean('enable_dashboard').notNull().default(false),
  enableSecurity: boolean('enable_security').notNull().default(false),
  enableBackups: boolean('enable_backups').notNull().default(false),
  enableReports: boolean('enable_reports').notNull().default(false),
  enableSupportUsage: boolean('enable_support_usage').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const portalUsers = pgTable('portal_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  email: varchar('email', { length: 255 }).notNull(),
  name: varchar('name', { length: 255 }),
  passwordHash: text('password_hash'),
  // Entra ID (AI for Office) identity. Partial unique index
  // portal_users_entra_identity_uniq on (entra_tenant_id, entra_oid)
  // WHERE entra_oid IS NOT NULL is created via SQL migration
  // (2026-06-12-b-client-ai-foundation.sql), mirroring the ai_sessions
  // partial-index convention.
  entraOid: text('entra_oid'),
  entraTenantId: text('entra_tenant_id'),
  authMethod: text('auth_method').notNull().default('password'), // 'password' | 'entra' (SQL CHECK)
  linkedUserId: uuid('linked_user_id').references(() => users.id),
  // A portal user is a LOGIN attached to a contact, not a second kind of
  // person (#3258). Nullable because the link is established after the fact by
  // three writers: the backfill in 2026-08-19-contacts.sql, the INVITE path
  // (`resolveInviteContact` in routes/orgPortalUsers.ts, which links an
  // existing contact or creates one and never overwrites a link already
  // there), and the same backfill again in
  // 2026-10-04-100000-ticket-requester-contact.sql for tickets.
  //
  // Inbound email does NOT write here any more (#3258 W03): it used to mint a
  // password-less row per unknown sender, and now resolves the sender onto
  // `contacts` instead — see inboundEmail/resolveOrg.resolveEmailRequester.
  // Rows can therefore still have a null link (Entra SSO provisioning and the
  // Outlook add-in's "create contact" both create logins without one).
  //
  // Declared as a plain nullable uuid on purpose: the real constraint is the
  // COMPOSITE same-org FK `portal_users_contact_org_fk` (contact_id, org_id)
  // -> contacts (id, org_id), DEFERRABLE INITIALLY IMMEDIATE with a column-list
  // `ON DELETE SET NULL (contact_id)` so deleting a contact unlinks the login
  // instead of failing on the NOT NULL org_id. A login and its contact
  // therefore CANNOT belong to different organizations — that is a database
  // guarantee now, not a convention every writer has to honour. It lives in
  // SQL only (2026-10-04-100002-portal-users-contact-composite-fk.sql), the
  // same convention as tickets.requesterContactId below and this table's
  // partial unique index on the Entra identity.
  contactId: uuid('contact_id'),
  receiveNotifications: boolean('receive_notifications').notNull().default(true),
  lastLoginAt: timestamp('last_login_at'),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  invitedBy: uuid('invited_by').references(() => users.id),
  invitedAt: timestamp('invited_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

// P2-4 (#4191): tickets also gains a composite-FK target unique index,
// `tickets_id_org_uq` on (id, org_id) — a plain `CREATE UNIQUE INDEX` in
// 2026-09-25-ai-agents-ticket-triage.sql, not modeled here as a Drizzle
// table-option (same "SQL migration only" convention as this table's own
// categoryId/statusId FKs above — see their inline comments). It backs
// ticket_drafts.ticketId and action_intents.scopeTicketId's composite FKs
// (ticketDrafts.ts, actionIntents.ts).
export const tickets = pgTable('tickets', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  ticketNumber: varchar('ticket_number', { length: 50 }).notNull().unique(),
  submittedBy: uuid('submitted_by').references(() => portalUsers.id),
  // #3258 W03: the canonical PERSON on the ticket. `submitted_by` stays the
  // OPTIONAL portal LOGIN — an inbound email now creates a contact and no
  // portal_users row at all, so it is this column, not submitted_by, that
  // every person-backed ticket carries.
  //
  // Declared as a plain nullable uuid on purpose: the real constraint is the
  // COMPOSITE same-org FK `tickets_requester_contact_org_fk`
  // (requester_contact_id, org_id) -> contacts (id, org_id), DEFERRABLE
  // INITIALLY IMMEDIATE with a column-list `ON DELETE SET NULL
  // (requester_contact_id)` so deleting a contact never nulls the NOT NULL
  // org_id. That lives in SQL only (2026-10-04-100000-ticket-requester-contact.sql)
  // — same "SQL migration only" convention as this table's categoryId/statusId.
  requesterContactId: uuid('requester_contact_id'),
  submitterEmail: varchar('submitter_email', { length: 255 }),
  submitterName: varchar('submitter_name', { length: 255 }),
  subject: varchar('subject', { length: 255 }).notNull(),
  description: text('description'),
  category: varchar('category', { length: 100 }),
  status: ticketStatusEnum('status').notNull().default('new'),
  priority: ticketPriorityEnum('priority').notNull().default('normal'),
  assignedTo: uuid('assigned_to').references(() => users.id),
  deviceId: uuid('device_id').references(() => devices.id),
  tags: text('tags').array().default([]),
  customFields: jsonb('custom_fields'),
  externalTicketId: varchar('external_ticket_id', { length: 255 }),
  externalTicketUrl: text('external_ticket_url'),
  firstResponseAt: timestamp('first_response_at'),
  resolvedAt: timestamp('resolved_at'),
  closedAt: timestamp('closed_at'),
  partnerId: uuid('partner_id').references(() => partners.id),
  categoryId: uuid('category_id'), // FK created in SQL; no .references() here to avoid an import cycle with schema/tickets.ts. Composite (category_id, partner_id) -> ticket_categories also in SQL (2026-06-10-c) — same-partner categories enforced at the DB level.
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
  statusId: uuid('status_id'),  // FK + ON DELETE SET NULL added in SQL (ticketStatuses lives in ticketConfig.ts — avoid a circular import; same pattern as categoryId above)
  // Soft-delete (Phase 6). A non-null deletedAt hides the ticket from every
  // staff/portal list, stats count, and by-id mutation (getScopedTicketOr404),
  // but preserves the row for audit and admin restore. Mirrors ticket_comments'
  // deletedAt (defined below). Hard purge (if ever added) is a separate retention job.
  deletedAt: timestamp('deleted_at'),
  deletedBy: uuid('deleted_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  // P2-4 (#4191): per-field authorship map for AI-assisted edits — keys are
  // ticket column names (e.g. 'subject', 'category'), values are the
  // principal kind that last set that field. NOT NULL DEFAULT {} so every
  // pre-existing row backfills to "nobody has attributed this field yet"
  // rather than NULL. jsonb -> excludedOpen in the export policy regardless
  // of contents (CLAUDE.md: any json/jsonb/bytea column is excludedOpen).
  fieldProvenance: jsonb('field_provenance')
    .$type<Record<string, 'user' | 'ai_agent' | 'system'>>()
    .notNull()
    .default({})
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
  editedAt: timestamp('edited_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  // Wave 6 PR 3 (#3828) — origin-based loop guard for the ticket-shadow
  // helpdesk subscriber (design authority: never 'source'-string matching).
  //
  // Deliberate deviation from action_intents.origin_principal_kind's
  // fail-closed 'unknown' default: every ticket_comments row that predates
  // this column IS human/user-authored (no agent write path into this table
  // exists before this PR — Task 3's shadow gating denies manage_tickets
  // mutations for ticket runs, and the deferred autonomous-note lane is not
  // built), so DEFAULT 'user' is correct here. The admitted vocabulary itself
  // is shared with action_intents' CHECK, not private: 'ai_agent' (never bare
  // 'agent' — that literal means the opposite principal on action_intents),
  // plus 'system'/'unknown' for future fail-closed writers. The loop guard
  // (ticketHelpdeskSubscriber, Task 3) treats anything NOT 'user' as suspect
  // and skips admission — see the migration header for the full rationale.
  originPrincipalKind: text('origin_principal_kind').notNull().default('user'),
  // Loop-guard link to the agent run that authored this comment. Written by
  // addAiTriageNote() (services/ticketService.ts, P2-4a #4300) — every
  // AI-agent `comment` tool call that carries an agentRunId inserts a row
  // here with a live value, so this is NOT a preemptive/unwritten column
  // (an earlier version of this comment said otherwise; corrected alongside
  // #4644, which found and backfilled the resulting stale-pointer rows).
  // Deliberately NOT `.references(() => aiAgentRuns.id, ...)` here: aiAgents.ts
  // already imports `tickets` from this file (for ai_agent_runs.ticket_id),
  // so a reverse import would be a circular module dependency. The actual FK
  // (ON DELETE SET NULL) is declared in the SQL migration only — same
  // established pattern as this table's own categoryId/statusId columns
  // above, for the identical reason.
  //
  // P2-4 (#4191, 2026-09-25-ai-agents-ticket-triage.sql): also carries a
  // partial unique index, `ticket_comments_one_ai_note_per_run_uq` ON
  // ticket_comments (agent_run_id) WHERE agent_run_id IS NOT NULL AND
  // origin_principal_kind = 'ai_agent' — at most one AI-authored comment per
  // run. Not modeled in Drizzle for the same "partial index" reason as
  // ticketDrafts.ts's ticket_drafts_active_uq.
  agentRunId: uuid('agent_run_id')
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
