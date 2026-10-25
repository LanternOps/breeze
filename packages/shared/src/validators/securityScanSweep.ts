import { z } from 'zod';
import type { SecuritySweepScope } from '../types/securityScanSweep';
import {
  SECURITY_SCAN_PATH_MAX_CHARS,
  SECURITY_SWEEP_MAX_PATHS,
  SECURITY_SWEEP_SCAN_TYPES,
  SECURITY_SWEEP_TTL_HOURS_MAX,
} from '../types/securityScanSweep';
import { YARA_MAX_RULE_SETS_PER_POLICY } from '../types/yara';

/**
 * One custom-scan path. The single definition: the single-device scan route
 * (`POST /security/scan/:deviceId`) and the sweep request both use it.
 */
export const securityScanPathSchema = z.string().min(1).max(SECURITY_SCAN_PATH_MAX_CHARS);

const idList = (max: number) => z.array(z.string().guid()).min(1).max(max);

export const securitySweepScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }).strict(),
  z.object({ kind: z.literal('orgs'), orgIds: idList(100) }).strict(),
  z.object({ kind: z.literal('sites'), siteIds: idList(200) }).strict(),
  z.object({ kind: z.literal('groups'), groupIds: idList(50) }).strict(),
  z.object({ kind: z.literal('devices'), deviceIds: idList(1000) }).strict(),
]);

// Compile-time: the schema and the hand-written SecuritySweepScope union agree.
type SchemaScope = z.infer<typeof securitySweepScopeSchema>;
type ScopeAgrees = SchemaScope extends SecuritySweepScope ? (SecuritySweepScope extends SchemaScope ? true : false) : false;
true satisfies ScopeAgrees;

const sweepRequestShape = {
  ruleSetIds: z
    .array(z.string().guid())
    .min(1)
    .max(YARA_MAX_RULE_SETS_PER_POLICY)
    .refine((list) => new Set(list.map((v) => v.toLowerCase())).size === list.length, {
      message: 'ruleSetIds must not repeat',
    }),
  scope: securitySweepScopeSchema,
  scanType: z.enum(SECURITY_SWEEP_SCAN_TYPES),
  paths: z.array(securityScanPathSchema).min(1).max(SECURITY_SWEEP_MAX_PATHS).optional(),
  ttlHours: z.number().int().min(1).max(SECURITY_SWEEP_TTL_HOURS_MAX).optional(),
};

// `.refine` on the object (not `superRefine` after a failed field check): zod 4
// skips object-level refinements when a field already failed, which is the
// behaviour we want — the field error is the one reported.
const pathsMatchScanType = (value: { scanType: string; paths?: string[] }) =>
  (value.scanType === 'custom') === (value.paths !== undefined);
const pathsMessage = { message: 'paths is required for a custom scan and not allowed otherwise', path: ['paths'] };

export const securitySweepRequestSchema = z.object(sweepRequestShape).strict().refine(pathsMatchScanType, pathsMessage);

export const securitySweepCreateSchema = z
  .object({ ...sweepRequestShape, previewDigest: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict()
  .refine(pathsMatchScanType, pathsMessage);

export type SecuritySweepRequest = z.infer<typeof securitySweepRequestSchema>;
export type SecuritySweepCreateRequest = z.infer<typeof securitySweepCreateSchema>;
