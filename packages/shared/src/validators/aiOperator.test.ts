import { describe, expect, it } from 'vitest';
import { taskCheckpointSchema, TASK_CHECKPOINT_VERSION } from './aiOperator';

const DEVICE = '00000000-0000-4000-8000-000000000001';

const baseInput = {
  version: TASK_CHECKPOINT_VERSION,
  recipeInput: { deviceId: DEVICE, serviceName: 'spooler', triggeringAlertId: null },
  criterion: {
    adapter: 'service_running',
    adapterVersion: 1,
    deviceId: DEVICE,
    serviceName: 'spooler',
    alertId: null,
  },
};

describe('taskCheckpointSchema (Recipe Library wave E3)', () => {
  it('carries the wait fields E3 added, and rejects a non-ISO waitUntil', () => {
    const base = taskCheckpointSchema.parse(baseInput);
    expect(base.waitUntil).toBeUndefined();
    expect(base.resumeStepKey).toBeUndefined();

    const withWait = taskCheckpointSchema.parse({
      ...base,
      waitUntil: '2026-10-19T17:00:00.000Z',
      resumeStepKey: 'discover',
    });
    expect(withWait.waitUntil).toBe('2026-10-19T17:00:00.000Z');
    expect(withWait.resumeStepKey).toBe('discover');

    expect(() => taskCheckpointSchema.parse({ ...base, waitUntil: 'friday' })).toThrow();
    expect(() => taskCheckpointSchema.parse({ ...base, resumeStepKey: '' })).toThrow();
  });
});
