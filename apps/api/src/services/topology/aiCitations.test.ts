import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ permissions: vi.fn(), access: vi.fn(), execute: vi.fn() }));
vi.mock('../../db', () => ({ db: { execute: mocks.execute } }));
vi.mock('../permissions', () => ({ getUserPermissions: mocks.permissions }));
vi.mock('./access', async (original) => ({ ...await original<object>(), requireTopologySiteAccess: mocks.access }));

import { topologyAiExplanationSchema } from '@breeze/shared';
import { TopologyError } from './access';
import { applyTopologyAiCitationAvailability, reauthorizeTopologyAiCitations, TOPOLOGY_AI_FALLBACK_REASON, validateTopologyAiExplanation } from './aiCitations';
import type { TopologyAiEvidenceSnapshot } from './aiEvidence';

const ORG = '10000000-0000-4000-8000-000000000001';
const SITE = '20000000-0000-4000-8000-000000000001';
const NODE = '30000000-0000-4000-8000-000000000001';
const REL = '40000000-0000-4000-8000-000000000001';
const OBS = '80000000-0000-4000-8000-000000000001';
const FOREIGN = '40000000-0000-4000-8000-0000000000ff';
const RUN_CHANGE = 'measurement_result:90000000-0000-4000-8000-000000000001';

/** A complete empty snapshot with a fixed scope, revisions and manifest. */
const emptyEvidenceSnapshot: TopologyAiEvidenceSnapshot = {
  schemaVersion: 1, investigationId: 'inv-empty', scope: { orgId: ORG, siteId: SITE },
  selection: { siteId: SITE, subject: { kind: 'node', id: NODE }, view: 'overview', graphRevision: '1' },
  builtAt: '2026-09-26T12:00:00.000Z', freshUntil: '2026-09-26T12:05:00.000Z', revisions: { graph: '1', health: '1' },
  modelEvidence: { schemaVersion: 1, scope: { siteAlias: 'site-1' }, revisions: { graph: '1', health: '1' }, subject: { kind: 'node', id: NODE },
    nodes: [], relationships: [], observations: [], linkHealth: null, changes: [], omitted: { nodes: 0, relationships: 0, observations: 0, changes: 0 },
    untrustedFields: [], constraints: [] },
  manifest: {}, omitted: { nodes: 0, relationships: 0, observations: 0, changes: 0 },
  scopeStamp: { scope: { orgId: ORG, siteId: SITE }, buildFence: '1', bindings: [], sources: [] },
};
const snapshot: TopologyAiEvidenceSnapshot = {
  ...emptyEvidenceSnapshot,
  manifest: {
    [NODE]: { id: NODE, resourceType: 'node', resourceId: NODE, observedAt: null, inspectorTarget: { kind: 'node', id: NODE }, supports: ['topology', 'health'] },
    [REL]: { id: REL, resourceType: 'relationship', resourceId: REL, observedAt: null, inspectorTarget: { kind: 'relationship', id: REL }, supports: ['topology', 'health'] },
    [OBS]: { id: OBS, resourceType: 'observation', resourceId: OBS, observedAt: '2026-09-26T11:00:00.000Z', inspectorTarget: { kind: 'relationship', id: REL }, supports: ['topology'] },
    [RUN_CHANGE]: { id: RUN_CHANGE, resourceType: 'change', resourceId: '90000000-0000-4000-8000-000000000001', observedAt: '2026-09-26T11:30:00.000Z', inspectorTarget: null, supports: ['change', 'reachability'] },
  },
};
const output = (findings: unknown[], extra: Record<string, unknown> = {}) => ({ findings, missingData: [], nextChecks: [], ...extra });

describe('validateTopologyAiExplanation (M4 Task 2)', () => {
  it('cannot promote an uncited cable claim to a finding', () => {
    const result = validateTopologyAiExplanation(output([{ kind: 'finding', claim: 'topology', text: 'The cable is broken', citationIds: ['not-retrieved'] }]), emptyEvidenceSnapshot);
    expect(result.findings[0]!.kind).toBe('hypothesis');
    expect(result.findings[0]!.citationIds).toEqual([]);
    expect(result.reasons).toContain('unsupported_citation');
    expect(result.status).toBe('partial');
  });

  it('keeps a supported, cited observation as a finding and returns only manifest citations', () => {
    const result = validateTopologyAiExplanation(output([{ kind: 'finding', claim: 'health', text: 'Link host-1a2b3c4d reports failed checks.', citationIds: [REL, REL] }]), snapshot);
    expect(result).toMatchObject({ status: 'complete', reasons: [], citationIds: [REL] });
    expect(result.findings[0]).toEqual({ kind: 'finding', claim: 'health', text: 'Link host-1a2b3c4d reports failed checks.', citationIds: [REL] });
    expect(result.citations).toEqual([{ id: REL, resourceType: 'relationship', resourceId: REL, observedAt: null, inspectorTarget: { kind: 'relationship', id: REL } }]);
    expect(topologyAiExplanationSchema.parse(result)).toEqual(result);
  });

  it('keeps model causal interpretation a hypothesis even with valid citations', () => {
    const result = validateTopologyAiExplanation(output([{ kind: 'finding', claim: 'cause', text: 'The switch reboot caused the outage.', citationIds: [REL] }]), snapshot);
    expect(result.findings[0]).toMatchObject({ kind: 'hypothesis', citationIds: [REL] });
    expect(result.reasons).toContain('causal_claim_demoted');
  });

  it('an ICMP timeout cannot support a verified physical-cable fault', () => {
    const result = validateTopologyAiExplanation(output([
      { kind: 'finding', claim: 'physical_fault', text: 'The cable is cut.', citationIds: [RUN_CHANGE] },
      { kind: 'finding', claim: 'reachability', text: 'The gateway check timed out.', citationIds: [RUN_CHANGE] },
      { kind: 'finding', claim: 'measurement', text: 'Utilization spiked.', citationIds: [OBS] },
    ]), snapshot);
    expect(result.findings.map((f) => f.kind)).toEqual(['hypothesis', 'finding', 'hypothesis']);
    expect(result.reasons).toEqual(expect.arrayContaining(['causal_claim_demoted', 'claim_not_supported']));
  });

  it('drops a foreign-site citation, an unknown recipe, and strips URLs, Markdown links and controls', () => {
    const result = validateTopologyAiExplanation(output(
      [{ kind: 'finding', claim: 'topology', text: 'See [the portal](https://evil.example/steal?t=1) \u0007 now https://x.example/a', citationIds: [FOREIGN, NODE] }],
      { missingData: ['No LLDP from host-aa ‮'], nextChecks: [{ recipeId: 'run_script', rationale: 'x', citationIds: [] }, { recipeId: 'gateway_basic', rationale: 'Check the gateway.', citationIds: [FOREIGN] }] },
    ), snapshot);
    expect(result.findings[0]!.citationIds).toEqual([NODE]);
    expect(result.findings[0]!.text).not.toMatch(/https?:|\]\(|[\u0000-\u001f]/);
    expect(result.nextChecks).toEqual([{ recipeId: 'gateway_basic', rationale: 'Check the gateway.', citationIds: [] }]);
    expect(result.missingData[0]).not.toMatch(/‮/);
    expect(result.reasons).toEqual(expect.arrayContaining(['unsupported_citation', 'unknown_recipe']));
  });

  it('replaces invalid, truncated or wrapped raw output with the deterministic fallback — never raw prose', () => {
    for (const raw of ['The answer is: FOREIGN-SITE-SECRET', '{"findings":[{"kind":"finding"', { findings: [], missingData: [], nextChecks: [], prose: 'FOREIGN-SITE-SECRET' }, 42, null]) {
      const result = validateTopologyAiExplanation(raw, snapshot);
      expect(result).toEqual({ schemaVersion: 1, status: 'partial', findings: [], missingData: ['The explanation could not be validated; no model statement is shown.'],
        nextChecks: [], citationIds: [], citations: [], reasons: [TOPOLOGY_AI_FALLBACK_REASON] });
      expect(JSON.stringify(result)).not.toContain('FOREIGN-SITE-SECRET');
    }
  });

  it('accepts a single fenced JSON block from the complete output', () => {
    const raw = '```json\n' + JSON.stringify(output([{ kind: 'hypothesis', claim: 'cause', text: 'Maybe a loop.', citationIds: [REL] }])) + '\n```';
    expect(validateTopologyAiExplanation(raw, snapshot).findings[0]).toMatchObject({ kind: 'hypothesis', citationIds: [REL] });
  });
});

describe('citation cap (review C6)', () => {
  // 12 findings x 8 distinct citations = 96 > the 64-citation cap. A finding
  // whose citations fall past the cap must be DROPPED, never published with
  // ids the top-level citation list no longer carries.
  const many = Object.fromEntries(Array.from({ length: 96 }, (_, i) => {
    const id = `31000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    return [id, { id, resourceType: 'node' as const, resourceId: id, observedAt: null, inspectorTarget: { kind: 'node' as const, id }, supports: ['topology' as const, 'health' as const] }];
  }));
  const ids = Object.keys(many);
  const capped: TopologyAiEvidenceSnapshot = { ...emptyEvidenceSnapshot, manifest: many };

  it('never publishes a finding whose citations were truncated away', () => {
    const findings = Array.from({ length: 12 }, (_, i) => ({ kind: 'finding', claim: 'topology', text: `Finding ${i}.`, citationIds: ids.slice(i * 8, i * 8 + 8) }));
    const result = validateTopologyAiExplanation(output(findings), capped);
    const published = new Set(result.citationIds);
    expect(result.citationIds.length).toBeLessThanOrEqual(64);
    for (const finding of result.findings) {
      expect(finding.citationIds.length).toBeGreaterThan(0);
      for (const id of finding.citationIds) expect(published.has(id)).toBe(true);
    }
    for (const check of result.nextChecks) for (const id of check.citationIds) expect(published.has(id)).toBe(true);
    expect(result.findings).toHaveLength(8);
    expect(result.reasons).toContain('citation_limit');
    expect(result.status).toBe('partial');
  });

  it('drops a next check whose citations do not fit either', () => {
    const findings = Array.from({ length: 8 }, (_, i) => ({ kind: 'finding', claim: 'topology', text: `Finding ${i}.`, citationIds: ids.slice(i * 8, i * 8 + 8) }));
    const result = validateTopologyAiExplanation(output(findings, { nextChecks: [{ recipeId: 'gateway_basic', rationale: 'Check it.', citationIds: [ids[70]!] }] }), capped);
    expect(result.nextChecks).toEqual([]);
    expect(result.reasons).toContain('citation_limit');
  });
});

describe('host alias display mapping (M4 Task 5)', () => {
  const ALIAS = 'host-1a2b3c4d';
  const aliased: TopologyAiEvidenceSnapshot = {
    ...snapshot,
    modelEvidence: { ...snapshot.modelEvidence, nodes: [{ id: NODE, alias: ALIAS, kind: 'switch', role: null, bindingKinds: [], lifecycle: 'active', freshness: 'fresh',
      health: { status: 'healthy', coverage: 'full', freshness: 'fresh', reasons: [] } }] },
  };

  it('publishes alias -> node id only for snapshot nodes the published text mentions', () => {
    const result = validateTopologyAiExplanation(output(
      [{ kind: 'finding', claim: 'health', text: `Uplink of ${ALIAS} reports failed checks; host-deadbeef is unknown.`, citationIds: [REL] }],
      { missingData: [`No LLDP from ${ALIAS}.`] },
    ), aliased);
    expect(result.hostAliases).toEqual([{ alias: ALIAS, nodeId: NODE }]);
    expect(topologyAiExplanationSchema.parse(result)).toEqual(result);
  });

  it('omits the mapping when no alias is mentioned, and never maps a model-invented alias', () => {
    expect(validateTopologyAiExplanation(output([{ kind: 'finding', claim: 'health', text: 'Link failing.', citationIds: [REL] }]), aliased)).not.toHaveProperty('hostAliases');
    expect(validateTopologyAiExplanation(output([{ kind: 'hypothesis', claim: 'cause', text: 'host-deadbeef loops.', citationIds: [] }]), aliased)).not.toHaveProperty('hostAliases');
  });

  it('drops the mapping of a node whose citation became unavailable', () => {
    const explanation = validateTopologyAiExplanation(output([
      { kind: 'finding', claim: 'topology', text: `${ALIAS} is present.`, citationIds: [NODE] },
      { kind: 'hypothesis', claim: 'cause', text: `${ALIAS} may loop.`, citationIds: [] },
    ]), aliased);
    expect(explanation.hostAliases).toEqual([{ alias: ALIAS, nodeId: NODE }]);
    const result = applyTopologyAiCitationAvailability(explanation, { allowed: [], unavailable: [NODE] }, aliased);
    expect(result).not.toHaveProperty('hostAliases');
  });
});

describe('reauthorizeTopologyAiCitations (M4 Task 2)', () => {
  const ctx = { auth: { user: { id: 'u' }, partnerId: null, orgId: ORG, scope: 'organization' }, permissions: {}, scope: { orgId: ORG, siteId: SITE } } as never;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.permissions.mockResolvedValue({ permissions: [] });
    mocks.access.mockResolvedValue({ scope: { orgId: ORG, siteId: SITE } });
  });

  it('checks current permissions and live resources before a response or detail open', async () => {
    mocks.execute.mockResolvedValue([{ id: NODE }]);
    const result = await reauthorizeTopologyAiCitations(ctx, [NODE, REL, 'unknown-id'], snapshot);
    expect(mocks.access).toHaveBeenCalledWith(expect.anything(), expect.anything(), SITE, 'read');
    expect(result.allowed).toContain(NODE);
    expect(result.unavailable).toEqual(expect.arrayContaining([REL, 'unknown-id']));
  });

  it('makes every citation unavailable once the site is no longer readable', async () => {
    mocks.access.mockRejectedValue(new TopologyError('topology_permission_denied', 403, 'x'));
    expect(await reauthorizeTopologyAiCitations(ctx, [NODE, REL], snapshot)).toEqual({ allowed: [], unavailable: [NODE, REL] });
    mocks.access.mockResolvedValue({ scope: { orgId: ORG, siteId: '20000000-0000-4000-8000-0000000000ff' } });
    expect(await reauthorizeTopologyAiCitations(ctx, [NODE], snapshot)).toEqual({ allowed: [], unavailable: [NODE] });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('removes text that depended only on now-unavailable evidence', () => {
    const explanation = validateTopologyAiExplanation(output([
      { kind: 'finding', claim: 'health', text: 'Relationship failing.', citationIds: [REL] },
      { kind: 'finding', claim: 'topology', text: 'Node present.', citationIds: [NODE, REL] },
    ]), snapshot);
    const result = applyTopologyAiCitationAvailability(explanation, { allowed: [NODE], unavailable: [REL] }, snapshot);
    expect(result.findings).toEqual([{ kind: 'finding', claim: 'topology', text: 'Node present.', citationIds: [NODE] }]);
    expect(result.citationIds).toEqual([NODE]);
    expect(result.reasons).toContain('citation_unavailable');
    expect(result.status).toBe('partial');
  });
});
