import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, pgEnum } from 'drizzle-orm/pg-core';
import { partners, organizations } from './orgs';

export const userStatusEnum = pgEnum('user_status', ['active', 'invited', 'disabled']);
export const roleScopeEnum = pgEnum('role_scope', ['system', 'partner', 'organization']);
export const orgAccessEnum = pgEnum('org_access', ['all', 'selected', 'none']);
export const mfaMethodEnum = pgEnum('mfa_method', ['totp', 'sms']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  passwordHash: text('password_hash'),
  mfaSecret: text('mfa_secret'),
  mfaEnabled: boolean('mfa_enabled').notNull().default(false),
  mfaRecoveryCodes: jsonb('mfa_recovery_codes'),
  phoneNumber: text('phone_number'),
  phoneVerified: boolean('phone_verified').notNull().default(false),
  mfaMethod: mfaMethodEnum('mfa_method'),
  status: userStatusEnum('status').notNull().default('invited'),
  avatarUrl: text('avatar_url'),
  lastLoginAt: timestamp('last_login_at'),
  passwordChangedAt: timestamp('password_changed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').references(() => partners.id),
  orgId: uuid('org_id').references(() => organizations.id),
  parentRoleId: uuid('parent_role_id'),
  scope: roleScopeEnum('scope').notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  isSystem: boolean('is_system').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const permissions = pgTable('permissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  resource: varchar('resource', { length: 100 }).notNull(),
  action: varchar('action', { length: 50 }).notNull(),
  description: text('description')
});

export const rolePermissions = pgTable('role_permissions', {
  roleId: uuid('role_id').notNull().references(() => roles.id),
  permissionId: uuid('permission_id').notNull().references(() => permissions.id),
  constraints: jsonb('constraints')
});

export const partnerUsers = pgTable('partner_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  roleId: uuid('role_id').notNull().references(() => roles.id),
  orgAccess: orgAccessEnum('org_access').notNull().default('none'),
  orgIds: uuid('org_ids').array(),
  createdAt: timestamp('created_at').defaultNow().notNull()
});

export const organizationUsers = pgTable('organization_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  roleId: uuid('role_id').notNull().references(() => roles.id),
  siteIds: uuid('site_ids').array(),
  deviceGroupIds: uuid('device_group_ids').array(),
  createdAt: timestamp('created_at').defaultNow().notNull()
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull(),
  ipAddress: varchar('ip_address', { length: 45 }),
  userAgent: text('user_agent'),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull()
});

