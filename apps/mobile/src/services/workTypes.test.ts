import { describe, expect, it, vi, beforeEach } from 'vitest';

const coreRequest = vi.fn();
vi.mock('./api', () => ({ coreRequest: (...a: unknown[]) => coreRequest(...a) }));

import {
  fetchWorkTypes,
  clearWorkTypeCache,
  shouldReportWorkTypeLoadFailure,
  WorkTypeListMalformedError,
} from './workTypes';

beforeEach(() => {
  coreRequest.mockReset();
  clearWorkTypeCache();
});

describe('fetchWorkTypes (#4628 W04)', () => {
  it('calls the core billing-profiles work-types endpoint and returns only ACTIVE types', async () => {
    coreRequest.mockResolvedValue({
      workTypes: [
        { id: 'wt-2', name: 'On-site', isActive: true, sortOrder: 2 },
        { id: 'wt-x', name: 'Retired', isActive: false, sortOrder: 0 },
        { id: 'wt-1', name: 'Remote', isActive: true, sortOrder: 1 },
      ],
    });
    const types = await fetchWorkTypes();
    expect(coreRequest).toHaveBeenCalledWith('/billing-profiles/work-types');
    expect(types.map((w) => w.id)).toEqual(['wt-1', 'wt-2']);
  });

  it('sorts by sortOrder then name', async () => {
    coreRequest.mockResolvedValue({
      workTypes: [
        { id: 'b', name: 'Beta', isActive: true, sortOrder: 0 },
        { id: 'a', name: 'Alpha', isActive: true, sortOrder: 0 },
      ],
    });
    expect((await fetchWorkTypes()).map((w) => w.name)).toEqual(['Alpha', 'Beta']);
  });

  it('caches within the TTL so a screen re-mounting does not re-hit the network', async () => {
    coreRequest.mockResolvedValue({ workTypes: [] });
    await fetchWorkTypes();
    await fetchWorkTypes();
    expect(coreRequest).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache a failure — a later mount retries', async () => {
    coreRequest.mockRejectedValueOnce(new Error('offline'));
    await expect(fetchWorkTypes()).rejects.toThrow('offline');
    coreRequest.mockResolvedValueOnce({
      workTypes: [{ id: 'wt-1', name: 'Remote', isActive: true, sortOrder: 0 }],
    });
    await expect(fetchWorkTypes()).resolves.toHaveLength(1);
    expect(coreRequest).toHaveBeenCalledTimes(2);
  });

  it('rejects a malformed payload instead of rendering garbage chips', async () => {
    coreRequest.mockResolvedValue({ workTypes: [{ id: 7, name: null }] });
    await expect(fetchWorkTypes()).rejects.toThrow(/malformed/i);
  });

  it('classifies which load failures are worth reporting', () => {
    // A role without billing_profiles:read, or a session ending, is an
    // expected state: the picker just stays hidden.
    expect(shouldReportWorkTypeLoadFailure({ statusCode: 403 })).toBe(false);
    expect(shouldReportWorkTypeLoadFailure({ statusCode: 401 })).toBe(false);
    // Offline is the normal case for a field technician.
    expect(shouldReportWorkTypeLoadFailure(new TypeError('Network request failed'))).toBe(false);
    // A server error or a contract drift is a bug somebody should see.
    expect(shouldReportWorkTypeLoadFailure({ statusCode: 500 })).toBe(true);
    expect(shouldReportWorkTypeLoadFailure(new WorkTypeListMalformedError())).toBe(true);
  });

  it('returns an empty list when the partner has no work types', async () => {
    coreRequest.mockResolvedValue({ workTypes: [] });
    await expect(fetchWorkTypes()).resolves.toEqual([]);
  });
});
