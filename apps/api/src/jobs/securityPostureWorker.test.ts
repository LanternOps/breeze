import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {},
  Job: class {}
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn()
  },
  withSystemDbAccessContext: undefined
}));

vi.mock('../db/schema', () => ({
  devices: {
    orgId: 'org_id',
    status: 'status'
  }
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({}))
}));

vi.mock('../services/securityPosture', () => ({
  computeAndPersistOrgSecurityPosture: vi.fn()
}));

vi.mock('../services/eventBus', () => ({
  publishEvent: vi.fn()
}));

import { publishEvent } from '../services/eventBus';
import { publishSecurityScoreChangedEvents } from './securityPostureWorker';

function buildChanges(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    orgId: '11111111-1111-1111-1111-111111111111',
    deviceId: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
    previousScore: 70,
    currentScore: 75,
    delta: 5,
    previousRiskLevel: 'medium' as const,
    currentRiskLevel: 'low' as const,
    changedFactors: ['patch_compliance']
  }));
}

describe('publishSecurityScoreChangedEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(publishEvent).mockResolvedValue('event-id');
  });

  it('caps published events at the configured limit', async () => {
    const changes = buildChanges(250);
    const result = await publishSecurityScoreChangedEvents(changes, '2026-02-22T00:00:00.000Z', {
      limit: 200,
      concurrency: 8
    });

    expect(vi.mocked(publishEvent)).toHaveBeenCalledTimes(200);
    expect(result).toEqual({
      attempted: 200,
      published: 200,
      failed: 0
    });
  });

  it('continues publishing when some events fail', async () => {
    let callCount = 0;
    vi.mocked(publishEvent).mockImplementation(async () => {
      callCount++;
      if (callCount === 4) {
        throw new Error('publish failed');
      }
      return 'event-id';
    });

    const changes = buildChanges(10);
    const result = await publishSecurityScoreChangedEvents(changes, '2026-02-22T00:00:00.000Z', {
      limit: 10,
      concurrency: 4
    });

    expect(vi.mocked(publishEvent)).toHaveBeenCalledTimes(10);
    expect(result).toEqual({
      attempted: 10,
      published: 9,
      failed: 1
    });
  });

  it('respects bounded concurrency', async () => {
    let active = 0;
    let maxActive = 0;
    vi.mocked(publishEvent).mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return 'event-id';
    });

    const changes = buildChanges(12);
    const result = await publishSecurityScoreChangedEvents(changes, '2026-02-22T00:00:00.000Z', {
      limit: 12,
      concurrency: 3
    });

    expect(result.failed).toBe(0);
    expect(result.published).toBe(12);
    expect(maxActive).toBeLessThanOrEqual(3);
  });
});
