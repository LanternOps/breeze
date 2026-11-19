import { z } from 'zod';

// Inline settings for the `wake_on_lan` configuration-policy feature (#10838).
// Inline-only: featurePolicyId stays NULL. STRICT so an unknown key is a hard
// error rather than a value persisted and ignored.
//
// buttonMode decides when the Wake button shows on an offline device:
//   always   - every offline device (today's behaviour)
//   verified - only devices whose wake readiness is proven
export const WAKE_BUTTON_MODES = ['verified', 'always'] as const;
export type WakeButtonMode = (typeof WAKE_BUTTON_MODES)[number];

// configureSettings is z.literal(false) until writes ship (W06 turns them on).
export const wakeOnLanInlineSettingsSchema = z.object({
  configureSettings: z.literal(false),
  buttonMode: z.enum(WAKE_BUTTON_MODES),
}).strict();

export type WakeOnLanInlineSettings = z.infer<typeof wakeOnLanInlineSettingsSchema>;

// Before W06 the form defaults to 'always': nothing can turn WOL on yet, so
// 'verified' would hide buttons.
export const WAKE_ON_LAN_PLATFORM_DEFAULT: WakeOnLanInlineSettings = {
  configureSettings: false,
  buttonMode: 'always',
};
