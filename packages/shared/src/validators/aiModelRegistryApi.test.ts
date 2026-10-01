import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import type { AiAssignmentRowDto, AiUsageBreakdownDto } from '../types/aiModelRegistry';
import {
  AI_ASSIGNMENT_WRITE_ROLES,
  AI_USAGE_GROUP_BYS,
  aiUsageQueryBaseSchema,
  type AiAssignmentWriteRole,
  type AiUsageGroupBy,
  CONFIGURABLE_AI_SURFACES,
  MAX_AI_USAGE_RANGE_DAYS,
  aiUsageQuerySchema,
  connectionCreateSchema,
  connectionSettingsPatchSchema,
  offeringDetailsPatchSchema,
  orgAssignmentsPutSchema,
  partnerAssignmentsPutSchema,
  residencyPutSchema,
} from './aiModelRegistryApi';

const OFF_A = '0b8f1f2e-6a1c-4c55-9a39-6a7f1e1c0a01';
const OFF_B = '0b8f1f2e-6a1c-4c55-9a39-6a7f1e1c0a02';

describe('CONFIGURABLE_AI_SURFACES', () => {
  it('is every surface except the platform-only patch_test', () => {
    expect(CONFIGURABLE_AI_SURFACES).not.toContain('patch_test');
    expect(CONFIGURABLE_AI_SURFACES).toHaveLength(9);
  });
});

describe('connectionCreateSchema', () => {
  it('accepts an anthropic_byok create', () => {
    expect(connectionCreateSchema.parse({ kind: 'anthropic_byok', apiKey: 'sk-ant-api03-' + 'x'.repeat(40) }))
      .toMatchObject({ kind: 'anthropic_byok' });
  });
  it('rejects a kind W04 does not create (W06/W07 add arms)', () => {
    expect(connectionCreateSchema.safeParse({ kind: 'openai_compatible', apiKey: 'x'.repeat(30), baseUrl: 'https://example.com' }).success).toBe(false);
  });
  it('rejects a short key', () => {
    expect(connectionCreateSchema.safeParse({ kind: 'anthropic_byok', apiKey: 'short' }).success).toBe(false);
  });
});

describe('connectionSettingsPatchSchema', () => {
  it('requires at least one field', () => {
    expect(connectionSettingsPatchSchema.safeParse({}).success).toBe(false);
  });
  it('accepts clearing the geo with null', () => {
    expect(connectionSettingsPatchSchema.parse({ inferenceGeo: null })).toEqual({ inferenceGeo: null });
  });
  it('rejects a geo outside INFERENCE_GEO_PATTERN', () => {
    expect(connectionSettingsPatchSchema.safeParse({ inferenceGeo: 'EU West!' }).success).toBe(false);
  });
});

describe('offeringDetailsPatchSchema', () => {
  it('requires expectedUpdatedAt', () => {
    expect(offeringDetailsPatchSchema.safeParse({ displayName: 'x' }).success).toBe(false);
  });
  it('accepts all-four prices or null, never a partial set', () => {
    const base = { expectedUpdatedAt: '2026-10-01T00:00:00.000Z' };
    expect(offeringDetailsPatchSchema.safeParse({ ...base, prices: null }).success).toBe(true);
    expect(offeringDetailsPatchSchema.safeParse({
      ...base, prices: { inputCentsPerM: 300, outputCentsPerM: 1500, cacheReadCentsPerM: 30, cacheWriteCentsPerM: 375 },
    }).success).toBe(true);
    expect(offeringDetailsPatchSchema.safeParse({ ...base, prices: { inputCentsPerM: 300 } }).success).toBe(false);
  });
  it('limits requiredPermission to the offered choices or null', () => {
    const base = { expectedUpdatedAt: '2026-10-01T00:00:00.000Z' };
    expect(offeringDetailsPatchSchema.safeParse({ ...base, requiredPermission: 'ai_models:premium' }).success).toBe(true);
    expect(offeringDetailsPatchSchema.safeParse({ ...base, requiredPermission: null }).success).toBe(true);
    expect(offeringDetailsPatchSchema.safeParse({ ...base, requiredPermission: 'billing:manage' }).success).toBe(false);
  });
});

describe('partnerAssignmentsPutSchema', () => {
  const row = {
    surface: 'chat', role: 'default', defaultOfferingId: OFF_A, permittedOfferingIds: null,
    allowUserChoice: true, options: { effort: 'high' }, expectedUpdatedAt: null,
  };
  it('accepts a partner row', () => {
    expect(partnerAssignmentsPutSchema.parse({ assignments: [row] }).assignments).toHaveLength(1);
  });
  it('rejects role other than default (W09 widens this)', () => {
    expect(partnerAssignmentsPutSchema.safeParse({ assignments: [{ ...row, surface: 'ai_agents', role: 'triage' }] }).success).toBe(false);
  });
  it('rejects patch_test (platform-only)', () => {
    expect(partnerAssignmentsPutSchema.safeParse({ assignments: [{ ...row, surface: 'patch_test' }] }).success).toBe(false);
  });
  it('rejects a partner row with no default', () => {
    expect(partnerAssignmentsPutSchema.safeParse({ assignments: [{ ...row, defaultOfferingId: null }] }).success).toBe(false);
  });
  it('rejects an empty permitted list (use null for all)', () => {
    expect(partnerAssignmentsPutSchema.safeParse({ assignments: [{ ...row, permittedOfferingIds: [] }] }).success).toBe(false);
  });
  it('rejects duplicate surfaces in one PUT', () => {
    expect(partnerAssignmentsPutSchema.safeParse({ assignments: [row, row] }).success).toBe(false);
  });
  it('never carries fallback fields (W09)', () => {
    const parsed = partnerAssignmentsPutSchema.parse({ assignments: [{ ...row, fallbackOfferingIds: [OFF_B] }] });
    expect(parsed.assignments[0]).not.toHaveProperty('fallbackOfferingIds');
  });
});

describe('orgAssignmentsPutSchema', () => {
  it('accepts an all-inherit row (clears the override)', () => {
    expect(orgAssignmentsPutSchema.parse({ assignments: [{
      surface: 'chat', role: 'default', defaultOfferingId: null, permittedOfferingIds: null,
      allowUserChoice: null, options: null, expectedUpdatedAt: '2026-10-01T00:00:00.000Z',
    }] }).assignments[0]?.defaultOfferingId).toBeNull();
  });
  it('rejects allowUserChoice: true (an org can only lock, never unlock)', () => {
    expect(orgAssignmentsPutSchema.safeParse({ assignments: [{
      surface: 'chat', role: 'default', defaultOfferingId: null, permittedOfferingIds: null,
      allowUserChoice: true, options: null, expectedUpdatedAt: null,
    }] }).success).toBe(false);
  });
});

describe('residencyPutSchema', () => {
  it('defaults acknowledgeImpact to false', () => {
    expect(residencyPutSchema.parse({ required: true })).toEqual({ required: true, acknowledgeImpact: false });
  });
});

describe('aiUsageQuerySchema', () => {
  it('accepts each groupBy', () => {
    for (const groupBy of AI_USAGE_GROUP_BYS) expect(aiUsageQuerySchema.safeParse({ groupBy }).success).toBe(true);
  });
  it(`rejects a range longer than ${MAX_AI_USAGE_RANGE_DAYS} days`, () => {
    expect(aiUsageQuerySchema.safeParse({ groupBy: 'model', from: '2026-01-01', to: '2026-06-01' }).success).toBe(false);
  });
  it('rejects from after to', () => {
    expect(aiUsageQuerySchema.safeParse({ groupBy: 'model', from: '2026-10-02', to: '2026-10-01' }).success).toBe(false);
  });
  it('rejects a one-sided range (would bypass the length cap)', () => {
    expect(aiUsageQuerySchema.safeParse({ groupBy: 'model', from: '2020-01-01' }).success).toBe(false);
    expect(aiUsageQuerySchema.safeParse({ groupBy: 'model', to: '2026-10-01' }).success).toBe(false);
  });
  it('rejects impossible calendar dates', () => {
    expect(aiUsageQuerySchema.safeParse({ groupBy: 'model', from: '2026-02-30', to: '2026-03-01' }).success).toBe(false);
  });
});

describe('aiUsageQueryBaseSchema', () => {
  it('is a plain object schema later waves can extend; the refined schema keeps the range rules', () => {
    const extended = aiUsageQueryBaseSchema.extend({ extra: z.string().optional() });
    expect(Object.keys(extended.shape)).toEqual(['groupBy', 'from', 'to', 'orgId', 'extra']);
    // The base carries no refines; the exported query schema does.
    expect(aiUsageQueryBaseSchema.safeParse({ groupBy: 'model', from: '2020-01-01' }).success).toBe(true);
    expect(aiUsageQuerySchema.safeParse({ groupBy: 'model', from: '2020-01-01' }).success).toBe(false);
  });
  it('the breakdown DTO groupBy is the validator union', () => {
    expectTypeOf<AiUsageBreakdownDto['groupBy']>().toEqualTypeOf<AiUsageGroupBy>();
  });
});

describe('AI_ASSIGNMENT_WRITE_ROLES', () => {
  it('is the one role list the assignment input schemas accept', () => {
    expect(AI_ASSIGNMENT_WRITE_ROLES).toEqual(['default']);
    const row = { surface: 'chat', defaultOfferingId: OFF_A, permittedOfferingIds: null, allowUserChoice: true, options: null, expectedUpdatedAt: null };
    expect(partnerAssignmentsPutSchema.safeParse({ assignments: [{ ...row, role: 'default' }] }).success).toBe(true);
    expect(partnerAssignmentsPutSchema.safeParse({ assignments: [{ ...row, role: 'fallback' }] }).success).toBe(false);
    expectTypeOf<AiAssignmentRowDto['role']>().toEqualTypeOf<AiAssignmentWriteRole>();
  });
});
