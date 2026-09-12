// apps/api/src/services/scriptProposals/reviewer.resolveModel.test.ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env', () => ({ AI_SCRIPT_REVIEWER_MODEL: 'claude-sonnet-4-6' }));

import { resolveReviewerModel } from './reviewer';

describe('resolveReviewerModel', () => {
  it('returns the configured platform default regardless of orgId (W04 will add an org/partner override here)', () => {
    expect(resolveReviewerModel('00000000-0000-4000-8000-0000000000b1')).toBe('claude-sonnet-4-6');
    expect(resolveReviewerModel('00000000-0000-4000-8000-0000000000b2')).toBe('claude-sonnet-4-6');
  });
});
