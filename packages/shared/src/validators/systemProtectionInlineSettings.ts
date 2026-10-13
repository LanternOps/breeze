import { z } from 'zod';

// Zod schema for the `system_protection` configuration-policy inlineSettings
// JSONB (#4609). Controls whether the agent attempts a Windows System Restore
// checkpoint before each of three risky actions.
//
// STRICT, and NOT `.partial()`. Every field carries a default, so a policy that
// sets only one toggle still resolves to a complete typed decision, and an
// unknown key is a hard error rather than a value silently persisted into the
// JSONB mirror and ignored at runtime (the `vulnerability` feature type's
// unchecked cast is the anti-pattern this deliberately avoids).
//
// Defaults are LEGACY PARITY, not "all on":
//   beforePatching        true  -- the agent already attempts a point per
//                                 non-definitions update today, so defaulting
//                                 false would silently REMOVE protection.
//   beforeScripts         false -- new behaviour; opt in.
//   beforeSoftwareInstall false -- new behaviour; opt in.
//
// There is deliberately NO onFailure / abort field. v1 is reporting-only;
// strict modes land later as PER-ACTION `off | best_effort | require_recent`,
// which a single global knob cannot express.

// Codepoint check rather than a regex literal: the prefix is copied into a
// fixed-width UTF-16 native buffer AND into the unique restore-point
// description that identity verification string-matches on, so anything WMI
// might normalise or truncate is rejected up front.
function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

const labelPrefixSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((s) => s.trim().length > 0, { message: 'labelPrefix must not be blank' })
  .refine((s) => !hasControlCharacters(s), {
    message: 'labelPrefix must not contain control characters',
  });

export const systemProtectionInlineSettingsSchema = z
  .object({
    beforePatching: z.boolean().default(true),
    beforeScripts: z.boolean().default(false),
    beforeSoftwareInstall: z.boolean().default(false),
    labelPrefix: labelPrefixSchema.default('Breeze'),
  })
  .strict();

export type SystemProtectionInlineSettings = z.infer<typeof systemProtectionInlineSettingsSchema>;

/**
 * The single typed constant for "no policy assigned anywhere in the hierarchy".
 * The UI must distinguish this PLATFORM DEFAULT from an explicit policy value --
 * a tech reading the tab needs to know whether someone chose these or nobody has
 * configured anything.
 */
export const SYSTEM_PROTECTION_DEFAULTS: Readonly<SystemProtectionInlineSettings> = Object.freeze(
  systemProtectionInlineSettingsSchema.parse({}),
);
