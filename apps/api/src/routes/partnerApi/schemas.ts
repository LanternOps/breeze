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
  'custom-field-values',
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
  groupMembership: z.object({
    total: z.number().int().nonnegative(),
    included: z.number().int().min(0).max(500),
    complete: z.boolean(),
    reason: z.literal('membership_limit_exceeded').nullable(),
  }).strict().superRefine((value, ctx) => {
    if (value.included > value.total) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['included'], message: 'included cannot exceed total' });
    }
    if (value.complete !== (value.included === value.total)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['complete'], message: 'complete must reflect membership bounds' });
    }
    if ((value.reason === null) !== value.complete) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'overflow reason must reflect completeness' });
    }
  }),
  linkGroupId: z.string().uuid().nullable(),
  linkGroupRole: z.string().max(16).nullable(),
});
export const deviceExportEnvelopeSchema = createPartnerExportEnvelopeSchema(
  partnerDeviceExportRecordSchema,
);

export const partnerExportCollectionSchema = z.object({
  total: z.number().int().nonnegative(),
  included: z.number().int().nonnegative(),
  complete: z.boolean(),
  reason: z.literal('collection_limit_exceeded').nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.included > value.total) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['included'], message: 'included cannot exceed total' });
  }
  if (value.complete !== (value.included === value.total)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['complete'], message: 'complete must reflect collection bounds' });
  }
  if ((value.reason === null) !== value.complete) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'overflow reason must reflect completeness' });
  }
});

const nullableInventoryString = z.string().max(1000).nullable();
const inventoryCount = z.number().int().nonnegative().nullable();

export const partnerDeviceInventoryExportRecordSchema = strictPartnerExportRecordSchema({
  subjectType: z.literal('device'),
  deviceId: z.string().uuid(),
  hardware: z.object({
    processor: z.object({ model: nullableInventoryString, cores: inventoryCount, threads: inventoryCount }).strict(),
    memory: z.object({ totalMb: inventoryCount }).strict(),
    graphics: z.object({ model: nullableInventoryString }).strict(),
    motherboard: z.object({ manufacturer: nullableInventoryString, product: nullableInventoryString, version: nullableInventoryString }).strict(),
    firmware: z.object({ biosVersion: nullableInventoryString }).strict(),
  }).strict(),
  disks: z.array(z.object({
    id: z.string().uuid(), mountPoint: z.string().max(255), device: nullableInventoryString,
    fileSystem: nullableInventoryString, totalGb: z.number().nonnegative(),
  }).strict()).max(500),
  interfaces: z.array(z.object({
    id: z.string().uuid(), name: z.string().min(1).max(1000), macAddress: z.string().max(17).nullable(), primary: z.boolean(),
  }).strict()).max(500),
  addresses: z.array(z.object({
    id: z.string().uuid(), interfaceId: z.string().uuid(), interfaceName: z.string().min(1).max(1000),
    address: z.string().min(1).max(45), family: z.enum(['ipv4', 'ipv6']),
    assignment: z.enum(['dhcp', 'static', 'vpn', 'link-local', 'unknown']),
    reservationEligible: z.boolean(), subnetMask: z.string().max(45).nullable(), gateway: z.string().max(45).nullable(),
    dnsServers: z.array(z.string().min(1).max(45)).max(20), active: z.boolean(),
    firstSeenAt: partnerExportTimestampSchema, deactivatedAt: partnerExportTimestampSchema.nullable(),
  }).strict()).max(500),
  warranty: z.object({
    status: z.enum(['active', 'expiring', 'expired', 'unknown', 'subscription_active']),
    startsOn: z.string().date().nullable(), endsOn: z.string().date().nullable(), subscription: z.boolean(),
  }).strict().nullable(),
  virtualMachines: z.array(z.object({
    id: z.string().uuid(), externalId: z.string().min(1).max(64), name: z.string().min(1).max(256),
    generation: z.number().int().positive(), memoryMb: inventoryCount, processorCount: inventoryCount,
    rctEnabled: z.boolean(), passthroughDisks: z.boolean(),
  }).strict()).max(500),
  collections: z.object({
    disks: partnerExportCollectionSchema, interfaces: partnerExportCollectionSchema,
    addresses: partnerExportCollectionSchema, virtualMachines: partnerExportCollectionSchema,
  }).strict(),
});

const partnerNetworkEquipmentSchema = z.object({
  id: z.string().uuid(), type: z.enum(['printer', 'router', 'switch', 'firewall', 'access_point', 'nas']),
  name: z.string().max(255).nullable(), address: z.string().min(1).max(45), macAddress: z.string().max(17).nullable(),
  manufacturer: z.string().max(255).nullable(), model: z.string().max(255).nullable(),
}).strict();

export const partnerSiteInventoryExportRecordSchema = strictPartnerExportRecordSchema({
  subjectType: z.literal('site'),
  siteSubjectId: z.string().uuid(),
  networkEquipment: z.array(partnerNetworkEquipmentSchema).max(500),
  networkSegments: z.array(z.object({
    id: z.string().uuid(), cidr: z.string().min(1).max(50),
  }).strict()).max(500),
  collections: z.object({
    networkEquipment: partnerExportCollectionSchema,
    networkSegments: partnerExportCollectionSchema,
  }).strict(),
});
export const partnerInventoryExportRecordSchema = z.discriminatedUnion('subjectType', [
  partnerDeviceInventoryExportRecordSchema,
  partnerSiteInventoryExportRecordSchema,
]);
export const deviceInventoryExportEnvelopeSchema = createPartnerExportEnvelopeSchema(
  partnerInventoryExportRecordSchema,
);

export const partnerDeviceSoftwareExportRecordSchema = strictPartnerExportRecordSchema({
  subjectType: z.literal('device'),
  deviceId: z.string().uuid(),
  software: z.array(z.object({
    id: z.string().uuid(), name: z.string().min(1).max(500), version: z.string().max(100).nullable(),
    vendor: z.string().max(255).nullable(), installedOn: z.string().date().nullable(), managed: z.boolean(),
  }).strict()).max(1000),
  collection: partnerExportCollectionSchema,
});
export const deviceSoftwareExportEnvelopeSchema = createPartnerExportEnvelopeSchema(
  partnerDeviceSoftwareExportRecordSchema,
);

export const partnerRelationshipEndpointSchema = z.object({
  type: z.enum(['organization', 'site', 'device', 'interface', 'address', 'virtual_machine', 'discovered_asset']),
  id: z.string().uuid(),
}).strict();

export const partnerDeviceRelationshipExportRecordSchema = strictPartnerExportRecordSchema({
  subjectType: z.literal('device'),
  deviceId: z.string().uuid(),
  edges: z.array(z.object({
    key: z.string().min(1).max(128),
    type: z.enum(['organization_site', 'site_device', 'device_interface', 'interface_address', 'hyperv_host_vm', 'network_topology', 'device_link']),
    from: partnerRelationshipEndpointSchema,
    to: partnerRelationshipEndpointSchema,
    metadata: z.object({
      interfaceName: z.string().max(1000).nullable().optional(),
      assignment: z.enum(['dhcp', 'static', 'vpn', 'link-local', 'unknown']).optional(),
      reservationEligible: z.boolean().optional(),
      connectionType: z.string().max(50).nullable().optional(),
      vlan: z.number().int().min(0).max(4095).nullable().optional(),
      linkGroupRole: z.string().max(16).nullable().optional(),
    }).strict(),
  }).strict()).max(500),
  collection: partnerExportCollectionSchema,
});

export const partnerSiteRelationshipExportRecordSchema = strictPartnerExportRecordSchema({
  subjectType: z.literal('site'),
  siteSubjectId: z.string().uuid(),
  edges: partnerDeviceRelationshipExportRecordSchema.shape.edges,
  collection: partnerExportCollectionSchema,
});
export const partnerRelationshipExportRecordSchema = z.discriminatedUnion('subjectType', [
  partnerDeviceRelationshipExportRecordSchema,
  partnerSiteRelationshipExportRecordSchema,
]);
export const deviceRelationshipsExportEnvelopeSchema = createPartnerExportEnvelopeSchema(
  partnerRelationshipExportRecordSchema,
);

const partnerExportJsonSchema = z.json();
const partnerDefinitionScopeSchema = z.enum(['organization', 'partner']);
const nullableDefinitionString = z.string().max(12_288).nullable();

export const partnerConfigurationPolicyExportRecordSchema = strictPartnerExportRecordSchema({
  sourceScope: partnerDefinitionScopeSchema,
  name: z.string().min(1).max(255),
  description: nullableDefinitionString,
  status: z.enum(['active', 'inactive', 'archived']),
  features: z.array(z.object({
    id: z.string().uuid(),
    type: z.string().min(1).max(100),
    policyId: z.string().uuid().nullable(),
    settings: partnerExportJsonSchema.nullable(),
  }).strict()).max(500),
});
export const configurationPolicyExportEnvelopeSchema = createPartnerExportEnvelopeSchema(
  partnerConfigurationPolicyExportRecordSchema,
);

export const partnerConfigurationAssignmentExportRecordSchema = strictPartnerExportRecordSchema({
  policyId: z.string().uuid(),
  policyName: z.string().min(1).max(255),
  sourceScope: partnerDefinitionScopeSchema,
  level: z.enum(['partner', 'organization', 'site', 'device_group', 'device']),
  targetId: z.string().uuid(),
  priority: z.number().int(),
  roleFilter: z.array(z.string().min(1).max(30)).max(100).nullable(),
  osFilter: z.array(z.string().min(1).max(10)).max(100).nullable(),
});
export const configurationAssignmentExportEnvelopeSchema = createPartnerExportEnvelopeSchema(
  partnerConfigurationAssignmentExportRecordSchema,
);

export const partnerScriptExportRecordSchema = strictPartnerExportRecordSchema({
  sourceScope: partnerDefinitionScopeSchema,
  name: z.string().min(1).max(255),
  description: nullableDefinitionString,
  category: z.string().max(100).nullable(),
  osTypes: z.array(z.string().min(1).max(50)).max(20),
  language: z.enum(['powershell', 'bash', 'python', 'cmd']),
  content: z.string().max(12_288),
  parameters: partnerExportJsonSchema.nullable(),
  timeoutSeconds: z.number().int().positive(),
  runAs: z.enum(['system', 'user', 'elevated']),
  version: z.number().int().positive(),
  exitCodeSeverityMapping: partnerExportJsonSchema.nullable(),
});
export const scriptExportEnvelopeSchema = createPartnerExportEnvelopeSchema(
  partnerScriptExportRecordSchema,
);

export const partnerAutomationExportRecordSchema = strictPartnerExportRecordSchema({
  sourceScope: partnerDefinitionScopeSchema,
  name: z.string().min(1).max(255),
  description: nullableDefinitionString,
  enabled: z.boolean(),
  trigger: partnerExportJsonSchema,
  conditions: partnerExportJsonSchema.nullable(),
  actions: z.array(partnerExportJsonSchema).max(500),
  onFailure: z.enum(['stop', 'continue', 'notify']),
  notificationTargets: partnerExportJsonSchema.nullable(),
  dependencies: z.array(z.object({
    resource: z.literal('scripts'),
    id: z.string().uuid(),
  }).strict()).max(500),
});
export const automationExportEnvelopeSchema = createPartnerExportEnvelopeSchema(
  partnerAutomationExportRecordSchema,
);

const partnerBackupCommonShape = {
  sourceScope: partnerDefinitionScopeSchema,
  name: z.string().min(1).max(200),
  schedule: partnerExportJsonSchema.nullable(),
  retention: partnerExportJsonSchema.nullable(),
  exclusions: z.array(z.string().max(2000)).max(500),
  completenessGaps: z.array(z.object({
    code: z.literal('restore_procedure_unavailable'),
  }).strict()).max(1),
};
export const partnerBackupDestinationExportRecordSchema = strictPartnerExportRecordSchema({
  kind: z.literal('destination'),
  ...partnerBackupCommonShape,
  sourceScope: z.literal('organization'),
  type: z.enum(['file', 'system_image', 'database', 'application']),
  provider: z.enum(['local', 's3', 'azure_blob', 'google_cloud', 'backblaze']),
  compression: z.boolean(),
  encryption: z.boolean(),
  active: z.boolean(),
  default: z.boolean(),
});
export const partnerBackupProfileExportRecordSchema = strictPartnerExportRecordSchema({
  kind: z.literal('profile'),
  ...partnerBackupCommonShape,
  description: nullableDefinitionString,
  active: z.boolean(),
  selections: partnerExportJsonSchema,
  destinationId: z.string().uuid().nullable(),
});
export const partnerBackupPolicyExportRecordSchema = strictPartnerExportRecordSchema({
  kind: z.literal('policy'),
  ...partnerBackupCommonShape,
  sourceScope: z.literal('organization'),
  enabled: z.boolean(),
  destinationId: z.string().uuid(),
  targets: partnerExportJsonSchema,
  gfs: partnerExportJsonSchema.nullable(),
  legalHold: z.boolean(),
  legalHoldReason: nullableDefinitionString,
  bandwidthLimitMbps: z.number().int().positive().nullable(),
  backupWindowStart: z.string().max(5).nullable(),
  backupWindowEnd: z.string().max(5).nullable(),
  priority: z.number().int().nullable(),
});
export const partnerBackupConfigurationExportRecordSchema = z.discriminatedUnion('kind', [
  partnerBackupDestinationExportRecordSchema,
  partnerBackupProfileExportRecordSchema,
  partnerBackupPolicyExportRecordSchema,
]);
export const backupConfigurationExportEnvelopeSchema = createPartnerExportEnvelopeSchema(
  partnerBackupConfigurationExportRecordSchema,
);

export const partnerCustomFieldExportRecordSchema = strictPartnerExportRecordSchema({
  sourceScope: partnerDefinitionScopeSchema,
  name: z.string().min(1).max(100),
  fieldKey: z.string().min(1).max(100),
  type: z.enum(['text', 'number', 'boolean', 'dropdown', 'date']),
  options: partnerExportJsonSchema.nullable(),
  required: z.boolean(),
  defaultValue: partnerExportJsonSchema.nullable(),
  deviceTypes: z.array(z.string().min(1).max(50)).max(100).nullable(),
});
export const customFieldExportEnvelopeSchema = createPartnerExportEnvelopeSchema(
  partnerCustomFieldExportRecordSchema,
);

export const partnerCustomFieldValueExportRecordSchema = strictPartnerExportRecordSchema({
  deviceId: z.string().uuid(),
  definitionId: z.string().uuid(),
  target: z.object({
    type: z.literal('device'),
    id: z.string().uuid(),
  }).strict(),
  name: z.string().min(1).max(100),
  fieldKey: z.string().min(1).max(100),
  type: z.enum(['text', 'number', 'boolean', 'dropdown', 'date']),
  value: partnerExportJsonSchema,
});
export const customFieldValueExportEnvelopeSchema = createPartnerExportEnvelopeSchema(
  partnerCustomFieldValueExportRecordSchema,
);

export type PartnerExportEnvelope<T extends PartnerExportRecordBase> = {
  schemaVersion: '1';
  snapshotAt: string;
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
  blocked?: PartnerExportBlockedRecord[];
};
