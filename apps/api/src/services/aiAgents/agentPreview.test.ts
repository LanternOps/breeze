import { describe, it, expect } from 'vitest';
import type { AgentCeilingDto, AgentToolCatalogDto } from '@breeze/shared/types/aiAgents';
import type { PreviewAiAgentInput } from '@breeze/shared/validators/aiAgents';
import { previewAiAgentSchema } from '@breeze/shared/validators/aiAgents';
import { buildAgentPreview } from './agentPreview';

/**
 * Task 11 (#5051) fixture catalog — small and hand-built (unlike the real
 * ~185-tool registry `agentToolCatalog.contract.test.ts` pins), covering
 * exactly the shapes `buildAgentPreview` has to branch on: a multi-operation
 * tool with a read-only op plus two mutating ops (one act-eligible, one
 * not), a single-operation act-eligible tool (`run_script`, mirroring the
 * real catalog), a tier-2 tool for the logged_proposal case, and an
 * all-read-only tool to exercise `readOnlyToolCount`.
 */
const catalog: AgentToolCatalogDto = {
  capabilities: [
    { id: 'services_startup', tone: 'standard' },
    { id: 'scripts_commands', tone: 'standard' },
    { id: 'alerts_monitoring', tone: 'standard' },
    { id: 'automations_reports', tone: 'standard' },
  ],
  tools: [
    {
      name: 'manage_services',
      capability: 'services_startup',
      tier: 3,
      readOnly: false,
      operations: [
        {
          key: 'manage_services:list', action: 'list', tier: 1, readOnly: true,
          policyDecidable: false, actEligible: false,
        },
        {
          key: 'manage_services:restart', action: 'restart', tier: 3, readOnly: false,
          policyDecidable: true, actEligible: true,
        },
        {
          key: 'manage_services:stop', action: 'stop', tier: 3, readOnly: false,
          policyDecidable: true, actEligible: false,
        },
      ],
    },
    {
      name: 'run_script',
      capability: 'scripts_commands',
      tier: 3,
      readOnly: false,
      operations: [
        { key: 'run_script', action: null, tier: 3, readOnly: false, policyDecidable: false, actEligible: true },
      ],
    },
    {
      name: 'manage_alerts',
      capability: 'alerts_monitoring',
      tier: 2,
      readOnly: false,
      operations: [
        {
          key: 'manage_alerts:acknowledge', action: 'acknowledge', tier: 2, readOnly: false,
          policyDecidable: false, actEligible: false,
        },
      ],
    },
    {
      name: 'query_devices',
      capability: 'automations_reports',
      tier: 1,
      readOnly: true,
      operations: [
        { key: 'query_devices', action: null, tier: 1, readOnly: true, policyDecidable: false, actEligible: false },
      ],
    },
  ],
  presets: { triage: [], patch: [], helpdesk: [] },
  unreachableTools: [],
};

/** A structurally-valid preview input, defaulted through the real schema so
 *  every nested policy object matches what the route actually hands
 *  `buildAgentPreview` (never hand-typed, which would drift from the schema's
 *  defaulting rules — see `aiAgentPolicyFieldsSchema`'s docstring). */
function draft(overrides: Partial<{
  mode: PreviewAiAgentInput['mode'];
  kind: PreviewAiAgentInput['kind'];
  toolAllowlist: string[];
  supervisedActionKeys: string[];
  cooldownSeconds: number;
}> = {}): PreviewAiAgentInput {
  return previewAiAgentSchema.parse({
    kind: overrides.kind ?? 'triage',
    mode: overrides.mode ?? 'shadow',
    toolAllowlist: overrides.toolAllowlist ?? [],
    actAssets: { supervisedActionKeys: overrides.supervisedActionKeys ?? [] },
    ...(overrides.cooldownSeconds === undefined ? {} : { cooldownSeconds: overrides.cooldownSeconds }),
  });
}

function opKeys(preview: ReturnType<typeof buildAgentPreview>): string[] {
  return preview.operations.map((op) => op.key).sort();
}

describe('buildAgentPreview', () => {
  it('expands a bare entry on a multi-operation tool to its mutating operations only', () => {
    const preview = buildAgentPreview(draft({ toolAllowlist: ['manage_services'] }), null, catalog);
    expect(opKeys(preview)).toEqual(['manage_services:restart', 'manage_services:stop']);
  });

  it('keeps a bare entry on a single-operation tool as-is', () => {
    const preview = buildAgentPreview(draft({ toolAllowlist: ['run_script'] }), null, catalog);
    expect(opKeys(preview)).toEqual(['run_script']);
  });

  it('dedupes an operation reached by both a bare expansion and an explicit entry', () => {
    const preview = buildAgentPreview(
      draft({ toolAllowlist: ['manage_services', 'manage_services:restart'] }),
      null,
      catalog,
    );
    expect(opKeys(preview)).toEqual(['manage_services:restart', 'manage_services:stop']);
  });

  it('passes unknown/unreachable entries through to unrecognised, verbatim and deduped', () => {
    const preview = buildAgentPreview(
      draft({ toolAllowlist: ['not_a_real_tool', 'manage_services:not_a_real_action', 'not_a_real_tool'] }),
      null,
      catalog,
    );
    expect(preview.unrecognised).toEqual(['not_a_real_tool', 'manage_services:not_a_real_action']);
    expect(preview.operations).toEqual([]);
  });

  it('computes readOnlyToolCount from the catalog, independent of the selected allowlist', () => {
    const preview = buildAgentPreview(draft({ toolAllowlist: [] }), null, catalog);
    expect(preview.readOnlyToolCount).toBe(1); // only query_devices is fully read-only
  });

  it('narrows withinCeiling per-operation against the ceiling allowlist (bare-as-wildcard)', () => {
    const ceiling: AgentCeilingDto = { toolAllowlist: ['manage_services:restart'], supervisedActionKeys: [] };
    const preview = buildAgentPreview(draft({ toolAllowlist: ['manage_services'] }), ceiling, catalog);
    const byKey = Object.fromEntries(preview.operations.map((op) => [op.key, op]));
    expect(byKey['manage_services:restart']!.withinCeiling).toBe(true);
    expect(byKey['manage_services:stop']!.withinCeiling).toBe(false);
  });

  it('withinCeiling is true unconditionally when there is no ceiling (partner draft)', () => {
    const preview = buildAgentPreview(draft({ toolAllowlist: ['manage_services:stop'] }), null, catalog);
    expect(preview.operations[0]!.withinCeiling).toBe(true);
  });

  it('act mode: an act-eligible operation is unattended', () => {
    const preview = buildAgentPreview(draft({ mode: 'act', toolAllowlist: ['run_script'] }), null, catalog);
    expect(preview.operations).toEqual([expect.objectContaining({ key: 'run_script', outcome: 'unattended' })]);
  });

  it('act mode: a non-act-eligible tier-3 operation still falls back to approval_request', () => {
    const preview = buildAgentPreview(
      draft({ mode: 'act', toolAllowlist: ['manage_services:stop'] }),
      null,
      catalog,
    );
    expect(preview.operations[0]).toMatchObject({ key: 'manage_services:stop', outcome: 'approval_request' });
  });

  it('shadow mode splits by tier: tier 3 is approval_request, tier 2 is logged_proposal, never unattended', () => {
    const preview = buildAgentPreview(
      draft({ mode: 'shadow', toolAllowlist: ['manage_services:restart', 'manage_alerts:acknowledge'] }),
      null,
      catalog,
    );
    const byKey = Object.fromEntries(preview.operations.map((op) => [op.key, op.outcome]));
    expect(byKey['manage_services:restart']).toBe('approval_request');
    expect(byKey['manage_alerts:acknowledge']).toBe('logged_proposal');
  });

  it('preauthorized: intersects the ceiling ceiling and the draft supervisedActionKeys (bare-as-wildcard)', () => {
    const ceiling: AgentCeilingDto = { toolAllowlist: [], supervisedActionKeys: ['manage_services'] };
    const admitted = buildAgentPreview(
      draft({ toolAllowlist: ['manage_services:restart'], supervisedActionKeys: ['manage_services:restart'] }),
      ceiling,
      catalog,
    );
    expect(admitted.operations[0]!.preauthorized).toBe(true);

    const notInCeiling: AgentCeilingDto = { toolAllowlist: [], supervisedActionKeys: ['manage_services:stop'] };
    const refused = buildAgentPreview(
      draft({ toolAllowlist: ['manage_services:restart'], supervisedActionKeys: ['manage_services:restart'] }),
      notInCeiling,
      catalog,
    );
    expect(refused.operations[0]!.preauthorized).toBe(false);
  });

  it('preauthorized: with no ceiling (partner draft), membership is against the draft\'s own supervisedActionKeys', () => {
    const preview = buildAgentPreview(
      draft({ toolAllowlist: ['manage_services:restart'], supervisedActionKeys: ['manage_services'] }),
      null,
      catalog,
    );
    expect(preview.operations[0]!.preauthorized).toBe(true);

    const notAuthorized = buildAgentPreview(
      draft({ toolAllowlist: ['manage_services:restart'], supervisedActionKeys: [] }),
      null,
      catalog,
    );
    expect(notAuthorized.operations[0]!.preauthorized).toBe(false);
  });

  it('carries mode/kind and the reused triggers/protectedResources/limits/recipients through unchanged', () => {
    const input = draft({ mode: 'act', kind: 'patch' });
    const preview = buildAgentPreview(input, null, catalog);
    expect(preview.mode).toBe('act');
    expect(preview.kind).toBe('patch');
    expect(preview.triggers).toEqual({
      alertSeverities: input.triggers.alertSeverities,
      respectMaintenanceWindows: input.triggers.respectMaintenanceWindows,
      ticketAutonomousWrites: input.triggers.ticketAutonomousWrites,
    });
    expect(preview.protectedResources).toEqual(input.protectedResources);
    expect(preview.limits).toEqual(input.limits);
    expect(preview.recipients).toEqual(input.recipients);
  });

  it('carries cooldownSeconds through from the draft (a sibling of limits, not one of its fields)', () => {
    const preview = buildAgentPreview(draft({ cooldownSeconds: 1800 }), null, catalog);
    expect(preview.cooldownSeconds).toBe(1800);

    const defaulted = buildAgentPreview(draft(), null, catalog);
    expect(defaulted.cooldownSeconds).toBe(900);
  });

  it('capability is projected from the catalog tool the operation belongs to', () => {
    const preview = buildAgentPreview(draft({ toolAllowlist: ['manage_alerts:acknowledge'] }), null, catalog);
    expect(preview.operations[0]).toMatchObject({ key: 'manage_alerts:acknowledge', capability: 'alerts_monitoring' });
  });
});
