import { describe, expect, it } from 'vitest';
import {
  createReportSchema,
  endpointManagementConfigSchema,
  generateReportSchema,
  identityAccessConfigSchema,
  threatDetectionConfigSchema,
  updateReportSchema,
  vulnerabilityManagementConfigSchema,
} from './schemas';

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

/**
 * #3198 W02 Task 4. The hand-parallel `*ConfigFields` maps are gone; each type's
 * OWN schema now validates on create. The hazard those pins guarded — a key the
 * generator reads being stripped on save — is pinned here directly: every
 * option a user sets survives create, and a default the user never set is NOT
 * frozen into the stored row (generation applies defaults at read time).
 */
describe('create validates config with the TYPE\'s own schema (#3198 W02)', () => {
  const OWN_OPTIONS: Record<string, Record<string, unknown>> = {
    security_compliance_posture: {
      sites: [], windowDays: 60, minPasswordLength: 12, maxLocalAdmins: 1,
      maxAvDefinitionsAgeDays: 3, maxSecurityStatusAgeDays: 10, includeCis: false, backupRequired: false,
    },
    hardware_lifecycle: {
      sites: [], replaceAgeYears: 6, serverReplaceAgeYears: 7, includeManualAssets: false, includeOtherEquipment: false,
    },
    threat_detection_review: { sites: [], includeCarriedIn: false, topIncidents: 10 },
    endpoint_management_review: { sites: [], staleEnrolmentDays: 30, trendDays: 60, includeLicences: false },
    vulnerability_management: { sites: [], severityFloor: 'low', topN: 10, includeAccepted: false },
    identity_access_review: { dormantDays: 90, homeCountries: ['GB'], adminDetail: false },
  };

  for (const [type, options] of Object.entries(OWN_OPTIONS)) {
    it(`${type}: every own option survives create`, () => {
      const parsed = createReportSchema.parse({ name: 'x', type, config: options });
      expect(parsed.config).toEqual(options);
    });
  }

  it('does not persist defaults the user never set', () => {
    const parsed = createReportSchema.parse({
      name: 'x', type: 'vulnerability_management', config: { topN: 10 },
    });
    expect(parsed.config).toEqual({ topN: 10 });
  });

  it('rejects an out-of-range value for the OWNING type, with the error under config.*', () => {
    const result = createReportSchema.safeParse({
      name: 'x', type: 'vulnerability_management', config: { topN: 9999 },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['config', 'topN']);
  });

  it('passes a foreign type\'s key through unvalidated (strip-nothing, see configParity)', () => {
    const parsed = createReportSchema.parse({
      name: 'x', type: 'device_inventory', config: { topN: 9999 },
    });
    expect(parsed.config).toMatchObject({ topN: 9999 });
  });

  it('does not write a `type` key into the stored config', () => {
    const parsed = createReportSchema.parse({ name: 'x', type: 'compliance', config: { columns: ['a'] } });
    expect(parsed.config).not.toHaveProperty('type');
  });
});

describe('createReportSchema / generateReportSchema: ownerScope discriminated union (#3198 W02, B6)', () => {
  const PARTNER_ORG = '22222222-2222-4222-8222-222222222222';

  it('a missing ownerScope still selects the organization arm', () => {
    const created = createReportSchema.parse({ name: 'x', type: 'compliance', orgId: PARTNER_ORG });
    expect(created.ownerScope).toBe('organization');
    expect(created.orgId).toBe(PARTNER_ORG);
    const generated = generateReportSchema.parse({ type: 'compliance', orgId: PARTNER_ORG });
    expect(generated.ownerScope).toBe('organization');
    expect(generated.orgId).toBe(PARTNER_ORG);
  });

  it('the partner arm refuses an orgId', () => {
    expect(createReportSchema.safeParse({
      ownerScope: 'partner', name: 'x', type: 'ar_aging', orgId: PARTNER_ORG,
    }).success).toBe(false);
    expect(generateReportSchema.safeParse({
      ownerScope: 'partner', type: 'ar_aging', orgId: PARTNER_ORG,
    }).success).toBe(false);
  });

  it('the partner arm parses without an orgId', () => {
    expect(createReportSchema.parse({ ownerScope: 'partner', name: 'x', type: 'ar_aging' }).ownerScope)
      .toBe('partner');
    expect(generateReportSchema.parse({ ownerScope: 'partner', type: 'ar_aging' }).ownerScope)
      .toBe('partner');
  });

  it('an unknown ownerScope is refused', () => {
    expect(createReportSchema.safeParse({ ownerScope: 'site', name: 'x', type: 'compliance' }).success)
      .toBe(false);
    expect(generateReportSchema.safeParse({ ownerScope: 'site', type: 'compliance' }).success).toBe(false);
  });

  it('update keeps ownerScope forbidden', () => {
    expect(updateReportSchema.safeParse({ ownerScope: 'organization', name: 'x' }).success).toBe(false);
    expect(updateReportSchema.safeParse({ ownerScope: 'partner', name: 'x' }).success).toBe(false);
  });
});

describe('generateReportSchema config (#3198 W02)', () => {
  it('keeps keys the old strict generate schema stripped (business options, builder metadata)', () => {
    const parsed = generateReportSchema.parse({
      type: 'ar_aging', ownerScope: 'partner',
      config: { groupBy: 'organization', includePaidInPeriod: false, period: { kind: 'last_30_days' } },
    });
    expect(parsed.config).toMatchObject({
      groupBy: 'organization', includePaidInPeriod: false, period: { kind: 'last_30_days' },
    });
  });

  it('validates the config with the type\'s own schema', () => {
    const result = generateReportSchema.safeParse({ type: 'vulnerability_management', config: { topN: 9999 } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['config', 'topN']);
  });

  it('validates the shared builder keys on every type (schedule, emailRecipients)', () => {
    expect(generateReportSchema.safeParse({
      type: 'hardware_lifecycle', config: { emailRecipients: ['nope'] },
    }).success).toBe(false);
  });
});
