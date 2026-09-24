import semver from 'semver';
import { z } from 'zod';
import rawManifest from './breaking-changes.json';

/**
 * The cumulative breaking-change manifest (#6605).
 *
 * `breaking-changes.json` is bundled into the API image, so every image knows
 * every retirement a deployment on any older version could cross by upgrading
 * straight to it. Entries are never deleted: a self-hoster may jump from any
 * version to any later one, and the preflight can only warn about what this
 * file still describes. `breakingChangesManifest.test.ts` validates it in CI.
 *
 * Each entry is the written retirement contract the #6472 policy requires:
 * affected fields/endpoints, replacement, first deprecation version, earliest
 * removal date, actual removal version.
 */

const releaseVersion = z
  .string()
  .refine((v) => semver.valid(v) === v && semver.prerelease(v) === null, {
    message: 'must be a plain release version such as 0.116.0',
  });

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .refine((v) => {
    const parsed = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(v);
  }, 'must be a real calendar date');

const surfaceSchema = z.object({
  /** `METHOD /api/v1/path` as a caller would write it. */
  endpoint: z.string().regex(/^(GET|POST|PUT|PATCH|DELETE) \/\S+$/, 'must be "METHOD /path"'),
  /** Request/response fields affected on this endpoint; empty when the whole endpoint is retired. */
  fields: z.array(z.string().min(1)),
});

const entrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be kebab-case'),
    title: z.string().min(1),
    kind: z.enum(['api-request-field', 'api-response-field', 'api-endpoint', 'configuration']),
    surfaces: z.array(surfaceSchema).min(1),
    replacement: z.string().min(1),
    deprecatedIn: releaseVersion,
    deprecationBehaviour: z.string().min(1),
    earliestRemovalDate: isoDate,
    /** Null while the removal has not shipped in any version yet. */
    removedIn: releaseVersion.nullable(),
    removalBehaviour: z.string().min(1),
    references: z.array(z.string().min(1)),
  })
  .strict()
  // Guarded: zod can run this refinement even when a version field already
  // failed its own check, and semver throws on an invalid version.
  .refine((e) => e.removedIn === null || !semver.valid(e.deprecatedIn) || !semver.valid(e.removedIn)
    || semver.lte(e.deprecatedIn, e.removedIn), {
    message: 'removedIn must not precede deprecatedIn',
    path: ['removedIn'],
  });

const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    entries: z.array(entrySchema),
  })
  .strict();

export type BreakingChangeEntry = z.infer<typeof entrySchema>;
export type BreakingChangesManifest = z.infer<typeof manifestSchema>;

export function parseBreakingChangesManifest(input: unknown) {
  return manifestSchema.safeParse(input);
}

function loadBundledManifest(): { manifest: BreakingChangesManifest; error: string | null } {
  const result = parseBreakingChangesManifest(rawManifest);
  if (result.success) return { manifest: result.data, error: null };
  // CI keeps this unreachable. If it is ever reached, the preflight reports the
  // defect instead of throwing at module load, which would crash boot.
  return {
    manifest: { schemaVersion: 1, entries: [] },
    error: `breaking-changes.json failed validation: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
  };
}

const loaded = loadBundledManifest();

export const BREAKING_CHANGES_MANIFEST: BreakingChangesManifest = loaded.manifest;
/** Non-null only when the bundled manifest is malformed. */
export const BREAKING_CHANGES_MANIFEST_ERROR: string | null = loaded.error;
