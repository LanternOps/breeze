import { describe, expect, it } from 'vitest';
import { computeSignature, ruleConditionFacets } from './signature';
import { fixProblemSchema, signatureForProblem } from './problemSignature';

describe('deviceId + problem → signature', () => {
  it('matches the signature a rule-based alert with the same condition gets', () => {
    const leaf = { type: 'service_stopped', serviceName: 'Spooler' } as const;
    const fromAlert = ruleConditionFacets({ conditions: [leaf] })!;
    const expected = computeSignature({ family: 'alert', condition: fromAlert.condition, osFamily: 'windows', discriminator: fromAlert.discriminator, rootInferred: false });
    expect(signatureForProblem({ osFamily: 'windows', problem: leaf })).toEqual(expected);
    expect(expected!.broad).toBe(false);
  });

  it('a metric problem is broad (no discriminator) — it can only ever match "similar"', () => {
    expect(signatureForProblem({ osFamily: 'linux', problem: { type: 'metric', metric: 'disk_percent', operator: 'gt' } })!.broad).toBe(true);
  });

  it('rejects free text and unknown shapes', () => {
    expect(fixProblemSchema.safeParse({ type: 'service_stopped', serviceName: 'Spooler', description: 'it is broken' }).success).toBe(false);
    expect(fixProblemSchema.safeParse({ type: 'printer is jammed' }).success).toBe(false);
    expect(fixProblemSchema.safeParse('the spooler keeps stopping').success).toBe(false);
  });

  it('an incomplete leaf yields no signature (memory lookup skipped, not guessed)', () => {
    expect(signatureForProblem({ osFamily: 'windows', problem: { type: 'metric' } })).toBeNull();
  });
});
