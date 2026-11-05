import { z } from 'zod';
import { OEM_CATEGORIES, OEM_LANES, OEM_OUTCOMES } from '../utils/oemUpdates';

/**
 * OEM vendor-update command wire contracts. The agent's Go types will mirror these JSON shapes in a
 * later wave. Every object is strict (an unknown key at any depth is rejected) and every string is
 * bounded, because vendor tool output is untrusted.
 */

const laneSchema = z.enum(OEM_LANES);
const categorySchema = z.enum(OEM_CATEGORIES);
const versionSchema = z.string().min(1).max(64);

const sha256Schema = z.string().regex(/^[0-9a-fA-F]{64}$/, 'sha256 must be 64 hex characters');

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
    title: z.string().max(200),
    category: categorySchema,
    version: z.string().max(64),
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
    toolVersion: z.string().max(64).nullable(),
    rawExitCode: z.number().int().nullable(),
    errorCode: z.string().max(64).nullable(),
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
    biosVersionAfter: z.string().max(64).nullable(),
  })
  .strict();
export type OemUpdateVerification = z.infer<typeof oemUpdateVerificationSchema>;
