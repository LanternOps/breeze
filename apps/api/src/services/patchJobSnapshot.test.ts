import { describe, it, expect } from 'vitest';
import { buildPatchesSnapshot, type PatchesSnapshotInput } from './patchJobSnapshot';

function makePolicyLocal(overrides: {
  settings?: Partial<PatchesSnapshotInput['settings']>;
  ring?: Partial<PatchesSnapshotInput['ring']>;
} = {}): PatchesSnapshotInput {
  return {
    settings: {
      sources: ['os'],
      autoApprove: false,
      autoApproveSeverities: [],
      autoApproveDeferralDays: 0,
      ...overrides.settings,
    },
    ring: {
      classification: 'valid_ring',
      valid: true,
      ringId: 'ring-1',
      ringName: 'Pilot Ring',
      categoryRules: [{ category: 'security', action: 'auto' }],
      categories: [],
      excludeCategories: [],
      autoApprove: { security: true },
      appRules: [],
      ...overrides.ring,
    },
  };
}

describe('buildPatchesSnapshot', () => {
  it('maps every snapshot field from ring and settings', () => {
    const snapshot = buildPatchesSnapshot(makePolicyLocal({
      settings: {
        sources: ['os', 'third_party'],
        autoApprove: true,
        autoApproveSeverities: ['critical', 'important'],
        autoApproveDeferralDays: 7,
      },
      ring: {
        appRules: [
          { source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' },
          { source: 'custom', packageId: 'corp-tool', action: 'pin', pinnedVersion: '1.2.3' },
        ],
      },
    }));

    expect(snapshot).toEqual({
      ringId: 'ring-1',
      ringName: 'Pilot Ring',
      categoryRules: [{ category: 'security', action: 'auto' }],
      categories: [],
      excludeCategories: [],
      autoApprove: { security: true },
      sources: ['os', 'third_party'],
      policyAutoApprove: {
        enabled: true,
        severities: ['critical', 'important'],
        deferralDays: 7,
      },
      apps: [
        { source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' },
        { source: 'custom', packageId: 'corp-tool', action: 'pin', pinnedVersion: '1.2.3' },
      ],
      ringAppRules: [
        { source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' },
        { source: 'custom', packageId: 'corp-tool', action: 'pin', pinnedVersion: '1.2.3' },
      ],
      ringValidation: {
        classification: 'valid_ring',
        valid: true,
      },
    });
  });

  // #8186 W02: the ring owns the rules. The legacy `apps` key mirrors them so
  // an executor that predates `ringAppRules` (rolling deploy) still enforces
  // them; the policy's own inline list is not snapshotted at all.
  it('legacy apps key mirrors ring rules', () => {
    const ringRules = [{ source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' }] as const;
    const policyLocal = {
      ...makePolicyLocal({ ring: { appRules: [...ringRules] } }),
    };
    // A loaded policy still carries its stale inline list until W04 strips it.
    (policyLocal.settings as Record<string, unknown>).apps = [{ source: 'custom', packageId: 'corp-tool', action: 'block' }];

    const snapshot = buildPatchesSnapshot(policyLocal);

    expect(snapshot.apps).toEqual(snapshot.ringAppRules);
    expect(snapshot.ringAppRules).toEqual(ringRules);
    expect(JSON.stringify(snapshot)).not.toContain('corp-tool');
  });

  it('maps policyAutoApprove from settings.autoApprove/autoApproveSeverities/autoApproveDeferralDays', () => {
    const snapshot = buildPatchesSnapshot(makePolicyLocal({
      settings: {
        autoApprove: true,
        autoApproveSeverities: ['moderate'],
        autoApproveDeferralDays: 14,
      },
    }));

    expect(snapshot.policyAutoApprove).toEqual({
      enabled: true,
      severities: ['moderate'],
      deferralDays: 14,
    });
  });

  it('falls back to schema defaults for legacy settings missing auto-approve fields', () => {
    // Legacy stored settings predate these fields — the fallbacks mirror the
    // patchInlineSettingsSchema defaults and are deliberate.
    const snapshot = buildPatchesSnapshot({
      settings: { sources: ['os'] },
      ring: makePolicyLocal().ring,
    });

    expect(snapshot.policyAutoApprove).toEqual({
      enabled: false,
      severities: [],
      deferralDays: 0,
    });
    expect(snapshot.apps).toEqual([]);
  });

  it('carries ring category include/exclude filters into the snapshot (#2117)', () => {
    const snapshot = buildPatchesSnapshot(makePolicyLocal({
      ring: {
        categories: ['security'],
        excludeCategories: ['driver', 'feature'],
      },
    }));

    expect(snapshot.categories).toEqual(['security']);
    expect(snapshot.excludeCategories).toEqual(['driver', 'feature']);
  });

  it('preserves null ring fields and invalid ring validation state', () => {
    const snapshot = buildPatchesSnapshot(makePolicyLocal({
      ring: {
        classification: 'missing_target',
        valid: false,
        ringId: null,
        ringName: null,
        categoryRules: [],
        categories: [],
        excludeCategories: [],
        autoApprove: false,
      },
    }));

    expect(snapshot.ringId).toBeNull();
    expect(snapshot.ringName).toBeNull();
    expect(snapshot.categoryRules).toEqual([]);
    expect(snapshot.autoApprove).toBe(false);
    expect(snapshot.ringValidation).toEqual({
      classification: 'missing_target',
      valid: false,
    });
  });
});
