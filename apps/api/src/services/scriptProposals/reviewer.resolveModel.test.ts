// apps/api/src/services/scriptProposals/reviewer.resolveModel.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env', () => ({ AI_SCRIPT_REVIEWER_MODEL: 'claude-sonnet-4-6' }));
vi.mock('../../db', () => ({
  db: {},
  withSystemDbAccessContext: async (fn: () => unknown) => fn(),
}));
const mockEffectivePolicy = vi.fn();
vi.mock('./policy', () => ({
  resolveEffectiveScriptPolicy: (...args: unknown[]) => mockEffectivePolicy(...args),
}));

import { resolveReviewerModel } from './reviewer';

const baseEffectivePolicy = {
  proposingEnabled: true,
  unattendedEnabled: false,
  maxUnattendedRiskTier: 'low',
  unattendedAllowedClasses: [],
  maxUnattendedPerHour: 10,
  protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
  reviewerModel: null,
  source: { partnerRowId: null, orgRowId: null },
};

beforeEach(() => mockEffectivePolicy.mockReset());

describe('resolveReviewerModel', () => {
  it('prefers the effective policy reviewer_model over the platform default', async () => {
    mockEffectivePolicy.mockResolvedValue({ ...baseEffectivePolicy, reviewerModel: 'org-chosen-model' });
    await expect(resolveReviewerModel('00000000-0000-4000-8000-0000000000b1')).resolves.toBe(
      'org-chosen-model',
    );
    expect(mockEffectivePolicy).toHaveBeenCalledWith('00000000-0000-4000-8000-0000000000b1');
  });

  it('falls back to the platform default when no policy row names a model', async () => {
    mockEffectivePolicy.mockResolvedValue({ ...baseEffectivePolicy, reviewerModel: null });
    await expect(resolveReviewerModel('00000000-0000-4000-8000-0000000000b2')).resolves.toBe(
      'claude-sonnet-4-6',
    );
  });
});
