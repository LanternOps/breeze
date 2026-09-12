// apps/api/src/jobs/queueSchemas.scriptReview.test.ts
import { describe, expect, it } from 'vitest';
import { scriptReviewQueueJobDataSchema } from './queueSchemas';

const PROPOSAL_ID = '00000000-0000-4000-8000-000000000f01';
const ORG_ID = '00000000-0000-4000-8000-000000000f02';

describe('scriptReviewQueueJobDataSchema', () => {
  it('accepts a well-formed job', () => {
    const parsed = scriptReviewQueueJobDataSchema.parse({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 0 });
    expect(parsed).toEqual({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 0 });
  });

  it('rejects a non-UUID proposalId', () => {
    expect(() =>
      scriptReviewQueueJobDataSchema.parse({ proposalId: 'not-a-uuid', orgId: ORG_ID, attempt: 0 })
    ).toThrow();
  });

  it('rejects a negative attempt', () => {
    expect(() =>
      scriptReviewQueueJobDataSchema.parse({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: -1 })
    ).toThrow();
  });

  it('rejects a fractional attempt', () => {
    expect(() =>
      scriptReviewQueueJobDataSchema.parse({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1.5 })
    ).toThrow();
  });
});
