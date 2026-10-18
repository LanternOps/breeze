import { describe, expect, it } from 'vitest';
import { admissionFailoverOf, admissionServedColumns } from './admissionFailover';

const NONE = {
  servedOfferingId: null, servedFundingSource: null, servedFailoverHop: null,
  servedFailoverCause: null, servedFailoverFromOfferingId: null,
};
const served = (failover: { fromOfferingId: string | null; hop: number; cause: 'cooldown' } | null, id: string | null = 'h') =>
  admissionServedColumns({ offering: { id, displayName: 'H' }, funding: 'platform', failover });

describe('admissionServedColumns (#7787)', () => {
  it('stamps the resolver\'s failover on the admitted offering', () => {
    expect(served({ fromOfferingId: 'p', hop: 2, cause: 'cooldown' })).toEqual({
      servedOfferingId: 'h', servedFundingSource: 'platform', servedFailoverHop: 2,
      servedFailoverCause: 'cooldown', servedFailoverFromOfferingId: 'p',
    });
  });
  it.each([
    ['no failover', null, 'h'],
    ['hop 0', { fromOfferingId: 'p', hop: 0, cause: 'cooldown' as const }, 'h'],
    ['hop above MAX_FAILOVER_HOP', { fromOfferingId: 'p', hop: 7, cause: 'cooldown' as const }, 'h'],
    ['non-integer hop', { fromOfferingId: 'p', hop: 1.5, cause: 'cooldown' as const }, 'h'],
    ['no offering id', { fromOfferingId: 'p', hop: 1, cause: 'cooldown' as const }, null],
  ])('writes all five as null (ai_agent_runs_served_chk): %s', (_label, failover, id) => {
    expect(served(failover, id)).toEqual(NONE);
  });
});

describe('admissionFailoverOf (#7787)', () => {
  const run = {
    admittedOfferingId: 'h', servedOfferingId: 'h', servedFailoverHop: 2,
    servedFailoverCause: 'cooldown', servedFailoverFromOfferingId: 'p',
  };
  it('reads admission\'s provenance when served = admitted', () => {
    expect(admissionFailoverOf(run)).toEqual({ fromOfferingId: 'p', hop: 2, cause: 'cooldown' });
  });
  it('keeps the provenance with an unknown source', () => {
    expect(admissionFailoverOf({ ...run, servedFailoverFromOfferingId: null })).toEqual({ fromOfferingId: null, hop: 2, cause: 'cooldown' });
  });
  it.each([
    ['a run-loop hop (served != admitted)', { servedOfferingId: 'k' }],
    ['nothing served', { servedOfferingId: null }],
    ['hop out of range', { servedFailoverHop: 7 }],
    ['hop 0', { servedFailoverHop: 0 }],
    ['unknown cause', { servedFailoverCause: 'bogus' }],
  ])('is null for %s', (_label, over) => {
    expect(admissionFailoverOf({ ...run, ...over })).toBeNull();
  });
});
