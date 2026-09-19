// apps/api/src/services/aiOperator/recipes/serviceRecovery.test.ts
import { describe, expect, it } from 'vitest';
import {
  SERVICE_RECOVERY_BOUNDS,
  buildServiceRecoveryCriterion,
  parseServiceRecoveryInput,
  taskRunDedupeKey,
  validateNextStep,
  type ServiceRecoveryStepKey,
} from './serviceRecovery';
import type { ServiceRecoveryInput } from '@breeze/shared';

const DEVICE_ID = '00000000-0000-4000-8000-000000000011';
const ALERT_ID = '00000000-0000-4000-8000-000000000012';

const validRawInput = {
  deviceId: DEVICE_ID,
  serviceName: 'spooler',
  triggeringAlertId: ALERT_ID,
  maxRestartAttempts: 2,
};

describe('parseServiceRecoveryInput', () => {
  it('accepts a valid input', () => {
    const parsed = parseServiceRecoveryInput(validRawInput);
    expect(parsed).toEqual(validRawInput);
  });

  it('rejects a non-uuid deviceId', () => {
    expect(() => parseServiceRecoveryInput({ ...validRawInput, deviceId: 'not-a-uuid' })).toThrow();
  });

  it('rejects an empty serviceName', () => {
    expect(() => parseServiceRecoveryInput({ ...validRawInput, serviceName: '' })).toThrow();
  });

  it('rejects maxRestartAttempts of 3 (max is 2)', () => {
    expect(() => parseServiceRecoveryInput({ ...validRawInput, maxRestartAttempts: 3 })).toThrow();
  });

  it('defaults maxRestartAttempts to 1 when omitted', () => {
    const { maxRestartAttempts, ...withoutBound } = validRawInput;
    const parsed = parseServiceRecoveryInput(withoutBound);
    expect(parsed.maxRestartAttempts).toBe(1);
  });
});

describe('buildServiceRecoveryCriterion', () => {
  const input: ServiceRecoveryInput = parseServiceRecoveryInput(validRawInput);
  const criterion = buildServiceRecoveryCriterion(input);

  it('carries deviceId, serviceName, and alertId through', () => {
    expect(criterion.deviceId).toBe(DEVICE_ID);
    expect(criterion.serviceName).toBe('spooler');
    expect(criterion.alertId).toBe(ALERT_ID);
  });

  it('sets freshnessSeconds to the recipe bound (120)', () => {
    expect(criterion.freshnessSeconds).toBe(120);
    expect(criterion.freshnessSeconds).toBe(SERVICE_RECOVERY_BOUNDS.freshnessSeconds);
  });

  it('sets resolvableWithoutAlert to FALSE — the C11 decision: without a triggering ' +
    'alert there is no recurrence signal, so this recipe never credits verified_resolved ' +
    'on service-state alone', () => {
    expect(criterion.resolvableWithoutAlert).toBe(false);
  });
});

const FROZEN: ServiceRecoveryInput = parseServiceRecoveryInput(validRawInput);

describe('validateNextStep', () => {
  type Case = {
    name: string;
    from: string;
    proposed: { key: string; inputs: Record<string, unknown> };
    expect: 'ok' | 'unsupported_step' | 'step_not_permitted' | 'invalid_inputs';
  };

  const cases: Case[] = [
    {
      name: 'investigate -> execute is permitted with matching serviceName',
      from: 'investigate',
      proposed: { key: 'execute', inputs: { serviceName: FROZEN.serviceName } },
      expect: 'ok',
    },
    {
      name: 'investigate -> verify is not permitted',
      from: 'investigate',
      proposed: { key: 'verify', inputs: {} },
      expect: 'step_not_permitted',
    },
    {
      name: 'investigate -> observe is not permitted',
      from: 'investigate',
      proposed: { key: 'observe', inputs: {} },
      expect: 'step_not_permitted',
    },
    {
      name: 'investigate -> document is not permitted',
      from: 'investigate',
      proposed: { key: 'document', inputs: {} },
      expect: 'step_not_permitted',
    },
    {
      name: 'a bogus key is unsupported_step',
      from: 'investigate',
      proposed: { key: 'not_a_real_step', inputs: {} },
      expect: 'unsupported_step',
    },
    {
      name: 'execute permits nothing',
      from: 'execute',
      proposed: { key: 'execute', inputs: { serviceName: FROZEN.serviceName } },
      expect: 'step_not_permitted',
    },
    {
      name: 'observe permits nothing',
      from: 'observe',
      proposed: { key: 'verify', inputs: {} },
      expect: 'step_not_permitted',
    },
    {
      name: 'verify permits nothing',
      from: 'verify',
      proposed: { key: 'document', inputs: {} },
      expect: 'step_not_permitted',
    },
    {
      name: 'document permits nothing',
      from: 'document',
      proposed: { key: 'execute', inputs: { serviceName: FROZEN.serviceName } },
      expect: 'step_not_permitted',
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const result = validateNextStep(c.from, c.proposed, FROZEN);
      expect(result.ok).toBe(c.expect === 'ok');
      if (c.expect !== 'ok') {
        expect((result as { reason: string }).reason).toBe(c.expect);
      }
    });
  }

  it('missing inputs for execute is invalid_inputs', () => {
    const result = validateNextStep('investigate', { key: 'execute', inputs: {} }, FROZEN);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe('invalid_inputs');
  });

  it('invalid (wrong-typed) inputs for execute is invalid_inputs', () => {
    const result = validateNextStep(
      'investigate',
      { key: 'execute', inputs: { serviceName: 12345 } },
      FROZEN,
    );
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe('invalid_inputs');
  });

  it('a serviceName differing from the frozen admission input is invalid_inputs, ' +
    'and the detail names the frozen-admission rule (spec §7.1: pinned arguments)', () => {
    const result = validateNextStep(
      'investigate',
      { key: 'execute', inputs: { serviceName: 'some-other-service' } },
      FROZEN,
    );
    expect(result.ok).toBe(false);
    const failure = result as { reason: string; detail: string };
    expect(failure.reason).toBe('invalid_inputs');
    expect(failure.detail).toContain('frozen');
  });

  it('an unsupported current step key is also unsupported_step', () => {
    const result = validateNextStep('not_a_step', { key: 'execute', inputs: {} }, FROZEN);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe('unsupported_step');
  });
});

describe('taskRunDedupeKey', () => {
  const TASK_ID = '00000000-0000-4000-8000-000000000013';

  it('is stable for identical inputs', () => {
    const a = taskRunDedupeKey(TASK_ID, 'investigate', 0);
    const b = taskRunDedupeKey(TASK_ID, 'investigate', 0);
    expect(a).toBe(b);
  });

  it('is distinct per task', () => {
    const a = taskRunDedupeKey(TASK_ID, 'investigate', 0);
    const b = taskRunDedupeKey('00000000-0000-4000-8000-000000000099', 'investigate', 0);
    expect(a).not.toBe(b);
  });

  it('is distinct per step', () => {
    const a = taskRunDedupeKey(TASK_ID, 'investigate' satisfies ServiceRecoveryStepKey, 0);
    const b = taskRunDedupeKey(TASK_ID, 'execute' satisfies ServiceRecoveryStepKey, 0);
    expect(a).not.toBe(b);
  });

  it('is distinct per attempt', () => {
    const a = taskRunDedupeKey(TASK_ID, 'investigate', 0);
    const b = taskRunDedupeKey(TASK_ID, 'investigate', 1);
    expect(a).not.toBe(b);
  });
});
