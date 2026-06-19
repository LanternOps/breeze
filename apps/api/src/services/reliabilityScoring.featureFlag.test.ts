import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));

  return {
    dbSelect: vi.fn(() => ({ from })),
    dbInsert: vi.fn(),
    from,
    limit,
    shouldProduceMlOutput: vi.fn(),
    where,
  };
});

vi.mock('../db', () => ({
  db: {
    select: mocks.dbSelect,
    insert: mocks.dbInsert,
  },
}));

vi.mock('./mlFeatureFlags', () => ({
  shouldProduceMlOutput: mocks.shouldProduceMlOutput,
}));

import {
  computeAndPersistDeviceReliability,
  computeAndPersistOrgReliability,
} from './reliabilityScoring';

describe('reliability scoring feature flag gates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips device reliability writes when the org flag is disabled', async () => {
    mocks.limit.mockResolvedValueOnce([{ id: 'device-1', orgId: 'org-1' }]);
    mocks.shouldProduceMlOutput.mockResolvedValueOnce(false);

    await expect(computeAndPersistDeviceReliability('device-1')).resolves.toBe(false);

    expect(mocks.shouldProduceMlOutput).toHaveBeenCalledWith('org-1', 'ml.device_reliability.enabled');
    expect(mocks.dbSelect).toHaveBeenCalledTimes(1);
    expect(mocks.dbInsert).not.toHaveBeenCalled();
  });

  it('skips org reliability scans before selecting devices when the org flag is disabled', async () => {
    mocks.shouldProduceMlOutput.mockResolvedValueOnce(false);

    await expect(computeAndPersistOrgReliability('org-1')).resolves.toEqual({
      orgId: 'org-1',
      devicesComputed: 0,
      devicesFailed: 0,
    });

    expect(mocks.shouldProduceMlOutput).toHaveBeenCalledWith('org-1', 'ml.device_reliability.enabled');
    expect(mocks.dbSelect).not.toHaveBeenCalled();
    expect(mocks.dbInsert).not.toHaveBeenCalled();
  });
});
