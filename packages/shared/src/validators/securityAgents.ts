import { z } from 'zod';

// Inline settings for the `security_agents` configuration-policy feature type
// (#6960). Holds only NON-SECRET desired state: which third-party security
// agents a policy wants installed, and on which platforms. Per-customer keys,
// tokens and provisioning codes never live here: they stay in the existing
// integration/mapping tables (or tenant variables) and are substituted at
// dispatch.
//
// STRICT at both levels, so an `apiKey`/`orgKey` sent by a client or an
// assistant is rejected instead of persisted into the JSONB mirror.

export const SECURITY_AGENT_VENDOR_KEYS = ['huntress', 'sentinelone', 'controld', 'nextdns'] as const;
export type SecurityAgentVendorKey = (typeof SECURITY_AGENT_VENDOR_KEYS)[number];

export const SECURITY_AGENT_PLATFORMS = ['windows', 'macos', 'linux'] as const;
export type SecurityAgentPlatform = (typeof SECURITY_AGENT_PLATFORMS)[number];

const securityAgentEntrySchema = z
  .object({
    vendor: z.enum(SECURITY_AGENT_VENDOR_KEYS),
    enabled: z.boolean(),
    platforms: z
      .array(z.enum(SECURITY_AGENT_PLATFORMS))
      .min(1)
      .refine((list) => new Set(list).size === list.length, { message: 'platforms must not repeat' })
      .optional(),
  })
  .strict();

export const securityAgentsInlineSettingsSchema = z
  .object({
    version: z.literal(1),
    agents: z.array(securityAgentEntrySchema).max(SECURITY_AGENT_VENDOR_KEYS.length),
  })
  .strict()
  .superRefine((settings, ctx) => {
    const seen = new Set<string>();
    settings.agents.forEach((agent, index) => {
      if (seen.has(agent.vendor)) {
        ctx.addIssue({
          code: 'custom',
          path: ['agents', index, 'vendor'],
          message: `Vendor "${agent.vendor}" is listed more than once`,
        });
      }
      seen.add(agent.vendor);
    });
  });

export type SecurityAgentsInlineSettings = z.infer<typeof securityAgentsInlineSettingsSchema>;

/**
 * True when the payload asks to ENABLE any vendor, read leniently from the raw
 * input. Enabling a vendor arms installs on every device the policy reaches, so
 * the authorization check keys on this and must run before (and independently
 * of) strict validation: a malformed payload that asks to arm still needs the
 * arming permission to learn what is wrong with it.
 */
export function securityAgentsEnabledVendorRequested(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const agents = (raw as { agents?: unknown }).agents;
  if (!Array.isArray(agents)) return false;
  return agents.some((agent) => !!agent && typeof agent === 'object' && (agent as { enabled?: unknown }).enabled === true);
}
