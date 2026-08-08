/**
 * Script bundle format, v1 (#3245).
 *
 * A bundle is a portable JSON container for scripts moving between Breeze
 * instances (or in from another RMM). It is a durable public contract AND
 * untrusted input whose contents run as SYSTEM on customer endpoints, so this
 * schema is deliberately stricter than `createScriptSchema`:
 *
 * - No tenancy or trust fields. `id`, `orgId`, `partnerId`, `createdBy` and
 *   `isSystem` are not part of the schema; Zod object parsing strips unknown
 *   keys, so their presence in an uploaded file cannot carry through to the
 *   import path (the #633 hole in a new costume — never read the field).
 * - `parameters` is bounded at intake (size + depth). The route-level
 *   `createScriptSchema` types it `z.any()` and the 64KB cap at
 *   `routes/scripts.ts` is execute-time only; a bundle must not deliver an
 *   arbitrary attacker-authored jsonb blob into storage.
 * - An `exitCodeSeverityMapping` that maps every exit code to `null` is
 *   rejected: it would ship a SYSTEM-level script pre-configured never to
 *   raise an alert, neutering the after-the-fact abuse detection.
 * - An unknown `bundleVersion` is rejected with a clear error, never
 *   best-effort parsed.
 *
 * Categories and tags travel BY NAME, never by id — ids are meaningless
 * across instances and would leak the source tenant's identifiers.
 */
import { z } from 'zod';
import { exitCodeSeverityMappingSchema } from '@breeze/shared';

export const SCRIPT_BUNDLE_VERSION = 1;
/** Server-side cap on scripts per bundle. */
export const MAX_BUNDLE_SCRIPTS = 200;
/** Server-side cap on a single script's content (characters). */
export const MAX_BUNDLE_CONTENT_LENGTH = 256 * 1024;
/** Serialized-size cap on `parameters`, matching the execute-time cap. */
export const MAX_BUNDLE_PARAMETERS_BYTES = 64 * 1024;
/** Nesting-depth cap on `parameters`. */
export const MAX_BUNDLE_PARAMETERS_DEPTH = 8;
export const MAX_BUNDLE_TAGS_PER_SCRIPT = 20;

function jsonDepth(value: unknown, depth = 1): number {
  if (value === null || typeof value !== 'object') return depth;
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  let max = depth;
  for (const child of children) {
    // Short-circuit: no point measuring past the cap.
    if (max > MAX_BUNDLE_PARAMETERS_DEPTH) return max;
    const d = jsonDepth(child, depth + 1);
    if (d > max) max = d;
  }
  return max;
}

/**
 * Bounded replacement for the `z.any()` parameters field. Rejects payloads
 * that are not JSON-serializable, exceed 64KB serialized, or nest deeper than
 * MAX_BUNDLE_PARAMETERS_DEPTH levels — at intake, not at execute time.
 */
const boundedParametersSchema = z.unknown().superRefine((val, ctx) => {
  if (val === undefined || val === null) return;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(val);
  } catch {
    serialized = undefined;
  }
  if (typeof serialized !== 'string') {
    ctx.addIssue({ code: 'custom', message: 'parameters must be JSON-serializable' });
    return;
  }
  if (serialized.length > MAX_BUNDLE_PARAMETERS_BYTES) {
    ctx.addIssue({ code: 'custom', message: 'parameters too large (max 64KB)' });
  }
  if (jsonDepth(val) > MAX_BUNDLE_PARAMETERS_DEPTH) {
    ctx.addIssue({
      code: 'custom',
      message: `parameters nested too deeply (max depth ${MAX_BUNDLE_PARAMETERS_DEPTH})`
    });
  }
});

/**
 * `exitCodeSeverityMappingSchema` allows any value to be `null` ("no alert").
 * A mapping in which EVERY exit code is null is schema-valid but ships a
 * script pre-configured never to alert on any outcome — reject it and make
 * the importer re-add the mapping deliberately.
 */
const bundleSeverityMappingSchema = exitCodeSeverityMappingSchema
  .nullable()
  .optional()
  .superRefine((mapping, ctx) => {
    if (!mapping) return;
    const values = Object.values(mapping);
    if (values.length > 0 && values.every((v) => v === null)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'exitCodeSeverityMapping maps every exit code to null (never alert); remove the mapping or assign at least one severity'
      });
    }
  });

export const bundleScriptEntrySchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(10_000).optional(),
  category: z.string().min(1).max(100).optional(),
  tags: z.array(z.string().min(1).max(50)).max(MAX_BUNDLE_TAGS_PER_SCRIPT).optional(),
  osTypes: z.array(z.enum(['windows', 'macos', 'linux'])).min(1),
  language: z.enum(['powershell', 'bash', 'python', 'cmd']),
  content: z.string().min(1).max(MAX_BUNDLE_CONTENT_LENGTH),
  parameters: boundedParametersSchema.optional(),
  // Same bounds as createScriptSchema (agent executor clamps at 1 hour).
  timeoutSeconds: z.number().int().min(1).max(3600).default(300),
  runAs: z.enum(['system', 'user', 'elevated']).default('system'),
  exitCodeSeverityMapping: bundleSeverityMappingSchema
});

const bundleVersionSchema = z
  .number()
  .int()
  .refine((v) => v === SCRIPT_BUNDLE_VERSION, {
    message: `Unsupported bundleVersion — this server only understands version ${SCRIPT_BUNDLE_VERSION}`
  });

/**
 * The envelope the routes validate: version + a bounded array of UNVALIDATED
 * entries. Entries are validated individually inside the service so one bad
 * entry (e.g. a legitimately-authored script whose content exceeds the bundle
 * cap) fails per-entry instead of rejecting the whole bundle wholesale —
 * preview annotates it `invalid`, import records it in `errors` and proceeds.
 */
export const scriptBundleEnvelopeSchema = z.object({
  bundleVersion: bundleVersionSchema,
  exportedAt: z.string().optional(),
  scripts: z.array(z.unknown()).min(1).max(MAX_BUNDLE_SCRIPTS)
});

/** Fully-validated bundle shape — what export emits. */
export const scriptBundleSchema = z.object({
  bundleVersion: bundleVersionSchema,
  exportedAt: z.string().optional(),
  scripts: z.array(bundleScriptEntrySchema).min(1).max(MAX_BUNDLE_SCRIPTS)
});

export type ScriptBundleEntry = z.infer<typeof bundleScriptEntrySchema>;
export type ScriptBundle = z.infer<typeof scriptBundleSchema>;
export type ScriptBundleEnvelope = z.infer<typeof scriptBundleEnvelopeSchema>;

/** Flatten a Zod failure into a compact per-entry error message. */
export function formatEntryIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}
