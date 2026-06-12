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
      apps: [],
      ...overrides.settings,
    },
    ring: {
      classification: 'valid_ring',
      valid: true,
      ringId: 'ring-1',
      ringName: 'Pilot Ring',
      categoryRules: [{ category: 'security', action: 'auto' }],
      autoApprove: { security: true },
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
        apps: [
          { source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' },
          { source: 'custom', packageId: 'corp-tool', action: 'pin', pinnedVersion: '1.2.3' },
        ],
      },
    }));

    expect(snapshot).toEqual({
      ringId: 'ring-1',
      ringName: 'Pilot Ring',
      categoryRules: [{ category: 'security', action: 'auto' }],
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
      ringValidation: {
        classification: 'valid_ring',
        valid: true,
      },
    });
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

  it('falls back to schema defaults for legacy settings missing auto-approve fields and apps', () => {
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

  it('preserves null ring fields and invalid ring validation state', () => {
    const snapshot = buildPatchesSnapshot(makePolicyLocal({
      ring: {
        classification: 'missing_target',
        valid: false,
        ringId: null,
        ringName: null,
        categoryRules: [],
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
