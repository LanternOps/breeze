import { z } from 'zod';

export const PARTNER_EXPORT_RESOURCES = [
  'organizations',
  'sites',
  'devices',
  'device-inventory',
  'device-software',
  'device-relationships',
  'configuration-policies',
  'configuration-assignments',
  'scripts',
  'automations',
  'backup-configurations',
  'custom-fields',
] as const;

export const partnerExportResourceSchema = z.enum(PARTNER_EXPORT_RESOURCES);
export type PartnerExportResource = z.infer<typeof partnerExportResourceSchema>;

const boundedIsoTimestampSchema = z.string().datetime({ offset: true });
const sha256RevisionSchema = z.string().regex(/^[a-f0-9]{64}$/u, 'revision must be a SHA-256 hex digest');

export const partnerExportRecordBaseSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  siteId: z.string().uuid().nullable(),
  sourceUpdatedAt: boundedIsoTimestampSchema,
  revision: sha256RevisionSchema,
}).strict();

export interface PartnerExportRecordBase {
  id: string;
  orgId: string;
  siteId: string | null;
  sourceUpdatedAt: string;
  revision: string;
}

/** Build an explicit, strict DTO allowlist for one public export resource. */
export function createPartnerExportRecordSchema<T extends z.ZodRawShape>(shape: T) {
  return partnerExportRecordBaseSchema.extend(shape).strict();
}

export const partnerExportBlockedRecordSchema = z.object({
  resource: partnerExportResourceSchema,
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  reason: z.literal('secret_detected'),
  fieldPaths: z.array(
    z.string().min(1).max(256).regex(/^[A-Za-z0-9_$.[\]-]+$/u, 'field path contains unsafe characters'),
  ).max(20),
}).strict();

export type PartnerExportBlockedRecord = z.infer<typeof partnerExportBlockedRecordSchema>;

export function createPartnerExportEnvelopeSchema<T extends z.ZodType>(recordSchema: T) {
  return z.object({
    schemaVersion: z.literal('1'),
    snapshotAt: boundedIsoTimestampSchema,
    data: z.array(recordSchema).max(500),
    nextCursor: z.string().min(1).max(4096).nullable(),
    hasMore: z.boolean(),
    blocked: z.array(partnerExportBlockedRecordSchema).max(500).optional(),
  }).strict().superRefine((value, ctx) => {
    if (value.hasMore !== (value.nextCursor !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nextCursor'],
        message: 'nextCursor must be present exactly when hasMore is true',
      });
    }
  });
}

export const partnerExportEnvelopeSchema = createPartnerExportEnvelopeSchema(
  partnerExportRecordBaseSchema,
);

export type PartnerExportEnvelope<T extends PartnerExportRecordBase> = {
  schemaVersion: '1';
  snapshotAt: string;
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
  blocked?: PartnerExportBlockedRecord[];
};
