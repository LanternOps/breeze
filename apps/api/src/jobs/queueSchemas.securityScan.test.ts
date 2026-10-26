import { describe, expect, it } from 'vitest';
import { securityScanQueueJobDataSchema } from './queueSchemas';

const SCAN = '11111111-1111-4111-8111-111111111111';
const SWEEP = '22222222-2222-4222-8222-222222222222';

describe('securityScanQueueJobDataSchema (#6263 W05)', () => {
  it('origin sweep requires sweepId', () => {
    expect(securityScanQueueJobDataSchema.safeParse({ type: 'dispatch-scan', scanId: SCAN, origin: 'sweep', sweepId: SWEEP }).success).toBe(true);
    expect(securityScanQueueJobDataSchema.safeParse({ type: 'dispatch-scan', scanId: SCAN, origin: 'sweep' }).success).toBe(false);
    expect(securityScanQueueJobDataSchema.safeParse({ type: 'dispatch-scan', scanId: SCAN, origin: 'sweep', sweepId: 'nope' }).success).toBe(false);
    // A manual dispatch cannot smuggle a sweep id.
    expect(securityScanQueueJobDataSchema.safeParse({ type: 'dispatch-scan', scanId: SCAN, origin: 'manual', sweepId: SWEEP }).success).toBe(false);
  });

  it('pump-sweeps strict', () => {
    expect(securityScanQueueJobDataSchema.safeParse({ type: 'pump-sweeps', tickAt: '2026-10-25T10:00:00.000Z' }).success).toBe(true);
    expect(securityScanQueueJobDataSchema.safeParse({ type: 'pump-sweeps' }).success).toBe(false);
    expect(securityScanQueueJobDataSchema.safeParse({ type: 'pump-sweeps', tickAt: 'x', orgId: SCAN }).success).toBe(false);
  });

  it('existing members still parse', () => {
    expect(securityScanQueueJobDataSchema.safeParse({ type: 'dispatch-scan', scanId: SCAN, origin: 'manual' }).success).toBe(true);
    expect(securityScanQueueJobDataSchema.safeParse({ type: 'schedule-policies', scanAt: 'now' }).success).toBe(true);
  });
});
