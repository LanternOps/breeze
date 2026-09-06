import { describe, it, expect } from 'vitest';
import type { AgentCeilingDto, AgentToolCatalogDto } from '@breeze/shared';
import { entriesToSelection, selectionToEntries, capabilityState, outcomeFor, isWithinCeiling, summarise } from './capabilityModel';

const catalog: AgentToolCatalogDto = {
  capabilities: [{ id: 'services_startup', tone: 'standard' }, { id: 'scripts_commands', tone: 'standard' }],
  tools: [
    { name: 'manage_services', capability: 'services_startup', tier: 3, readOnly: false, operations: [
      { key: 'manage_services:list', action: 'list', tier: 2, readOnly: true, policyDecidable: false, actEligible: false },
      { key: 'manage_services:restart', action: 'restart', tier: 3, readOnly: false, policyDecidable: true, actEligible: true },
      { key: 'manage_services:stop', action: 'stop', tier: 3, readOnly: false, policyDecidable: true, actEligible: false },
    ] },
    { name: 'run_script', capability: 'scripts_commands', tier: 3, readOnly: false, operations: [
      { key: 'run_script', action: null, tier: 3, readOnly: false, policyDecidable: false, actEligible: true },
    ] },
    { name: 'query_devices', capability: 'scripts_commands', tier: 1, readOnly: true, operations: [
      { key: 'query_devices', action: null, tier: 1, readOnly: true, policyDecidable: false, actEligible: false },
    ] },
  ],
  presets: { triage: ['manage_services:restart'], patch: [], helpdesk: [] },
  // Task 7 (#5049): a registered-but-unreachable tool name (human-only/blocked/
  // secret-bearing/not-in-TOOL_TIERS) — never a `tools` entry, only ever seen
  // as a stale allowlist string.
  unreachableTools: ['manage_ai_agents'],
};

describe('capabilityModel', () => {
  it('expands a bare multi-operation entry into its mutating operations and flags it', () => {
    const r = entriesToSelection(['manage_services', 'run_script', 'restart_spooler'], catalog);
    expect([...r.selected].sort()).toEqual(['manage_services:restart', 'manage_services:stop', 'run_script']);
    expect(r.unrecognised).toEqual([
      { entry: 'manage_services', reason: 'bare_multi_op' },
      { entry: 'restart_spooler', reason: 'unknown_tool' },
    ]);
  });

  it('flags a bare entry for an all-read-only tool as read_only, not bare_multi_op or a silent no-op', () => {
    const r = entriesToSelection(['query_devices'], catalog);
    expect(r.selected.size).toBe(0);
    expect(r.unrecognised).toEqual([{ entry: 'query_devices', reason: 'read_only' }]);
  });

  it('flags a scoped key naming a read-only operation as read_only rather than silently selecting it', () => {
    const r = entriesToSelection(['manage_services:list'], catalog);
    expect(r.selected.size).toBe(0);
    expect(r.unrecognised).toEqual([{ entry: 'manage_services:list', reason: 'read_only' }]);
  });

  it('flags an entry naming a registered-but-unreachable tool as unreachable_tool, not unknown_tool', () => {
    const r = entriesToSelection(['manage_ai_agents'], catalog);
    expect(r.unrecognised).toEqual([{ entry: 'manage_ai_agents', reason: 'unreachable_tool' }]);
  });

  it('never compacts to a bare tool, even when every operation is selected', () => {
    const selected = new Set(['manage_services:restart', 'manage_services:stop', 'run_script']);
    expect(selectionToEntries(selected, catalog)).toEqual(['manage_services:restart', 'manage_services:stop', 'run_script']);
  });

  it('reports capability tri-state over mutating operations only', () => {
    expect(capabilityState('services_startup', new Set(['manage_services:restart']), catalog))
      .toEqual({ checked: 'some', selectedCount: 1, totalCount: 2 });
    expect(capabilityState('services_startup', new Set(['manage_services:restart', 'manage_services:stop']), catalog).checked).toBe('all');
    expect(capabilityState('services_startup', new Set(), catalog).checked).toBe('none');
  });

  it('caps the tri-state total at the ceiling, but still counts a stale out-of-ceiling selection as "some"', () => {
    const threeOpCatalog: AgentToolCatalogDto = {
      capabilities: [{ id: 'services_startup', tone: 'standard' }],
      tools: [{
        name: 'manage_services', capability: 'services_startup', tier: 3, readOnly: false, operations: [
          { key: 'manage_services:restart', action: 'restart', tier: 3, readOnly: false, policyDecidable: true, actEligible: true },
          { key: 'manage_services:stop', action: 'stop', tier: 3, readOnly: false, policyDecidable: true, actEligible: false },
          { key: 'manage_services:start', action: 'start', tier: 3, readOnly: false, policyDecidable: true, actEligible: false },
        ],
      }],
      presets: { triage: [], patch: [], helpdesk: [] },
      unreachableTools: [],
    };
    // Ceiling admits 2 of the 3 mutating operations.
    const ceiling: AgentCeilingDto = { toolAllowlist: ['manage_services:restart', 'manage_services:stop'], supervisedActionKeys: [] };

    expect(capabilityState('services_startup', new Set(['manage_services:restart', 'manage_services:stop']), threeOpCatalog, ceiling))
      .toEqual({ checked: 'all', selectedCount: 2, totalCount: 2 });

    // `start` is outside the ceiling but still selected (a stale grant from
    // before the baseline narrowed) — it must not read as a false "all" once
    // both in-ceiling ops are also checked, and must not read as "none" when
    // it's the only thing selected.
    expect(
      capabilityState(
        'services_startup',
        new Set(['manage_services:restart', 'manage_services:stop', 'manage_services:start']),
        threeOpCatalog,
        ceiling,
      ).checked,
    ).toBe('some');
    expect(capabilityState('services_startup', new Set(['manage_services:start']), threeOpCatalog, ceiling).checked).toBe('some');
    // No ceiling at all behaves exactly as before (every mutating op counts).
    expect(capabilityState('services_startup', new Set(['manage_services:restart']), threeOpCatalog, null))
      .toEqual({ checked: 'some', selectedCount: 1, totalCount: 3 });
  });

  it('maps tier and mode to an outcome', () => {
    const manageServices = catalog.tools[0];
    if (!manageServices) throw new Error('fixture missing manage_services tool');
    const restart = manageServices.operations[1];
    const list = manageServices.operations[0];
    if (!restart || !list) throw new Error('fixture missing operations');
    expect(outcomeFor(restart, 'shadow')).toBe('approval_request');
    expect(outcomeFor(restart, 'act')).toBe('unattended');
    expect(outcomeFor({ ...restart, actEligible: false }, 'act')).toBe('approval_request');
    expect(outcomeFor({ ...list, readOnly: false }, 'shadow')).toBe('logged_proposal');
  });

  it('treats a bare ceiling entry as a wildcard', () => {
    const ceiling = { toolAllowlist: ['manage_services'], supervisedActionKeys: [] };
    expect(isWithinCeiling('manage_services:stop', ceiling)).toBe(true);
    expect(isWithinCeiling('run_script', ceiling)).toBe(false);
    expect(isWithinCeiling('run_script', null)).toBe(true);
  });

  it('summarises counts for the footer sentence', () => {
    expect(summarise(new Set(['manage_services:restart', 'run_script']), catalog, 'shadow'))
      .toEqual({ operations: 2, capabilities: 2, approvalRequests: 2, loggedProposals: 0, unattended: [], readOnlyToolCount: 1 });
  });
});
