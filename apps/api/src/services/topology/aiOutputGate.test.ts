import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ assertScope: vi.fn(), reauthorize: vi.fn() }));
vi.mock('./aiEvidence', async (original) => ({ ...await original<object>(), assertTopologyAiCurrentScope: mocks.assertScope }));
vi.mock('./aiCitations', async (original) => ({ ...await original<object>(), reauthorizeTopologyAiCitations: mocks.reauthorize }));
vi.mock('../secretCrypto', () => ({ getSecretDerivedKeyMaterials: () => ({ active: { keyId: 'k', key: Buffer.alloc(32, 7) }, retained: [] }) }));

import { TopologyAiScopeChangedError, type TopologyAiEvidenceSnapshot } from './aiEvidence';
import { TOPOLOGY_AI_OUTPUT_MAX_BYTES, TOPOLOGY_AI_OUTPUT_MAX_TOKENS, TopologyAiOutputGate } from './aiOutputGate';

const ORG = '10000000-0000-4000-8000-000000000001';
const SITE = '20000000-0000-4000-8000-000000000001';
const REL = '40000000-0000-4000-8000-000000000001';
const ctx = { auth: {}, permissions: {}, scope: { orgId: ORG, siteId: SITE } } as never;
const snapshot = {
  schemaVersion: 1, investigationId: 'inv', scope: { orgId: ORG, siteId: SITE },
  selection: { siteId: SITE, subject: { kind: 'relationship', id: REL }, view: 'physical', graphRevision: '7' },
  builtAt: '2026-09-26T12:00:00.000Z', freshUntil: '2026-09-26T12:05:00.000Z', revisions: { graph: '7', health: '3' },
  modelEvidence: {} as never,
  manifest: { [REL]: { id: REL, resourceType: 'relationship', resourceId: REL, observedAt: null, inspectorTarget: { kind: 'relationship', id: REL }, supports: ['topology', 'health'] } },
  omitted: { nodes: 0, relationships: 0, observations: 0, changes: 0 },
  scopeStamp: { scope: { orgId: ORG, siteId: SITE }, buildFence: '1', bindings: [], sources: [] },
} as TopologyAiEvidenceSnapshot;
const valid = JSON.stringify({ findings: [{ kind: 'finding', claim: 'health', text: 'The link reports failed checks.', citationIds: [REL] }], missingData: [], nextChecks: [] });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertScope.mockResolvedValue(undefined);
  mocks.reauthorize.mockResolvedValue({ allowed: [REL], unavailable: [] });
});

describe('TopologyAiOutputGate (M4 Task 3)', () => {
  it('buffers provider text server-side and publishes nothing until a validated, reauthorized answer', async () => {
    const gate = new TopologyAiOutputGate();
    for (const chunk of valid.match(/.{1,7}/gs)!) gate.append(chunk);
    const result = await gate.finish(ctx, snapshot);
    expect(result.outcome).toBe('explanation');
    expect(result.explanation).toMatchObject({ status: 'complete', findings: [{ kind: 'finding', citationIds: [REL] }] });
    expect(mocks.assertScope).toHaveBeenCalledWith(ctx, snapshot.scopeStamp);
    expect(mocks.reauthorize).toHaveBeenCalledWith(ctx, [REL], snapshot);
    expect(gate.bufferedBytes).toBe(0);
  });

  it('never returns raw text: invalid output, a secret and a foreign citation become the deterministic fallback', async () => {
    const gate = new TopologyAiOutputGate();
    gate.append('Here is FOREIGN-SITE-SECRET and {"findings":[');
    const result = await gate.finish(ctx, snapshot);
    expect(result.outcome).toBe('fallback');
    expect(JSON.stringify(result)).not.toContain('FOREIGN-SITE-SECRET');
    expect(result.explanation.reasons).toEqual(['invalid_model_output']);
  });

  it('removes a statement whose only source was revoked before the final flush', async () => {
    mocks.reauthorize.mockResolvedValue({ allowed: [], unavailable: [REL] });
    const gate = new TopologyAiOutputGate();
    gate.append(valid);
    const result = await gate.finish(ctx, snapshot);
    expect(result.explanation.findings).toEqual([]);
    expect(result.explanation.reasons).toContain('citation_unavailable');
  });

  it('refuses a current explanation when the investigation scope moved before the flush', async () => {
    mocks.assertScope.mockRejectedValue(new TopologyAiScopeChangedError());
    const gate = new TopologyAiOutputGate();
    gate.append(valid);
    const result = await gate.finish(ctx, snapshot);
    expect(result.outcome).toBe('scope_changed');
    expect(result.explanation).toMatchObject({ status: 'evidence_changed', findings: [], reasons: ['investigation_scope_changed'] });
    expect(mocks.reauthorize).not.toHaveBeenCalled();
  });

  it('caps at 64 KiB before append and never releases malformed partial JSON', async () => {
    const gate = new TopologyAiOutputGate();
    gate.append('{"findings":[' + '"x",'.repeat(TOPOLOGY_AI_OUTPUT_MAX_BYTES / 4));
    expect(gate.bufferedBytes).toBeLessThanOrEqual(TOPOLOGY_AI_OUTPUT_MAX_BYTES);
    expect(gate.overflowed).toBe(true);
    gate.append(valid); // after overflow, appends are dropped
    const result = await gate.finish(ctx, snapshot);
    expect(result).toMatchObject({ outcome: 'fallback', explanation: { reasons: ['output_limit_reached'] } });
  });

  it('caps reported output tokens at 2,000', async () => {
    const gate = new TopologyAiOutputGate();
    gate.append(valid);
    expect(gate.noteOutputTokens(TOPOLOGY_AI_OUTPUT_MAX_TOKENS)).toBe(true);
    expect(gate.noteOutputTokens(1)).toBe(false);
    expect((await gate.finish(ctx, snapshot)).explanation.reasons).toEqual(['output_limit_reached']);
  });

  it('discard erases the buffer and any later finish is the fallback', async () => {
    const gate = new TopologyAiOutputGate();
    gate.append(valid);
    gate.discard();
    expect(gate.bufferedBytes).toBe(0);
    expect((await gate.finish(ctx, snapshot)).outcome).toBe('fallback');
  });

  it('parses only the final text block, so narration before a tool call never corrupts the answer', async () => {
    const gate = new TopologyAiOutputGate();
    gate.append('Let me check the link evidence first.');
    gate.startBlock();
    gate.append(valid);
    expect((await gate.finish(ctx, snapshot)).outcome).toBe('explanation');
  });
});
