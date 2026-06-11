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
