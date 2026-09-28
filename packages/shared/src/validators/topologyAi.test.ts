import { describe, expect, it } from 'vitest';
import {
  TOPOLOGY_AI_LIMITS,
  topologyAiExplanationSchema,
  topologyAiModelOutputSchema,
  topologyAiSelectionSchema,
} from './topologyAi';

const SITE = '11111111-1111-4111-8111-111111111111';
const NODE = '22222222-2222-4222-8222-222222222222';

const explanation = {
  schemaVersion: 1, status: 'complete', findings: [], missingData: [], nextChecks: [], citationIds: [], citations: [], reasons: [],
};

describe('topology AI contracts (M4 Task 2)', () => {
  it('accepts a selection of IDs only — never evidence bodies or an org', () => {
    expect(topologyAiSelectionSchema.safeParse({ siteId: SITE, subject: { kind: 'node', id: NODE }, view: 'physical', graphRevision: '7' }).success).toBe(true);
    expect(topologyAiSelectionSchema.safeParse({ siteId: SITE, subject: { kind: 'node', id: NODE }, view: 'physical', graphRevision: '7', evidence: [] }).success).toBe(false);
    expect(topologyAiSelectionSchema.safeParse({ siteId: SITE, orgId: SITE, subject: { kind: 'node', id: NODE }, view: 'physical', graphRevision: '7' }).success).toBe(false);
  });

  it('keeps the explanation strict and bounded', () => {
    expect(topologyAiExplanationSchema.safeParse(explanation).success).toBe(true);
    expect(topologyAiExplanationSchema.safeParse({ ...explanation, prose: 'raw model text' }).success).toBe(false);
    expect(topologyAiExplanationSchema.safeParse({ ...explanation, status: 'verified' }).success).toBe(false);
    const finding = { kind: 'finding', claim: 'health', text: 'x', citationIds: [NODE] };
    expect(topologyAiExplanationSchema.safeParse({ ...explanation, findings: Array(TOPOLOGY_AI_LIMITS.findings + 1).fill(finding) }).success).toBe(false);
    expect(topologyAiExplanationSchema.safeParse({ ...explanation, nextChecks: [{ recipeId: 'run_anything', rationale: 'x', citationIds: [] }] }).success).toBe(false);
  });

  it('parses model output strictly: no extra fields, no markdown blob in place of structure', () => {
    expect(topologyAiModelOutputSchema.safeParse({ findings: [{ kind: 'finding', claim: 'health', text: 't', citationIds: [NODE] }], missingData: [], nextChecks: [] }).success).toBe(true);
    expect(topologyAiModelOutputSchema.safeParse({ findings: [], missingData: [], nextChecks: [], answer: '# Markdown' }).success).toBe(false);
    expect(topologyAiModelOutputSchema.safeParse({ findings: [{ kind: 'finding', claim: 'health', text: 't', citationIds: [NODE], url: 'https://x' }], missingData: [], nextChecks: [] }).success).toBe(false);
  });
});
