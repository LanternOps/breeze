// apps/api/src/services/aiAgents/tools/submitTaskStep.test.ts
import { describe, expect, it } from 'vitest';
import { submitTaskStepSchema } from '@breeze/shared';
import { SUBMIT_TASK_STEP_SHAPE, validateSubmitTaskStep } from './submitTaskStep';

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    findings: [
      {
        text: 'the spooler service was found stopped',
        sourceKind: 'service_state',
        sourceId: 'spooler',
        observedAt: '2026-09-01T00:00:00.000Z',
      },
    ],
    nextStep: { kind: 'step', key: 'execute', inputs: { serviceName: 'spooler' } },
    ...overrides,
  };
}

describe('validateSubmitTaskStep', () => {
  it('accepts a well-formed payload with nextStep.kind = step', () => {
    expect(() => validateSubmitTaskStep(payload())).not.toThrow();
  });

  it('accepts a well-formed payload with nextStep.kind = handoff', () => {
    expect(() =>
      validateSubmitTaskStep(payload({
        nextStep: { kind: 'handoff', reason: 'restart failed twice', summary: 'tried restarting, still down' },
      }))).not.toThrow();
  });

  it('accepts a well-formed payload with nextStep.kind = question', () => {
    expect(() =>
      validateSubmitTaskStep(payload({
        nextStep: { kind: 'question', text: 'is a maintenance window scheduled for this device?' },
      }))).not.toThrow();
  });

  it('rejects the wrong version', () => {
    expect(() => validateSubmitTaskStep(payload({ version: 2 }))).toThrow();
  });

  it('rejects a findings[].text over 500 chars', () => {
    expect(() =>
      validateSubmitTaskStep(payload({
        findings: [
          {
            text: 'x'.repeat(501),
            sourceKind: 'service_state',
            sourceId: 'spooler',
            observedAt: '2026-09-01T00:00:00.000Z',
          },
        ],
      }))).toThrow();
  });

  it('rejects more than 20 findings', () => {
    const findings = Array.from({ length: 21 }, (_, i) => ({
      text: `finding ${i}`,
      sourceKind: 'service_state',
      sourceId: 'spooler',
      observedAt: '2026-09-01T00:00:00.000Z',
    }));
    expect(() => validateSubmitTaskStep(payload({ findings }))).toThrow();
  });

  it('rejects a non-ISO observedAt', () => {
    expect(() =>
      validateSubmitTaskStep(payload({
        findings: [
          {
            text: 'the spooler service was found stopped',
            sourceKind: 'service_state',
            sourceId: 'spooler',
            observedAt: 'yesterday',
          },
        ],
      }))).toThrow();
  });

  it('rejects an unknown extra top-level key (schema is .strict())', () => {
    expect(() => validateSubmitTaskStep(payload({ extraField: 'not allowed' }))).toThrow();
  });

  it('rejects an unknown extra key on a finding (schema is .strict())', () => {
    expect(() =>
      validateSubmitTaskStep(payload({
        findings: [
          {
            text: 'the spooler service was found stopped',
            sourceKind: 'service_state',
            sourceId: 'spooler',
            observedAt: '2026-09-01T00:00:00.000Z',
            extra: 'nope',
          },
        ],
      }))).toThrow();
  });

  it('rejects a nextStep with no kind', () => {
    expect(() => validateSubmitTaskStep(payload({ nextStep: { key: 'execute', inputs: {} } }))).toThrow();
  });

  it('rejects a handoff summary over 2000 chars', () => {
    expect(() =>
      validateSubmitTaskStep(payload({
        nextStep: { kind: 'handoff', reason: 'restart failed', summary: 'x'.repeat(2001) },
      }))).toThrow();
  });
});

describe('SUBMIT_TASK_STEP_SHAPE / submitTaskStepSchema parity', () => {
  it('has the same top-level keys as the shared persistence schema, so the ' +
    'model-facing shape and the persistence contract cannot drift', () => {
    expect(Object.keys(SUBMIT_TASK_STEP_SHAPE).sort()).toEqual(
      Object.keys(submitTaskStepSchema.shape).sort(),
    );
  });
});
