import { describe, it, expect } from 'vitest';
import { buildPatchesSnapshot, type PatchesSnapshotInput } from './patchJobSnapshot';

function makePolicyLocal(overrides: {
  settings?: Partial<PatchesSnapshotInput['settings']>;
  ring?: Partial<PatchesSnapshotInput['ring']>;
} = {}): PatchesSnapshotInput {
  return {
    settings: {
      sources: ['os'],
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

  // #8188 W04: every supported executor reads `ringAppRules`, so the legacy
  // `apps` mirror and the inert `policyAutoApprove` block are no longer
  // written. A stale policy-level value on the loaded settings never reaches
  // the snapshot.
  it('writes neither the legacy apps key nor policyAutoApprove', () => {
    const ringRules = [{ source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' }] as const;
    const policyLocal = makePolicyLocal({ ring: { appRules: [...ringRules] } });
    Object.assign(policyLocal.settings as Record<string, unknown>, {
      apps: [{ source: 'custom', packageId: 'corp-tool', action: 'block' }],
      autoApprove: true,
      autoApproveSeverities: ['critical'],
      autoApproveDeferralDays: 7,
    });

    const snapshot = buildPatchesSnapshot(policyLocal);

    expect(snapshot).not.toHaveProperty('apps');
    expect(snapshot).not.toHaveProperty('policyAutoApprove');
    expect(snapshot.ringAppRules).toEqual(ringRules);
    expect(JSON.stringify(snapshot)).not.toContain('corp-tool');
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
