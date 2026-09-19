import { describe, expect, it } from 'vitest';
import { impactQuerySchema, impactRebuildQuerySchema, impactWeightsSchema } from './aiAgentImpact';

describe('impactWeightsSchema', () => {
  it('accepts an empty object (no overrides)', () => {
    expect(impactWeightsSchema.safeParse({}).success).toBe(true);
  });
  it('accepts a single in-range key', () => {
    const result = impactWeightsSchema.safeParse({ fixExecuted: 900 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ fixExecuted: 900 });
  });
  it('rejects a value above IMPACT_WEIGHT_MAX_SECONDS', () => {
    expect(impactWeightsSchema.safeParse({ fixExecuted: 86_401 }).success).toBe(false);
  });
  it('rejects a negative value', () => {
    expect(impactWeightsSchema.safeParse({ fixExecuted: -1 }).success).toBe(false);
  });
  it('rejects a non-integer value', () => {
    expect(impactWeightsSchema.safeParse({ fixExecuted: 1.5 }).success).toBe(false);
  });
  it('rejects an unknown key (strict — a client bug, not a silent no-op)', () => {
    expect(impactWeightsSchema.safeParse({ bogus: 1 }).success).toBe(false);
  });
});

describe('impactQuerySchema', () => {
  it.each([
    ['7', 7],
    ['30', 30],
    ['90', 90],
  ])('coerces window %s to the number %d', (input, expected) => {
    const result = impactQuerySchema.safeParse({ window: input });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.window).toBe(expected);
  });
  it('defaults window to 30 when absent', () => {
    const result = impactQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.window).toBe(30);
  });
  it('rejects window=1 (not one of the three supported windows)', () => {
    expect(impactQuerySchema.safeParse({ window: '1' }).success).toBe(false);
  });
  it('rejects window=365', () => {
    expect(impactQuerySchema.safeParse({ window: '365' }).success).toBe(false);
  });
  it('accepts a uuid orgId', () => {
    const result = impactQuerySchema.safeParse({ window: '30', orgId: '123e4567-e89b-12d3-a456-426614174000' });
    expect(result.success).toBe(true);
  });
  it('rejects a non-uuid orgId', () => {
    expect(impactQuerySchema.safeParse({ window: '30', orgId: 'not-a-uuid' }).success).toBe(false);
  });
});

describe('impactRebuildQuerySchema', () => {
  it('accepts no orgId', () => {
    expect(impactRebuildQuerySchema.safeParse({}).success).toBe(true);
  });
  it('accepts a uuid orgId', () => {
    expect(impactRebuildQuerySchema.safeParse({ orgId: '123e4567-e89b-12d3-a456-426614174000' }).success).toBe(true);
  });
  it('rejects a non-uuid orgId', () => {
    expect(impactRebuildQuerySchema.safeParse({ orgId: 'not-a-uuid' }).success).toBe(false);
  });
});
