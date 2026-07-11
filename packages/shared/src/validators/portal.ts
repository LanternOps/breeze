import { z } from 'zod';

// Admin-writable subset of portal_branding (feature toggles + support contact).
// Visual branding (logo, colors, customCss) and customDomain/domainVerified are
// deliberately NOT writable here — they ship with the domain-verification
// project. `.strict()` is the enforcement: unknown keys are rejected.
export const updatePortalSettingsSchema = z.object({
  enableTickets: z.boolean().optional(),
  enableAssetCheckout: z.boolean().optional(),
  enableSelfService: z.boolean().optional(),
  enablePasswordReset: z.boolean().optional(),
  supportEmail: z.string().email().max(255).nullable().optional(),
  supportPhone: z.string().max(50).nullable().optional(),
  welcomeMessage: z.string().max(2000).nullable().optional(),
  footerText: z.string().max(2000).nullable().optional()
}).strict();

export type UpdatePortalSettingsInput = z.infer<typeof updatePortalSettingsSchema>;

// MSP-facing portal-user management (customer-portal onboarding). Invite a
// single portal user by email; bulk-invite a set of existing (pre-created)
// portal users by id; update a portal user's editable fields. `status` here
// is deliberately limited to active/disabled — 'invited' is a system-set
// state, not something an MSP can set directly via this endpoint.
export const invitePortalUserSchema = z.object({
  email: z.string().email().max(255),
  name: z.string().min(1).max(255).optional(),
  message: z.string().max(1000).optional()
}).strict();
export type InvitePortalUserInput = z.infer<typeof invitePortalUserSchema>;

export const bulkInvitePortalUsersSchema = z.object({
  userIds: z.array(z.string().guid()).optional()
}).strict();
export type BulkInvitePortalUsersInput = z.infer<typeof bulkInvitePortalUsersSchema>;

export const updatePortalUserSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  receiveNotifications: z.boolean().optional(),
  status: z.enum(['active', 'disabled']).optional()
}).strict();
export type UpdatePortalUserInput = z.infer<typeof updatePortalUserSchema>;
