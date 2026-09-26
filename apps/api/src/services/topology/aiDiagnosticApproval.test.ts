/**
 * Topology M4 Task 4 / M4-D3 (#6000): the deterministic effect of an AI-proposed
 * diagnostic, and the release-only handler's refusals before any read. The
 * real-database acceptance, fresh-MFA, site-move and replay behaviour lives in
 * __tests__/integration/topologyAiApproval.integration.test.ts. No model call.
 */
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { TopologyDiagnosticPlan } from '@breeze/shared';

vi.mock('../../db', () => ({ db: {}, runOutsideDbContext: vi.fn(), withDbAccessContext: vi.fn() }));

import type { AuthContext } from '../../middleware/auth';
import type { DiagnosticPlanningSnapshot } from './diagnosticTypes';
import {
  extractTopologyDiagnosticEffect,
  topologyDiagnosticEffectMaterial,
  topologyDiagnosticProposalSchema,
  type TopologyDiagnosticProposal,
} from './aiDiagnosticEffect';
import { runApprovedTopologyDiagnostic } from './aiDiagnosticApproval';
import { isFreshApproverFactor, requiresFreshApproverFactor } from '../actionIntents/freshApproverFactor';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const OTHER_DEVICE = '44444444-4444-4444-8444-444444444444';
const NODE = '55555555-5555-4555-8555-555555555555';
const BINDING = '66666666-6666-4666-8666-666666666666';
const IFACE = '77777777-7777-4777-8777-777777777777';
const SOURCE = '88888888-8888-4888-8888-888888888888';
const EVIDENCE = '99999999-9999-4999-8999-999999999999';
const scope = { orgId: ORG, siteId: SITE };

function candidate(deviceId: string, overrides: { gateway?: string; eligible?: boolean; sequence?: string; evidenceId?: string; bindingId?: string } = {}) {
  return {
    eligibility: {
      origin: {
        deviceId, agentId: deviceId, nodeId: NODE, bindingId: overrides.bindingId ?? BINDING, siteId: SITE, contextKey: 'default',
        interfaceId: IFACE, interfaceEpoch: 'epoch-1', interfaceKey: 'eth0', sourceId: SOURCE, producerEpoch: 'epoch-1',
        sequence: overrides.sequence ?? '5',
      },
      eligible: overrides.eligible ?? true, reasons: [], families: ['ipv4'], rank: 1,
    },
    routes: [], resolvers: [],
    gatewayEvidence: [{ address: overrides.gateway ?? '192.0.2.1', zone: null, interfaceId: IFACE, evidenceId: overrides.evidenceId ?? EVIDENCE }],
    resolverEvidence: {},
    capabilities: new Set(['network_diagnostic', 'route_lookup', 'interface_bound_probes']),
  };
}

function snapshot(overrides: {
  graphRevision?: string; settingsRevision?: string; templateRevisions?: Record<string, string>;
  candidates?: ReturnType<typeof candidate>[];
} = {}): DiagnosticPlanningSnapshot {
  return {
    graphRevision: overrides.graphRevision ?? '4',
    settings: {
      binding: { orgId: ORG, siteId: SITE },
      layers: { partner: null, organization: null, defaultsVersion: 1, resolverVersion: 1 },
      resolved: { settings: { outboundEnabled: true } },
      settingsRevision: overrides.settingsRevision ?? '3',
      templateRevisions: overrides.templateRevisions ?? {},
    },
    targets: [],
    candidates: overrides.candidates ?? [candidate(DEVICE)],
  } as unknown as DiagnosticPlanningSnapshot;
}

function proposal(overrides: Partial<TopologyDiagnosticProposal> = {}): TopologyDiagnosticProposal {
  return topologyDiagnosticProposalSchema.parse({
    site_id: SITE, subject: { kind: 'node', id: NODE }, recipe_id: 'gateway_basic', recipe_version: 1, graph_revision: '4',
    origin_device_id: DEVICE, context_key: 'default', family: 'ipv4', proposal_expires_at: '2026-09-26T12:15:00.000Z',
    ...overrides,
  });
}

const digest = (material: string) => createHash('sha256').update(material).digest('hex');
const extract = (p = proposal(), s = snapshot(), now = new Date('2026-09-26T12:00:00Z')) =>
  extractTopologyDiagnosticEffect(scope, p, s, { now, newId: randomUUID });

describe('diagnose_connectivity effect material (M4-D3)', () => {
  it('is reproducible across clocks and random step/destination ids — the planner output itself is not', () => {
    const first = extract(proposal(), snapshot(), new Date('2026-09-26T12:00:00Z'));
    const second = extract(proposal(), snapshot(), new Date('2026-09-26T12:07:31Z'));
    expect(first.plan.digest).not.toBe(second.plan.digest);
    expect(first.plan.steps[0]!.id).not.toBe(second.plan.steps[0]!.id);
    expect(digest(first.material)).toBe(digest(second.material));
  });

  it('pins the origin identity, the destination, settings/template versions and the proposal expiry', () => {
    const base = digest(extract().material);
    const changed = [
      extract(proposal(), snapshot({ candidates: [candidate(DEVICE, { gateway: '192.0.2.99' })] })),
      extract(proposal(), snapshot({ candidates: [candidate(DEVICE, { bindingId: randomUUID() })] })),
      extract(proposal(), snapshot({ settingsRevision: '4' })),
      extract(proposal(), snapshot({ templateRevisions: { [randomUUID()]: '1:2:active' } })),
      extract(proposal({ proposal_expires_at: '2026-09-26T12:16:00.000Z' })),
    ];
    for (const effect of changed) expect(digest(effect.material)).not.toBe(base);
  });

  it('does not pin label/layout graph revisions, collection sequences or evidence ids', () => {
    const base = digest(extract().material);
    expect(digest(extract(proposal(), snapshot({ graphRevision: '99' })).material)).toBe(base);
    expect(digest(extract(proposal(), snapshot({ candidates: [candidate(DEVICE, { sequence: '42', evidenceId: randomUUID() })] })).material)).toBe(base);
  });

  it('never re-selects an origin: a pinned origin that stopped being eligible refuses even with another eligible candidate', () => {
    const moved = snapshot({ candidates: [candidate(OTHER_DEVICE), candidate(DEVICE, { eligible: false })] });
    expect(() => extract(proposal(), moved)).toThrow(expect.objectContaining({ code: 'no_eligible_collector' }));
  });

  it('refuses a plan with a compiler refusal reason and a proposal for another site', () => {
    const noGateway = { ...candidate(DEVICE), gatewayEvidence: [] };
    expect(() => extract(proposal(), snapshot({ candidates: [noGateway] }))).toThrow(expect.objectContaining({ code: 'diagnostic_not_plannable' }));
    expect(() => extract(proposal({ site_id: randomUUID() }))).toThrow(expect.objectContaining({ code: 'topology_site_mismatch' }));
  });

  it('projects ids to ordinals, never raw ids, in the material', () => {
    const { plan, material } = extract();
    for (const id of [...plan.steps.map((step) => step.id), ...plan.destinations.map((d) => d.id), EVIDENCE]) {
      expect(material).not.toContain(id);
    }
    expect(topologyDiagnosticEffectMaterial(proposal(), plan as TopologyDiagnosticPlan, {})).toBe(material);
  });
});

describe('diagnose_connectivity release handler', () => {
  const auth = { user: { id: randomUUID() }, principal: { kind: 'user_session' } } as unknown as AuthContext;

  it('refuses without an approved release context — model input or auth alone never start a run', async () => {
    const input = { site_id: SITE, subject: { kind: 'node', id: NODE }, recipe_id: 'gateway_basic', recipe_version: 1, graph_revision: '4' };
    for (const context of [undefined, {}, { actionIntentId: randomUUID() }]) {
      expect(JSON.parse(await runApprovedTopologyDiagnostic(input, auth, context))).toMatchObject({ code: 'approval_required' });
    }
    const verified = { scope, proposal: proposal(), effectDigest: 'a'.repeat(64), expiresAt: proposal().proposal_expires_at };
    expect(JSON.parse(await runApprovedTopologyDiagnostic(input, auth, { verifiedTopologyDiagnostic: verified }))).toMatchObject({ code: 'approval_required' });
    // A verified effect for site A cannot be spent on a call naming site B.
    expect(JSON.parse(await runApprovedTopologyDiagnostic({ ...input, site_id: randomUUID() }, auth,
      { actionIntentId: randomUUID(), verifiedTopologyDiagnostic: verified }))).toMatchObject({ code: 'topology_site_mismatch' });
  });
});

describe('fresh approver factor (M4-D3)', () => {
  it('applies to diagnose_connectivity only', () => {
    expect(requiresFreshApproverFactor('diagnose_connectivity')).toBe(true);
    expect(requiresFreshApproverFactor('run_script')).toBe(false);
  });

  it('accepts only a hardware-backed >= L3 assertion made for this decision', () => {
    expect(isFreshApproverFactor({ decidedVia: 'webauthn_platform', decidedAssuranceLevel: 3, stepUpGrantReuse: false })).toBe(true);
    expect(isFreshApproverFactor({ decidedVia: 'mobile_hw_key', decidedAssuranceLevel: 4, stepUpGrantReuse: false })).toBe(true);
    expect(isFreshApproverFactor({ decidedVia: 'session_tap', decidedAssuranceLevel: 1, stepUpGrantReuse: false })).toBe(false);
    expect(isFreshApproverFactor({ decidedVia: 'webauthn_platform', decidedAssuranceLevel: 2, stepUpGrantReuse: false })).toBe(false);
    expect(isFreshApproverFactor({ decidedVia: 'webauthn_platform', decidedAssuranceLevel: 3, stepUpGrantReuse: true })).toBe(false);
    expect(isFreshApproverFactor({ decidedVia: null, decidedAssuranceLevel: null, stepUpGrantReuse: null })).toBe(false);
  });
});
