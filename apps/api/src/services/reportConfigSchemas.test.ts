import { describe, expect, it } from 'vitest';
import {
  endpointManagementConfigSchema,
  hardwareLifecycleConfigSchema,
  identityAccessConfigSchema,
  legacyReportConfigSchema,
  securityCompliancePostureConfigSchema,
  storedArtifactConfigSchema,
  threatDetectionConfigSchema,
  vulnerabilityManagementConfigSchema,
} from './reportConfigSchemas';
import * as routeSchemas from '../routes/reports/schemas';

const PER_TYPE = {
  securityCompliancePostureConfigSchema,
  hardwareLifecycleConfigSchema,
  threatDetectionConfigSchema,
  endpointManagementConfigSchema,
  vulnerabilityManagementConfigSchema,
  identityAccessConfigSchema,
} as const;

describe('reportConfigSchemas (#3198 W02, spec §6)', () => {
  it('every per-type schema extends the legacy builder keys, so schedule/recipients keep validating', () => {
    for (const [name, schema] of Object.entries(PER_TYPE)) {
      for (const key of Object.keys(legacyReportConfigSchema.shape)) {
        expect(Object.keys(schema.shape), `${name} is missing legacy key ${key}`).toContain(key);
      }
      expect(() => schema.parse({ emailRecipients: ['not-an-email'] }), name).toThrow();
      expect(() => schema.parse({ schedule: { time: '25:00' } }), name).toThrow();
    }
  });

  it('every per-type schema is loose: builder metadata passes through, defaults still apply', () => {
    const parsed = threatDetectionConfigSchema.parse({ builderType: 'x', topIncidents: 5 });
    expect(parsed).toEqual({ builderType: 'x', topIncidents: 5, sites: [], includeCarriedIn: true });
    for (const [name, schema] of Object.entries(PER_TYPE)) {
      expect((schema.parse({ exportFormats: ['pdf'] }) as Record<string, unknown>).exportFormats, name)
        .toEqual(['pdf']);
    }
  });

  it('stored-artifact schema is loose and empty', () => {
    expect(Object.keys(storedArtifactConfigSchema.shape)).toEqual([]);
    expect(storedArtifactConfigSchema.parse({ anything: 1 })).toEqual({ anything: 1 });
  });

  it('the route schema module re-exports the SAME six schema objects (one definition)', () => {
    for (const [name, schema] of Object.entries(PER_TYPE)) {
      expect((routeSchemas as Record<string, unknown>)[name], name).toBe(schema);
    }
  });
});
