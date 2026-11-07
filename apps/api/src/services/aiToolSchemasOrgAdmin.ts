/**
 * Input schemas for the W18 org-admin and identity read tools (full-control
 * W18, #6789). Every schema is `.strict()` and read-only: no tool here has a
 * write action (W18-1: user and role writes stay `identity`).
 */
import { z } from 'zod';

const uuid = z.string().guid();

export const ROLE_READ_ACTIONS = ['list', 'get', 'users', 'effective_permissions'] as const;

/** Decision 7: the default set and the cap of `get_account_readiness`. */
export const ACCOUNT_READINESS_TOOL_MAX_ORGS = 50;
/** Row cap of `list_portal_users`. */
export const PORTAL_USERS_TOOL_MAX = 100;
/** Row cap of `list_users` and of `list_roles` list / users. */
export const USERS_TOOL_MAX = 200;

export const orgAdminToolSchemas = {
  get_org_summary: z.object({
    orgId: uuid.describe('Organization UUID'),
  }).strict(),
  get_account_readiness: z.object({
    orgIds: z.array(uuid).min(1).max(ACCOUNT_READINESS_TOOL_MAX_ORGS).optional()
      .describe('Up to 50 organization UUIDs. Omit for your first 50 organizations by name.'),
    partnerId: uuid.optional().describe('Partner UUID; system scope only'),
  }).strict(),
  get_audit_retention: z.object({
    orgId: uuid.optional().describe("Organization UUID; defaults to an organization caller's own org"),
  }).strict(),
  list_portal_users: z.object({
    orgId: uuid.describe('Organization UUID'),
    limit: z.number().int().min(1).max(PORTAL_USERS_TOOL_MAX).optional().describe('Max rows (default 50, max 100)'),
  }).strict(),
  list_users: z.object({
    limit: z.number().int().min(1).max(USERS_TOOL_MAX).optional().describe('Max rows (default 100, max 200)'),
  }).strict(),
  get_user: z.object({
    userId: uuid.describe('Breeze user UUID from list_users'),
  }).strict(),
  list_roles: z.object({
    action: z.enum(ROLE_READ_ACTIONS),
    roleId: uuid.optional().describe('Role UUID; required except for list'),
    orgId: uuid.optional().describe("Partner callers: an organization UUID, to include that org's roles or read one of them"),
    limit: z.number().int().min(1).max(USERS_TOOL_MAX).optional().describe('Max rows for list and users (default 100, max 200)'),
  }).strict(),
} as const;

export type OrgAdminToolName = keyof typeof orgAdminToolSchemas;
