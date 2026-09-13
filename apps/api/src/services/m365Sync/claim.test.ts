import { describe, expect, it } from 'vitest';
import { syncJobId } from './claim';

describe('syncJobId', () => {
  const D = { orgId: '11111111-1111-4111-8111-111111111111', domain: 'users' as const, generation: 7 };

  it('contains NO colon — BullMQ rejects custom job ids that do', () => {
    expect(syncJobId(D)).not.toContain(':');
  });

  it('is `m365-sync-<org>-<domain>-<generation>`', () => {
    expect(syncJobId(D)).toBe('m365-sync-11111111-1111-4111-8111-111111111111-users-7');
  });

  it('changes with the generation, so a new claim is never blocked by a retained old job', () => {
    expect(syncJobId({ ...D, generation: 8 })).not.toBe(syncJobId(D));
  });

  it('is stable for the same (org, domain, generation), so a duplicate enqueue collapses', () => {
    expect(syncJobId(D)).toBe(syncJobId({ ...D }));
  });

  it('separates domains within one org', () => {
    expect(syncJobId({ ...D, domain: 'skus' })).not.toBe(syncJobId(D));
  });
});
