import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { AI_AGENT_ESCALATION_ROLES, MAX_FALLBACK_OFFERINGS } from '../constants/aiSurfaces';
import type { AiAssignmentRowDto, AiUsageBreakdownDto, AiUsageRowDto } from '../types/aiModelRegistry';
import {
  AI_ASSIGNMENT_WRITE_ROLES,
  AI_USAGE_GROUP_BYS,
  aiUsageQueryBaseSchema,
  AI_QUALITY_GROUP_BYS,
  aiQualityQuerySchema,
  aiPromptVariantReportQuerySchema,
  type AiAssignmentWriteRole,
  type AiUsageGroupBy,
  CONFIGURABLE_AI_SURFACES,
  CONFIGURABLE_AI_SURFACE_ROLES,
  orgAssignmentInputSchema,
  partnerAssignmentInputSchema,
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
  it('a usage row can flag a disconnected serving connection (groupBy=model only); totals never carry it', () => {
    expectTypeOf<AiUsageRowDto['connectionDisconnected']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<keyof AiUsageBreakdownDto['totals']>().not.toEqualTypeOf<keyof AiUsageBreakdownDto['totals'] | 'connectionDisconnected'>();
  });
});

describe('AI_ASSIGNMENT_WRITE_ROLES', () => {
  it('is the one role list the assignment input schemas accept', () => {
    expect(AI_ASSIGNMENT_WRITE_ROLES).toEqual(['default', ...AI_AGENT_ESCALATION_ROLES]);
    const row = { surface: 'chat', defaultOfferingId: OFF_A, permittedOfferingIds: null, allowUserChoice: true, options: null, expectedUpdatedAt: null };
    expect(partnerAssignmentsPutSchema.safeParse({ assignments: [{ ...row, role: 'default' }] }).success).toBe(true);
    expect(partnerAssignmentsPutSchema.safeParse({ assignments: [{ ...row, role: 'fallback' }] }).success).toBe(false);
    expectTypeOf<AiAssignmentRowDto['role']>().toEqualTypeOf<AiAssignmentWriteRole>();
  });
});
describe('W11 quality contract', () => {
  it('aiUsageQuerySchema behaves exactly as before (range rules re-applied through withUsageRangeRules)', () => {
    expect(aiUsageQuerySchema.safeParse({ groupBy: 'model' }).success).toBe(true);
    expect(aiUsageQuerySchema.safeParse({ groupBy: 'model', from: '2026-10-01' }).success).toBe(false);
    expect(aiUsageQuerySchema.safeParse({ groupBy: 'model', from: '2026-10-02', to: '2026-10-01' }).success).toBe(false);
    expect(aiUsageQuerySchema.safeParse({ groupBy: 'model', from: '2026-01-01', to: '2026-06-01' }).success).toBe(false);
  });
  it('aiQualityQuerySchema accepts the quality groupings and rejects spend-only ones', () => {
    for (const g of AI_QUALITY_GROUP_BYS) expect(aiQualityQuerySchema.safeParse({ groupBy: g }).success).toBe(true);
    expect(aiQualityQuerySchema.safeParse({ groupBy: 'user' }).success).toBe(false);
    expect(aiQualityQuerySchema.safeParse({ groupBy: 'prompt_variant' }).success).toBe(false);
  });
  it('aiQualityQuerySchema keeps the usage range rules (both-or-neither, ordered, ≤ 92 days)', () => {
    expect(aiQualityQuerySchema.safeParse({ groupBy: 'surface', to: '2026-10-01' }).success).toBe(false);
    expect(aiQualityQuerySchema.safeParse({ groupBy: 'surface', from: '2026-07-01', to: '2026-10-01' }).success).toBe(true);
    expect(aiQualityQuerySchema.safeParse({ groupBy: 'surface', from: '2026-06-01', to: '2026-10-01' }).success).toBe(false);
  });
  it('the prompt variant report caps the range at 31 days', () => {
    expect(aiPromptVariantReportQuerySchema.safeParse({}).success).toBe(true);
    expect(aiPromptVariantReportQuerySchema.safeParse({ from: '2026-09-01', to: '2026-10-01' }).success).toBe(true);
    expect(aiPromptVariantReportQuerySchema.safeParse({ from: '2026-08-01', to: '2026-10-01' }).success).toBe(false);
  });
});

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const partnerRow = (over: Record<string, unknown> = {}) => ({
  surface: 'ai_agents', role: 'default', defaultOfferingId: A, permittedOfferingIds: null,
  allowUserChoice: true, options: null, expectedUpdatedAt: null, ...over,
});

describe('W09 escalation roles', () => {
  it('lists every configurable (surface, role) pair, ai_agents with its three stages', () => {
    const agentRoles = CONFIGURABLE_AI_SURFACE_ROLES.filter((p) => p.surface === 'ai_agents').map((p) => p.role);
    expect(agentRoles).toEqual(['default', ...AI_AGENT_ESCALATION_ROLES]);
    expect(CONFIGURABLE_AI_SURFACE_ROLES.some((p) => p.surface === 'patch_test')).toBe(false);
  });

  it.each(AI_AGENT_ESCALATION_ROLES)('accepts role %s on ai_agents', (role) => {
    expect(partnerAssignmentInputSchema.safeParse(partnerRow({ role })).success).toBe(true);
  });

  it('rejects an escalation role on a surface that has none', () => {
    const r = partnerAssignmentInputSchema.safeParse(partnerRow({ surface: 'chat', role: 'triage' }));
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.path).toEqual(['role']);
  });

  it('a role row may clear its default (inherit the feature default) only when the whole row is blank', () => {
    expect(partnerAssignmentInputSchema.safeParse(partnerRow({ role: 'triage', defaultOfferingId: null })).success).toBe(true);
    expect(partnerAssignmentInputSchema.safeParse(partnerRow({ role: 'triage', defaultOfferingId: null, permittedOfferingIds: [A] })).success).toBe(false);
    expect(partnerAssignmentInputSchema.safeParse(partnerRow({ role: 'default', defaultOfferingId: null })).success).toBe(false);
  });

  it('accepts one partner row per (surface, role), including all four ai_agents rows', () => {
    const rows = ['default', ...AI_AGENT_ESCALATION_ROLES].map((role) => partnerRow({ role }));
    expect(partnerAssignmentsPutSchema.safeParse({ assignments: rows }).success).toBe(true);
    expect(partnerAssignmentsPutSchema.safeParse({ assignments: [partnerRow(), partnerRow()] }).success).toBe(false);
  });
});

describe('W09 fallback list', () => {
  it('carries an ordered fallback list and the cross-funding switch', () => {
    const parsed = partnerAssignmentInputSchema.parse(partnerRow({ fallbackOfferingIds: [C, B], fallbackMayCrossFunding: true }));
    expect(parsed.fallbackOfferingIds).toEqual([C, B]);
    expect(parsed.fallbackMayCrossFunding).toBe(true);
  });

  it('omitted fallback fields stay undefined (the write preserves the stored list)', () => {
    const parsed = partnerAssignmentInputSchema.parse(partnerRow());
    expect(parsed.fallbackOfferingIds).toBeUndefined();
    expect(parsed.fallbackMayCrossFunding).toBeUndefined();
  });

  it.each([
    ['a duplicate', [B, B]],
    ['the default itself', [B, A]],
    ['more than the cap', Array.from({ length: MAX_FALLBACK_OFFERINGS + 1 }, (_, i) => `4444444${i}-4444-4444-8444-444444444444`)],
  ])('rejects %s', (_l, ids) => {
    expect(partnerAssignmentInputSchema.safeParse(partnerRow({ fallbackOfferingIds: ids })).success).toBe(false);
  });

  it('an org may only switch cross-funding OFF or inherit it', () => {
    const org = { surface: 'chat', role: 'default', defaultOfferingId: null, permittedOfferingIds: null, allowUserChoice: null, options: null, expectedUpdatedAt: null };
    expect(orgAssignmentInputSchema.safeParse({ ...org, fallbackMayCrossFunding: false }).success).toBe(true);
    expect(orgAssignmentInputSchema.safeParse({ ...org, fallbackMayCrossFunding: null }).success).toBe(true);
    expect(orgAssignmentInputSchema.safeParse({ ...org, fallbackMayCrossFunding: true }).success).toBe(false);
    expect(orgAssignmentInputSchema.safeParse({ ...org, fallbackOfferingIds: [B] }).success).toBe(true);
  });
});
