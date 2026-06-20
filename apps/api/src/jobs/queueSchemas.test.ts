import { describe, expect, it } from 'vitest';
import {
  automationQueueJobDataSchema,
  sensitiveDataQueueJobDataSchema,
} from './queueSchemas';

describe('queue job schemas', () => {
  it('accepts valid automation execution jobs', () => {
    expect(automationQueueJobDataSchema.parse({
      type: 'execute-run',
      runId: 'run-1',
      targetDeviceIds: ['device-1'],
    })).toEqual({
      type: 'execute-run',
      runId: 'run-1',
      targetDeviceIds: ['device-1'],
    });
  });

  it('rejects malformed automation jobs before system-context processing', () => {
    expect(() => automationQueueJobDataSchema.parse({
      type: 'execute-run',
      runId: '',
      unexpected: true,
    })).toThrow();
  });

  it('accepts valid sensitive-data dispatch jobs', () => {
    expect(sensitiveDataQueueJobDataSchema.parse({
      type: 'dispatch-scan',
      scanId: 'scan-1',
    })).toEqual({
      type: 'dispatch-scan',
      scanId: 'scan-1',
    });
  });

  it('rejects malformed sensitive-data jobs before command dispatch', () => {
    expect(() => sensitiveDataQueueJobDataSchema.parse({
      type: 'dispatch-scan',
      scanId: '',
    })).toThrow();
  });
});
