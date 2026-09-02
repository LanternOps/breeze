import { describe, expect, it, vi } from 'vitest';
import { removePamEntitlement } from './pamEntitlementCleanup';

describe('removePamEntitlement', () => {
  it('requests cleanup for every matching active subject actuation', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [
        { elevation_request_id: '10000000-0000-4000-8000-000000000001' },
        { elevation_request_id: '10000000-0000-4000-8000-000000000002' },
      ] })
      .mockResolvedValueOnce({ rows: [{
        id: '20000000-0000-4000-8000-000000000001',
        elevation_request_id: '10000000-0000-4000-8000-000000000001',
        request_revision: 1,
        generation: 1,
        desired_state: 'active',
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: '20000000-0000-4000-8000-000000000001',
        elevation_request_id: '10000000-0000-4000-8000-000000000001',
        request_revision: 1,
        generation: 2,
        desired_state: 'cleanup',
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        id: '20000000-0000-4000-8000-000000000002',
        elevation_request_id: '10000000-0000-4000-8000-000000000002',
        request_revision: 1,
        generation: 3,
        desired_state: 'cleanup',
      }] });

    const result = await removePamEntitlement({ execute } as never, {
      orgId: '30000000-0000-4000-8000-000000000001',
      deviceId: '30000000-0000-4000-8000-000000000002',
      subjectId: '30000000-0000-4000-8000-000000000003',
      source: { kind: 'subscription', id: 'sub-1' },
    });

    expect(result).toHaveLength(2);
    expect(result.map((ref) => ref.desiredState)).toEqual(['cleanup', 'cleanup']);
    expect(execute).toHaveBeenCalledTimes(5);
  });

  it('returns an empty immutable list when the entitlement owns no active actuation', async () => {
    const execute = vi.fn().mockResolvedValueOnce({ rows: [] });
    const result = await removePamEntitlement({ execute } as never, {
      orgId: '30000000-0000-4000-8000-000000000001',
      deviceId: '30000000-0000-4000-8000-000000000002',
      subjectId: '30000000-0000-4000-8000-000000000003',
      source: { kind: 'license', id: 'license-1' },
    });
    expect(result).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
  });
});
