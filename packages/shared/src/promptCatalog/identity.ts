import { z } from 'zod';
import { PROMPT_LOGO_MAX_BYTES, PROMPT_LOGO_MIMES } from '../promptHost/schema';
import { PROMPT_PARTNER_NAME_MAX_CODE_POINTS, sanitizePromptPartnerName } from './sanitize';

/**
 * The heartbeat response block `promptIdentity` (spec §3.6, plan Task 3.2/3.3):
 * the MSP identity every device prompt is drawn under. Produced by the API
 * (`resolvePromptIdentity`), consumed by the agent (`promptidentity.Store`).
 * Pinned by fixtures/prompt-catalog/heartbeat-identity.*.json (decoded here
 * and by the agent's promptidentity package, W03 3C). The schema is strict so
 * a producer typo fails the API tests; the agent decoder stays lenient and
 * ignores unknown keys (forward compatibility).
 *
 * - Sent only to agents whose `securityCapabilities.promptIdentityProtocolVersion`
 *   is PROMPT_IDENTITY_PROTOCOL_VERSION; an absent block keeps the agent's
 *   last-known identity (resolution failure omits the block).
 * - `state: 'cleared'` deletes the cached identity.
 * - `partnerName` is already sanitized (sanitizePromptPartnerName); absent
 *   means the renderer shows the localized generic name. The agent sanitizes
 *   again (defence in depth).
 * - `logo` is metadata only. The agent fetches the bytes over its
 *   authenticated channel from PROMPT_IDENTITY_LOGO_ROUTE and checks the
 *   sha256; the device never fetches a remote URL.
 * - A `scopeId` change (org move, partner change) clears the identity and
 *   purges prompt-list entries created under the old scope before anything
 *   else in that heartbeat is applied.
 */
export const PROMPT_IDENTITY_PROTOCOL_VERSION = 1 as const;

/** Agent-authenticated; answers only for the current sha256, else 404. */
export const PROMPT_IDENTITY_LOGO_ROUTE = '/api/v1/agents/:id/prompt-identity/logo?sha256=<hex>' as const;

export const promptIdentityScopeIdSchema = z.string().regex(/^[0-9a-f]{32}$/);

export const promptIdentityLogoMetaSchema = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mime: z.enum(PROMPT_LOGO_MIMES),
  bytes: z.number().int().min(1).max(PROMPT_LOGO_MAX_BYTES),
});

export const promptIdentityBlockSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('cleared') }),
  z.strictObject({
    state: z.literal('set'),
    scopeId: promptIdentityScopeIdSchema,
    partnerName: z
      .string()
      .min(1)
      .refine((s) => Array.from(s).length <= PROMPT_PARTNER_NAME_MAX_CODE_POINTS, {
        message: `partnerName is longer than ${PROMPT_PARTNER_NAME_MAX_CODE_POINTS} code points`,
      })
      .refine((s) => sanitizePromptPartnerName(s) === s, { message: 'partnerName is not sanitized' })
      .optional(),
    primaryColor: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/)
      .optional(),
    logo: promptIdentityLogoMetaSchema.optional(),
  }),
]);

export type PromptIdentityBlock = z.infer<typeof promptIdentityBlockSchema>;
export type PromptIdentityLogoMeta = z.infer<typeof promptIdentityLogoMetaSchema>;
