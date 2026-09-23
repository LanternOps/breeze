import { describe, expect, it } from 'vitest';
import {
  createReportSchema,
  endpointManagementConfigFields,
  endpointManagementConfigSchema,
  hardwareLifecycleConfigFields,
  hardwareLifecycleConfigSchema,
  securityCompliancePostureConfigFields,
  securityCompliancePostureConfigSchema,
  identityAccessConfigFields,
  identityAccessConfigSchema,
  threatDetectionConfigFields,
  threatDetectionConfigSchema,
  updateReportSchema,
  vulnerabilityManagementConfigFields,
  vulnerabilityManagementConfigSchema,
} from './schemas';
import { legacyReportConfigSchema } from '../../services/reportConfigSchemas';

/** #3198 W02 (ruling P1): the per-type schemas now `.extend()` the legacy
 *  builder keys, so `.shape` carries those too. The persistence field maps pin
 *  only a type's OWN keys. (Task 4 deletes the field maps and these pins.) */
function ownKeys(schema: { shape: Record<string, unknown> }): string[] {
  return Object.keys(schema.shape).filter((k) => !(k in legacyReportConfigSchema.shape));
}

const builderConfig = {
  builderType: 'device_inventory',
  dataSource: 'devices',
  columns: ['hostname'],
  filterConditions: [{ field: 'status', operator: 'eq', value: 'online' }],
  schedule: { time: '09:00', day: 'monday', date: '1' },
  exportFormats: ['pdf'],
  emailRecipients: ['client@example.com', 'msp@example.com'],
};

describe('report config schema', () => {
  it('preserves schedule detail and emailRecipients on create', () => {
    const parsed = createReportSchema.parse({
      name: 'Monthly posture',
      type: 'security_compliance_posture',
      schedule: 'monthly',
      format: 'pdf',
      config: builderConfig,
    });
    expect(parsed.config.schedule).toEqual({ time: '09:00', day: 'monday', date: '1' });
    expect(parsed.config.emailRecipients).toEqual(['client@example.com', 'msp@example.com']);
    // Builder metadata must round-trip for the edit page.
    expect((parsed.config as Record<string, unknown>).builderType).toBe('device_inventory');
    expect((parsed.config as Record<string, unknown>).exportFormats).toEqual(['pdf']);
  });

  it('rejects malformed recipients and times', () => {
    expect(() =>
      createReportSchema.parse({
        name: 'x', type: 'compliance',
        config: { emailRecipients: ['not-an-email'] },
      })
    ).toThrow();
    expect(() =>
      createReportSchema.parse({
        name: 'x', type: 'compliance',
        config: { emailRecipients: ['a@b'] },
      })
    ).toThrow();
    expect(() =>
      createReportSchema.parse({
        name: 'x', type: 'compliance',
        config: { schedule: { time: '25:99' } },
      })
    ).toThrow();
  });

  // Same loose chip regex as ReportBuilder/recipientsOf — persistence must
  // never reject what the builder already accepted as a chip.
  it('accepts a unicode-local-part address, matching the builder chip validator', () => {
    const parsed = createReportSchema.parse({
      name: 'x', type: 'compliance',
      config: { emailRecipients: ['jörg@example.com'] },
    });
    expect(parsed.config.emailRecipients).toEqual(['jörg@example.com']);
  });

  it('validates config on update too (was z.any())', () => {
    expect(() =>
      updateReportSchema.parse({ config: { emailRecipients: ['nope'] } })
    ).toThrow();
    const ok = updateReportSchema.parse({ config: builderConfig });
    expect(ok.config?.emailRecipients).toHaveLength(2);
  });

  it('coerces a legacy numeric schedule.date to string on both create and update', () => {
    const created = createReportSchema.parse({
      name: 'x', type: 'compliance',
      config: { schedule: { date: 1 } },
    });
    expect(created.config.schedule).toEqual({ date: '1' });

    const updated = updateReportSchema.parse({ config: { schedule: { date: 1 } } });
    expect(updated.config?.schedule).toEqual({ date: '1' });
  });

  // The generation schema (with defaults) and the persistence field map are
  // maintained by hand. Drift is silent and one-directional: a key added to the
  // former but not the latter is stripped on save, then silently reappears at
  // generation as its default — the user's setting quietly ignored.
  it('keeps the posture persistence fields in sync with the generation schema', () => {
    expect(Object.keys(securityCompliancePostureConfigFields).sort()).toEqual(
      ownKeys(securityCompliancePostureConfigSchema).sort(),
    );
  });

  it('keeps the hardware lifecycle persistence fields in sync with the generation schema', () => {
    expect(Object.keys(hardwareLifecycleConfigFields).sort()).toEqual(
      ownKeys(hardwareLifecycleConfigSchema).sort(),
    );
  });

  it('keeps the endpoint management persistence fields in sync with the generation schema', () => {
    expect(Object.keys(endpointManagementConfigFields).sort()).toEqual(
      ownKeys(endpointManagementConfigSchema).sort(),
    );
  });

  it('defaults an endpoint management config', () => {
    expect(endpointManagementConfigSchema.parse({})).toEqual({
      sites: [], staleEnrolmentDays: 14, trendDays: 30, includeLicences: true,
    });
  });

  it('rejects an out-of-range trendDays', () => {
    expect(() => endpointManagementConfigSchema.parse({ trendDays: 0 })).toThrow();
    expect(() => endpointManagementConfigSchema.parse({ trendDays: 400 })).toThrow();
  });

  it('preserves endpoint management staleEnrolmentDays on create', () => {
    const parsed = createReportSchema.parse({
      name: 'Endpoints', type: 'endpoint_management_review',
      config: { staleEnrolmentDays: 30, includeLicences: false },
    });
    expect(parsed.config.staleEnrolmentDays).toBe(30);
    expect(parsed.config.includeLicences).toBe(false);
  });

  it('keeps the vulnerability management persistence fields in sync with the generation schema', () => {
    expect(Object.keys(vulnerabilityManagementConfigFields).sort()).toEqual(
      ownKeys(vulnerabilityManagementConfigSchema).sort(),
    );
  });

  it('defaults a vulnerability management config to the spec values', () => {
    expect(vulnerabilityManagementConfigSchema.parse({})).toEqual({
      sites: [], severityFloor: 'high', topN: 25, includeAccepted: true,
    });
  });

  it('rejects an unknown severity floor', () => {
    expect(() => vulnerabilityManagementConfigSchema.parse({ severityFloor: 'catastrophic' })).toThrow();
  });

  it('rejects a topN outside the schema range, for the API caller that bypasses the form', () => {
    expect(() => vulnerabilityManagementConfigSchema.parse({ topN: 0 })).toThrow();
    expect(() => vulnerabilityManagementConfigSchema.parse({ topN: 501 })).toThrow();
    expect(() => vulnerabilityManagementConfigSchema.parse({ topN: 25.5 })).toThrow();
    expect(vulnerabilityManagementConfigSchema.parse({ topN: 500 }).topN).toBe(500);
  });

  it('preserves vulnerability management options on create', () => {
    const parsed = createReportSchema.parse({
      name: 'Vulns', type: 'vulnerability_management',
      config: { severityFloor: 'medium', topN: 50, includeAccepted: false },
    });
    expect(parsed.config.severityFloor).toBe('medium');
    expect(parsed.config.topN).toBe(50);
    expect(parsed.config.includeAccepted).toBe(false);
  });

  it('preserves hardware lifecycle replaceAgeYears on create', () => {
    const parsed = createReportSchema.parse({
      name: 'Lifecycle', type: 'hardware_lifecycle',
      config: { replaceAgeYears: 5, includeOtherEquipment: false },
    });
    expect(parsed.config.replaceAgeYears).toBe(5);
    expect(parsed.config.includeOtherEquipment).toBe(false);
  });

  it('round-trips serverReplaceAgeYears independently of replaceAgeYears on create', () => {
    const parsed = createReportSchema.parse({
      name: 'Lifecycle', type: 'hardware_lifecycle',
      config: { replaceAgeYears: 4, serverReplaceAgeYears: 6 },
    });
    expect(parsed.config.replaceAgeYears).toBe(4);
    expect(parsed.config.serverReplaceAgeYears).toBe(6);
  });

  it('rejects replaceAgeYears/serverReplaceAgeYears outside [1, 15] and non-integers', () => {
    for (const field of ['replaceAgeYears', 'serverReplaceAgeYears'] as const) {
      expect(() =>
        createReportSchema.parse({ name: 'x', type: 'hardware_lifecycle', config: { [field]: 0 } })
      ).toThrow();
      expect(() =>
        createReportSchema.parse({ name: 'x', type: 'hardware_lifecycle', config: { [field]: 16 } })
      ).toThrow();
      expect(() =>
        createReportSchema.parse({ name: 'x', type: 'hardware_lifecycle', config: { [field]: 4.5 } })
      ).toThrow();
    }
  });

  it('preserves posture backupRequired on create and update', () => {
    const created = createReportSchema.parse({
      name: 'Workstation posture',
      type: 'security_compliance_posture',
      schedule: 'one_time',
      format: 'pdf',
      config: { backupRequired: false },
    });
    expect(created.config.backupRequired).toBe(false);

    const updated = updateReportSchema.parse({
      config: { backupRequired: true },
    });
    expect(updated.config?.backupRequired).toBe(true);
  });

  it('keeps the threat detection persistence fields in sync with the generation schema', () => {
    expect(Object.keys(threatDetectionConfigFields).sort()).toEqual(
      ownKeys(threatDetectionConfigSchema).sort(),
    );
  });

  it('defaults a threat detection config', () => {
    expect(threatDetectionConfigSchema.parse({})).toEqual({
      sites: [], includeCarriedIn: true, topIncidents: 100,
    });
  });

  it('rejects an out-of-range topIncidents', () => {
    expect(() => threatDetectionConfigSchema.parse({ topIncidents: 0 })).toThrow();
    expect(() => threatDetectionConfigSchema.parse({ topIncidents: 1001 })).toThrow();
  });

  it('preserves threat detection topIncidents on create', () => {
    const parsed = createReportSchema.parse({
      name: 'Threat detection', type: 'threat_detection_review',
      config: { topIncidents: 25, includeCarriedIn: false },
    });
    expect(parsed.config?.topIncidents).toBe(25);
    expect(parsed.config?.includeCarriedIn).toBe(false);
  });

  // #5784 W06 — the identity and access review.
  it('keeps the identity access persistence fields in sync with the generation schema', () => {
    expect(Object.keys(identityAccessConfigFields).sort()).toEqual(
      ownKeys(identityAccessConfigSchema).sort(),
    );
  });

  it('defaults an identity access config to the spec values', () => {
    expect(identityAccessConfigSchema.parse({})).toEqual({
      dormantDays: 45, homeCountries: [], adminDetail: true,
    });
  });

  it('has no sites key — the report is org-wide by construction', () => {
    // A site selector would promise a filter M365 identity data cannot deliver.
    expect(Object.keys(identityAccessConfigSchema.shape)).not.toContain('sites');
  });

  it('rejects a malformed home country code', () => {
    expect(() => identityAccessConfigSchema.parse({ homeCountries: ['United States'] })).toThrow();
  });

  it('preserves identity access dormantDays and homeCountries on create', () => {
    const parsed = createReportSchema.parse({
      name: 'Identity', type: 'identity_access_review',
      config: { dormantDays: 60, homeCountries: ['US', 'CA'], adminDetail: false },
    });
    expect(parsed.config.dormantDays).toBe(60);
    expect(parsed.config.homeCountries).toEqual(['US', 'CA']);
    expect(parsed.config.adminDetail).toBe(false);
  });
});
