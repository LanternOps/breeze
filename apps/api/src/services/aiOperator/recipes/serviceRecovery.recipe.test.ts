/**
 * The ported recipe object (spec §6.1, wave E1). `serviceRecovery.test.ts`
 * proves the BEHAVIOUR is unchanged; this file proves the recipe object
 * actually carries what the coordinator, the admission path and the route
 * will now read from it instead of from module constants.
 */
import { describe, expect, it } from 'vitest';
import {
  SERVICE_RECOVERY_BOUNDS,
  SERVICE_RECOVERY_PERMITTED_NEXT_STEPS,
  SERVICE_RECOVERY_PROMPT_VERSION,
  SERVICE_RECOVERY_STEP_KEYS,
  SERVICE_RECOVERY_WORKFLOW_KEY,
  SERVICE_RECOVERY_WORKFLOW_VERSION,
  parseServiceRecoveryInput,
  serviceRecoveryOperationKey,
  serviceRecoveryRecipe,
} from './serviceRecovery';

const DEVICE_ID = '00000000-0000-4000-8000-000000000011';
const input = parseServiceRecoveryInput({
  deviceId: DEVICE_ID, serviceName: 'spooler',
  triggeringAlertId: '00000000-0000-4000-8000-000000000012',
});

describe('serviceRecoveryRecipe', () => {
  it('carries the shipped key, version and prompt version — the values already on live task rows', () => {
    expect(serviceRecoveryRecipe.key).toBe(SERVICE_RECOVERY_WORKFLOW_KEY);
    expect(serviceRecoveryRecipe.key).toBe('service_recovery');
    expect(serviceRecoveryRecipe.version).toBe(SERVICE_RECOVERY_WORKFLOW_VERSION);
    expect(serviceRecoveryRecipe.version).toBe(1);
    expect(serviceRecoveryRecipe.promptVersion).toBe(SERVICE_RECOVERY_PROMPT_VERSION);
  });

  it('is gateClass model_chooses_effect: the model proposes the execute step (spec §9)', () => {
    expect(serviceRecoveryRecipe.gateClass).toBe('model_chooses_effect');
  });

  it('targets a device and requires no provider capability', () => {
    expect(serviceRecoveryRecipe.targetKinds).toEqual(['device']);
    expect(serviceRecoveryRecipe.requires).toEqual([]);
  });

  it('declares exactly the shipped step keys, in order', () => {
    expect(Object.keys(serviceRecoveryRecipe.steps)).toEqual([...SERVICE_RECOVERY_STEP_KEYS]);
  });

  it('maps each step to the phase the coordinator writes for it today', () => {
    expect(serviceRecoveryRecipe.steps.investigate).toMatchObject({ kind: 'reason', phase: 'investigate' });
    expect(serviceRecoveryRecipe.steps.execute).toMatchObject({ kind: 'effect', phase: 'execute' });
    expect(serviceRecoveryRecipe.steps.observe).toMatchObject({ kind: 'probe', phase: 'execute' });
    expect(serviceRecoveryRecipe.steps.verify).toMatchObject({ kind: 'probe', phase: 'verify' });
    expect(serviceRecoveryRecipe.steps.document).toMatchObject({ kind: 'document', phase: 'document', terminal: true });
  });

  it('reuses the shipped permitted-next-step table by identity, not a copy', () => {
    expect(serviceRecoveryRecipe.permittedNextSteps).toBe(SERVICE_RECOVERY_PERMITTED_NEXT_STEPS);
  });

  it('reuses the shipped bounds by identity, so the coordinator reads the same numbers', () => {
    expect(serviceRecoveryRecipe.bounds).toBe(SERVICE_RECOVERY_BOUNDS);
  });

  it('buildPlan returns the one manage_services restart effect, addressed at the frozen device', () => {
    expect(serviceRecoveryRecipe.buildPlan(input, {})).toEqual([
      {
        ordinal: 0,
        toolName: 'manage_services',
        provider: 'breeze',
        targetId: DEVICE_ID,
        accountExternalId: null,
        canonicalArguments: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'spooler' },
      },
    ]);
  });

  it('buildPlan is pure: same input, same list, and the result is not shared between calls', () => {
    const a = serviceRecoveryRecipe.buildPlan(input, {});
    const b = serviceRecoveryRecipe.buildPlan(input, {});
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it('operationKey produces exactly what serviceRecoveryOperationKey produces', () => {
    expect(
      serviceRecoveryRecipe.operationKey({ stepKey: 'execute', targetId: DEVICE_ID, planRevision: 3, ordinal: 0 }),
    ).toBe(
      serviceRecoveryOperationKey({ stepKey: 'execute', deviceId: DEVICE_ID, planRevision: 3, ordinal: 0 }),
    );
  });

  it('crossCheckStepInputs refuses an execute whose serviceName is not the frozen one', () => {
    expect(serviceRecoveryRecipe.crossCheckStepInputs?.('execute', { serviceName: 'spooler' }, input))
      .toEqual({ ok: true });
    const refused = serviceRecoveryRecipe.crossCheckStepInputs?.('execute', { serviceName: 'other' }, input);
    expect(refused?.ok).toBe(false);
    expect((refused as { detail: string }).detail).toContain('frozen');
  });

  it('inputSchema is the shipped admission schema: it parses a valid input and rejects a bad deviceId', () => {
    expect(serviceRecoveryRecipe.inputSchema.parse({ deviceId: DEVICE_ID, serviceName: 'spooler', triggeringAlertId: null }))
      .toMatchObject({ deviceId: DEVICE_ID, serviceName: 'spooler' });
    expect(() => serviceRecoveryRecipe.inputSchema.parse({ deviceId: 'nope', serviceName: 'spooler', triggeringAlertId: null })).toThrow();
  });
});
