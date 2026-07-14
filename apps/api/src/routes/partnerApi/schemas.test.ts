import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  PARTNER_EXPORT_RESOURCES,
  createPartnerExportEnvelopeSchema,
  createPartnerExportRecordSchema,
  partnerExportBlockedRecordSchema,
  partnerExportRecordBaseSchema,
  partnerExportResourceSchema,
} from './schemas';

const ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const SITE_ID = '33333333-3333-4333-8333-333333333333';
const REVISION = 'a'.repeat(64);

const baseRecord = {
  id: ID,
  orgId: ORG_ID,
  siteId: SITE_ID,
  sourceUpdatedAt: '2026-07-13T18:00:00.000Z',
  revision: REVISION,
};

describe('partner export schemas', () => {
  it('defines the exact resource names for all twelve public routes', () => {
    expect(PARTNER_EXPORT_RESOURCES).toEqual([
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
    ]);
    for (const resource of PARTNER_EXPORT_RESOURCES) {
      expect(partnerExportResourceSchema.parse(resource)).toBe(resource);
    }
    expect(partnerExportResourceSchema.safeParse('alerts').success).toBe(false);
  });

  it('accepts only bounded version-one record base fields', () => {
    expect(partnerExportRecordBaseSchema.parse(baseRecord)).toEqual(baseRecord);
    expect(partnerExportRecordBaseSchema.safeParse({ ...baseRecord, siteId: null }).success).toBe(true);

    for (const invalid of [
      { ...baseRecord, id: 'not-a-uuid' },
      { ...baseRecord, sourceUpdatedAt: 'yesterday' },
      { ...baseRecord, revision: 'short' },
      { ...baseRecord, revision: 'g'.repeat(64) },
      { ...baseRecord, providerConfig: { token: 'must-not-pass' } },
    ]) {
      expect(partnerExportRecordBaseSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('builds strict resource DTO allowlists instead of accepting ORM row fields', () => {
    const schema = createPartnerExportRecordSchema({
      name: z.string().min(1).max(200),
      enabled: z.boolean(),
    });

    expect(schema.parse({ ...baseRecord, name: 'Workstation baseline', enabled: true })).toEqual({
      ...baseRecord,
      name: 'Workstation baseline',
      enabled: true,
    });
    expect(schema.safeParse({
      ...baseRecord,
      name: 'Workstation baseline',
      enabled: true,
      password: 'unreviewed-column',
    }).success).toBe(false);
    expect(schema.safeParse({ ...baseRecord, name: 'x'.repeat(201), enabled: true }).success).toBe(false);
  });

  it('validates the exact version-one envelope and page bounds', () => {
    const envelopeSchema = createPartnerExportEnvelopeSchema(partnerExportRecordBaseSchema);
    const envelope = {
      schemaVersion: '1' as const,
      snapshotAt: '2026-07-13T18:00:00.000Z',
      data: [baseRecord],
      nextCursor: null,
      hasMore: false,
    };

    expect(envelopeSchema.parse(envelope)).toEqual(envelope);
    expect(envelopeSchema.safeParse({ ...envelope, schemaVersion: '2' }).success).toBe(false);
    expect(envelopeSchema.safeParse({ ...envelope, unreviewed: true }).success).toBe(false);
    expect(envelopeSchema.safeParse({
      ...envelope,
      data: Array.from({ length: 501 }, () => baseRecord),
    }).success).toBe(false);
    expect(envelopeSchema.safeParse({ ...envelope, hasMore: true, nextCursor: null }).success).toBe(false);
    expect(envelopeSchema.safeParse({ ...envelope, hasMore: false, nextCursor: 'cursor' }).success).toBe(false);
  });

  it('limits blocked records to safe bounded metadata', () => {
    const blocked = {
      resource: 'scripts' as const,
      id: ID,
      orgId: ORG_ID,
      reason: 'secret_detected' as const,
      fieldPaths: ['definition.steps[0].password'],
    };

    expect(partnerExportBlockedRecordSchema.parse(blocked)).toEqual(blocked);
    expect(partnerExportBlockedRecordSchema.safeParse({
      ...blocked,
      definition: { password: 'not-safe' },
    }).success).toBe(false);
    expect(partnerExportBlockedRecordSchema.safeParse({
      ...blocked,
      fieldPaths: Array.from({ length: 21 }, (_, index) => `definition.secret${index}`),
    }).success).toBe(false);
    expect(partnerExportBlockedRecordSchema.safeParse({
      ...blocked,
      fieldPaths: ['x'.repeat(257)],
    }).success).toBe(false);
  });
});
