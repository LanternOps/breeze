import { z } from 'zod';
import { OEM_CATEGORIES, OEM_LANES, OEM_OUTCOMES } from '../utils/oemUpdates';

/**
 * OEM vendor-update command wire contracts. The agent's Go types will mirror these JSON shapes in a
 * later wave. Every object is strict (an unknown key at any depth is rejected) and every string is
 * bounded, because vendor tool output is untrusted.
 */

const laneSchema = z.enum(OEM_LANES);
const categorySchema = z.enum(OEM_CATEGORIES);
// Text that may come from a vendor tool: no control characters, so it cannot forge
// a log line or a terminal escape wherever it is shown.
const NO_CONTROL_CHARS = /^[^\u0000-\u001f\u007f]*$/;
const toolText = (max: number) => z.string().max(max).regex(NO_CONTROL_CHARS, 'must not contain control characters');

const versionSchema = toolText(64).min(1);

// Lowercase only: the manifest is ours, and the agent compares the digest as text.
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex characters');

const httpsUrlSchema = z
  .string()
  .max(2048)
  .url()
  .refine((u) => {
    try {
      return new URL(u).protocol === 'https:';
    } catch {
      return false;
    }
  }, { message: 'url must be https' });

const prerequisiteSchema = z
  .object({
    name: z.string().min(1).max(64),
    minVersion: versionSchema,
    url: httpsUrlSchema,
    sha256: sha256Schema,
  })
  .strict();

const toolSchema = z
  .object({
    version: versionSchema,
    minSafeVersion: versionSchema,
    supportedRange: z.object({ min: versionSchema, maxExclusive: versionSchema }).strict(),
    url: httpsUrlSchema,
    sha256: sha256Schema,
    prerequisites: z.array(prerequisiteSchema).max(8),
  })
  .strict();

export const oemUpdateRunPayloadSchema = z
  .object({
    lane: laneSchema,
    trigger: z.enum(['scheduled', 'on_demand']),
    occurrenceKey: z.string().max(64).nullable(),
    categories: z
      .array(categorySchema)
      .min(1)
      .max(4)
      .refine((c) => new Set(c).size === c.length, { message: 'categories must be unique' }),
    blockedUpdateIds: z.array(z.string().min(1).max(128)).max(200),
    rebootControlled: z.boolean(),
    notAfter: z.string().datetime({ offset: true }),
    escrowedProtectorIds: z.array(z.string().uuid()).max(16),
    tool: toolSchema.nullable(),
  })
  .strict();
export type OemUpdateRunPayload = z.infer<typeof oemUpdateRunPayloadSchema>;

const resultItemSchema = z
  .object({
    title: toolText(200),
    category: categorySchema,
    version: toolText(64),
    result: z.enum(['installed', 'failed', 'skipped']),
  })
  .strict();

const skippedCategorySchema = z
  .object({
    category: categorySchema,
    reason: z.enum(['gate', 'no_reboot_control', 'no_recovery_key', 'power']),
  })
  .strict();

export const oemUpdateRunResultSchema = z
  .object({
    lane: laneSchema,
    outcome: z.enum(OEM_OUTCOMES),
    toolVersion: toolText(64).nullable(),
    // A Windows exit code is a DWORD, often reported signed: either reading fits.
    rawExitCode: z.number().int().min(-2147483648).max(4294967295).nullable(),
    errorCode: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_.:-]+$/, 'errorCode must be an identifier')
      .nullable(),
    rebootRequired: z.boolean(),
    shutdownRequired: z.boolean(),
    items: z.array(resultItemSchema).max(200),
    skippedCategories: z.array(skippedCategorySchema).max(4),
    takeover: z.enum(['ok', 'policy_locked', 'not_attempted']),
  })
  .strict();
export type OemUpdateRunResult = z.infer<typeof oemUpdateRunResultSchema>;

export const oemUpdateVerificationSchema = z
  .object({
    commandId: z.string().uuid(),
    bitlockerAfter: z.enum(['on', 'suspended', 'off', 'unknown']),
    biosVersionAfter: toolText(64).nullable(),
  })
  .strict();
export type OemUpdateVerification = z.infer<typeof oemUpdateVerificationSchema>;

/** Hand a vendor tool's own update schedule back (restore what Breeze changed when it took over). */
export const oemUpdateReleasePayloadSchema = z.object({ lane: z.enum(OEM_LANES) }).strict();
export type OemUpdateReleasePayload = z.infer<typeof oemUpdateReleasePayloadSchema>;

export const oemUpdateReleaseResultSchema = z
  .object({
    lane: z.enum(OEM_LANES),
    outcome: z.enum(['restored', 'nothing_to_restore', 'failed']),
    errorCode: z.string().regex(/^[A-Za-z0-9_.:-]+$/).max(64).nullable().optional(),
  })
  .strict();
export type OemUpdateReleaseResult = z.infer<typeof oemUpdateReleaseResultSchema>;
