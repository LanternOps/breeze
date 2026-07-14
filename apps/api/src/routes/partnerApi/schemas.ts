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

export const PARTNER_EXPORT_CURSOR_MAX_LENGTH = 4096;
export const partnerExportTimestampSchema = z.string().datetime({ offset: true });
export const partnerExportCursorTokenSchema = z.string().min(1).max(PARTNER_EXPORT_CURSOR_MAX_LENGTH);
const sha256RevisionSchema = z.string().regex(/^[a-f0-9]{64}$/u, 'revision must be a SHA-256 hex digest');

export const partnerExportRecordBaseSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  siteId: z.string().uuid().nullable(),
  sourceUpdatedAt: partnerExportTimestampSchema,
  revision: sha256RevisionSchema,
}).strict();

export interface PartnerExportRecordBase {
  id: string;
  orgId: string;
  siteId: string | null;
  sourceUpdatedAt: string;
  revision: string;
}

type PartnerExportReservedKey = keyof PartnerExportRecordBase;
type WithoutPartnerExportReservedKeys<T extends z.ZodRawShape> =
  Extract<keyof T, PartnerExportReservedKey> extends never ? T : never;

const PARTNER_EXPORT_RESERVED_KEYS = new Set<PartnerExportReservedKey>(
  Object.keys(partnerExportRecordBaseSchema.shape) as PartnerExportReservedKey[],
);

/** Build an explicit, strict DTO allowlist without permitting base-contract replacement. */
export function strictPartnerExportRecordSchema<const T extends z.ZodRawShape>(
  shape: WithoutPartnerExportReservedKeys<T>,
) {
  for (const key of Object.keys(shape)) {
    if (PARTNER_EXPORT_RESERVED_KEYS.has(key as PartnerExportReservedKey)) {
      throw new TypeError(`Partner export resource schema cannot override reserved base field: ${key}`);
    }
  }
  return partnerExportRecordBaseSchema.extend(shape).strict();
}

export const createPartnerExportRecordSchema = strictPartnerExportRecordSchema;

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
    snapshotAt: partnerExportTimestampSchema,
    data: z.array(recordSchema).max(500),
    nextCursor: partnerExportCursorTokenSchema.nullable(),
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

const nullableBoundedString = z.string().max(1000).nullable();

export const partnerOrganizationExportRecordSchema = strictPartnerExportRecordSchema({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(100),
  type: z.enum(['customer', 'internal']),
});
export const organizationExportEnvelopeSchema = createPartnerExportEnvelopeSchema(
  partnerOrganizationExportRecordSchema,
);

export const partnerSiteAddressSchema = z.object({
  line1: nullableBoundedString,
  line2: nullableBoundedString,
  city: nullableBoundedString,
  region: nullableBoundedString,
  postalCode: nullableBoundedString,
  country: nullableBoundedString,
}).strict();

export const partnerSiteContactSchema = z.object({
  name: nullableBoundedString,
  email: nullableBoundedString,
  phone: nullableBoundedString,
}).strict();

export const partnerSiteExportRecordSchema = strictPartnerExportRecordSchema({
  name: z.string().min(1).max(255),
  timezone: z.string().min(1).max(64),
  address: partnerSiteAddressSchema.nullable(),
  contact: partnerSiteContactSchema.nullable(),
});
export const siteExportEnvelopeSchema = createPartnerExportEnvelopeSchema(
  partnerSiteExportRecordSchema,
);

export const partnerDeviceExportRecordSchema = strictPartnerExportRecordSchema({
  hostname: z.string().min(1).max(255),
  displayName: z.string().max(255).nullable(),
  type: z.object({
    os: z.enum(['windows', 'macos', 'linux']),
    role: z.string().min(1).max(30),
    virtual: z.boolean(),
    virtualizationPlatform: z.string().max(30).nullable(),
  }).strict(),
  operatingSystem: z.object({
    edition: z.string().min(1).max(100),
    build: z.string().max(100).nullable(),
    architecture: z.string().min(1).max(20),
  }).strict(),
  installation: z.object({
    enrolledAt: partnerExportTimestampSchema,
  }).strict(),
  hardwareIdentity: z.object({
    serialNumber: z.string().max(100).nullable(),
    manufacturer: z.string().max(255).nullable(),
    model: z.string().max(255).nullable(),
  }).strict(),
  stableIdentifiers: z.object({
    assetTag: z.string().max(255).nullable(),
    inventoryId: z.string().max(255).nullable(),
    externalId: z.string().max(255).nullable(),
  }).strict(),
  tags: z.array(z.string().min(1).max(255)).max(200),
  groupIds: z.array(z.string().uuid()).max(500),
  linkGroupId: z.string().uuid().nullable(),
  linkGroupRole: z.string().max(16).nullable(),
});
export const deviceExportEnvelopeSchema = createPartnerExportEnvelopeSchema(
  partnerDeviceExportRecordSchema,
);

export type PartnerExportEnvelope<T extends PartnerExportRecordBase> = {
  schemaVersion: '1';
  snapshotAt: string;
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
  blocked?: PartnerExportBlockedRecord[];
};
