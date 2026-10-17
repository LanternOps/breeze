// packages/shared/src/validators/trustCenterTemplate.ts
// Owner: W02g (partner-wide trust page template) — Trust Center W2 (#8770, spec §18.8, §19 item 33).
import { z } from 'zod';
import { TELEMETRY_CONTROL_IDS, TRUST_FRAMEWORKS } from '../trustCenter/types';
import { TRUST_INTRO_MAX_CHARS, telemetryControlIdSchema, trustFrameworkSchema } from './trustCenter';

/** null = clear the template's value, so the setting falls through to the Breeze default. Omitted = unchanged. */
const templateBoolean = z.boolean().nullable().optional();

/**
 * PUT /trust-page-template. Only the inheritable settings (TRUST_SETTING_KEYS) live on the template; org-only
 * fields (contact email, website, NDA text, documents) are rejected by the strict object.
 */
export const trustTemplateUpdateSchema = z.strictObject({
  /** Raw editor HTML, sanitized server-side. null = no template intro (inherit); '' = template says "no intro". */
  introHtml: z.string().max(TRUST_INTRO_MAX_CHARS).nullable().optional(),
  searchIndexable: templateBoolean,
  showPercentages: templateBoolean,
  showDeviceCount: templateBoolean,
  showManagedBy: templateBoolean,
  showHistory: templateBoolean,
  hiddenControlIds: z.array(telemetryControlIdSchema).max(TELEMETRY_CONTROL_IDS.length).nullable().optional(),
  frameworkView: z.array(trustFrameworkSchema).max(TRUST_FRAMEWORKS.length)
    .refine((v) => new Set(v).size === v.length, 'duplicate framework')
    .nullable().optional(),
  /** The template revision the form loaded (0 = no template yet); a stale value → 409 REVISION_MISMATCH. */
  expectedRevision: z.number().int().min(0),
});
export type TrustTemplateUpdateInput = z.infer<typeof trustTemplateUpdateSchema>;
