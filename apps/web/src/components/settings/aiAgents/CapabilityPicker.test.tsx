import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentCeilingDto, AgentToolCatalogDto } from '@breeze/shared';
import CapabilityPicker from './CapabilityPicker';

// Same fixture as capabilityModel.test.ts (Task 7) — kept identical so both
// suites exercise the same catalog shape.
const catalog: AgentToolCatalogDto = {
  capabilities: [
    { id: 'services_startup', tone: 'standard' },
    { id: 'scripts_commands', tone: 'standard' },
  ],
  tools: [
    {
      name: 'manage_services',
      capability: 'services_startup',
      tier: 3,
      readOnly: false,
      operations: [
        { key: 'manage_services:list', action: 'list', tier: 2, readOnly: true, policyDecidable: false, actEligible: false, actRequiresAuthorizedScripts: false },
        { key: 'manage_services:restart', action: 'restart', tier: 3, readOnly: false, policyDecidable: true, actEligible: true, actRequiresAuthorizedScripts: false },
        { key: 'manage_services:stop', action: 'stop', tier: 3, readOnly: false, policyDecidable: true, actEligible: false, actRequiresAuthorizedScripts: false },
      ],
    },
    {
      name: 'run_script',
      capability: 'scripts_commands',
      tier: 3,
      readOnly: false,
      operations: [{ key: 'run_script', action: null, tier: 3, readOnly: false, policyDecidable: false, actEligible: true, actRequiresAuthorizedScripts: true }],
    },
    {
      name: 'query_devices',
      capability: 'scripts_commands',
      tier: 1,
      readOnly: true,
      operations: [{ key: 'query_devices', action: null, tier: 1, readOnly: true, policyDecidable: false, actEligible: false, actRequiresAuthorizedScripts: false }],
    },
  ],
  presets: { triage: ['manage_services:restart'], patch: ['run_script'], helpdesk: [] },
  unreachableTools: ['manage_ai_agents'],
};

function renderPicker(overrides: {
  entries?: string[];
  ceiling?: AgentCeilingDto | null;
  onChange?: (entries: string[]) => void;
  showToolNames?: boolean;
} = {}) {
  const onChange = overrides.onChange ?? vi.fn();
  const utils = render(
    <CapabilityPicker
      catalog={catalog}
      ceiling={overrides.ceiling ?? null}
      kind="triage"
      mode="shadow"
      entries={overrides.entries ?? []}
      onChange={onChange}
      showToolNames={overrides.showToolNames}
    />,
  );
  return { ...utils, onChange };
}

describe('CapabilityPicker', () => {
  it('persists a scoped entry when a single operation checkbox is checked', () => {
    const { onChange } = renderPicker();

    fireEvent.click(screen.getByTestId('operation-checkbox-manage_services:restart'));

    expect(onChange).toHaveBeenCalledWith(['manage_services:restart']);
  });

  it('tri-state capability checkbox selects all mutating operations, then clears on a second click', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <CapabilityPicker catalog={catalog} ceiling={null} kind="triage" mode="shadow" entries={[]} onChange={onChange} />,
    );

    fireEvent.click(screen.getByTestId('capability-checkbox-services_startup'));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.arrayContaining(['manage_services:restart', 'manage_services:stop']),
    );
    const firstEntries = onChange.mock.calls[0][0] as string[];
    expect(firstEntries).toHaveLength(2);

    rerender(
      <CapabilityPicker catalog={catalog} ceiling={null} kind="triage" mode="shadow" entries={firstEntries} onChange={onChange} />,
    );

    fireEvent.click(screen.getByTestId('capability-checkbox-services_startup'));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('disables an operation outside the ceiling and shows the not-in-ceiling badge', () => {
    renderPicker({ ceiling: { toolAllowlist: ['manage_services:restart'], supervisedActionKeys: [], scriptIds: [] } });

    const stopCheckbox = screen.getByTestId('operation-checkbox-manage_services:stop') as HTMLInputElement;
    expect(stopCheckbox.disabled).toBe(true);

    const row = screen.getByTestId('operation-row-manage_services:stop');
    expect(row).toHaveTextContent('Not in partner baseline');

    const restartCheckbox = screen.getByTestId('operation-checkbox-manage_services:restart') as HTMLInputElement;
    expect(restartCheckbox.disabled).toBe(false);
  });

  it('keeps a checked operation outside the ceiling enabled, so a stale grant can still be unchecked', () => {
    const { onChange } = renderPicker({
      entries: ['manage_services:stop'],
      ceiling: { toolAllowlist: ['manage_services:restart'], supervisedActionKeys: [], scriptIds: [] },
    });

    const stopCheckbox = screen.getByTestId('operation-checkbox-manage_services:stop') as HTMLInputElement;
    expect(stopCheckbox.checked).toBe(true);
    expect(stopCheckbox.disabled).toBe(false);
    expect(screen.getByTestId('operation-row-manage_services:stop')).toHaveTextContent('Not in partner baseline');

    fireEvent.click(stopCheckbox);

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('lists an unrecognised entry with a reason and removes it on click', () => {
    const { onChange } = renderPicker({ entries: ['restart_spooler'] });

    const unrecognised = screen.getByTestId('capability-picker-unrecognised');
    expect(unrecognised).toHaveTextContent('restart_spooler');

    fireEvent.click(screen.getByTestId('capability-picker-unrecognised-remove-restart_spooler'));

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('summarises selected operations in the footer sentence', () => {
    renderPicker({ entries: ['manage_services:restart', 'manage_services:stop'] });

    const summary = screen.getByTestId('capability-picker-summary');
    expect(summary).toHaveTextContent('2 operations');
    expect(summary).toHaveTextContent('1 capability');
    expect(summary).toHaveTextContent('2 approval requests');
  });

  it('pluralises the operations and capability nouns independently — singular case', () => {
    renderPicker({ entries: ['run_script'] });

    const summary = screen.getByTestId('capability-picker-summary');
    expect(summary).toHaveTextContent('1 operation across 1 capability');
    expect(summary).not.toHaveTextContent('1 operations');
    expect(summary).not.toHaveTextContent('1 capabilities');
    // The breakdown inside the parentheses pluralises too (#5048 QA), and is
    // joined with the locale's list conjunction, like the review card's copy.
    expect(summary).toHaveTextContent('(1 approval request and 0 logged proposals)');
    expect(summary).not.toHaveTextContent('1 approval requests');
  });

  it('search narrows to the matching operations, not the whole capability (#5048 QA)', () => {
    renderPicker();

    fireEvent.change(screen.getByTestId('capability-picker-search'), { target: { value: 'restart' } });

    expect(screen.getByTestId('operation-row-manage_services:restart')).toBeInTheDocument();
    expect(screen.queryByTestId('operation-row-manage_services:stop')).not.toBeInTheDocument();
    expect(screen.queryByTestId('capability-row-scripts_commands')).not.toBeInTheDocument();
  });

  it('while a search narrows a capability, its header checkbox and count act on the visible operations only (#5064 review)', () => {
    const { onChange } = renderPicker();
    fireEvent.change(screen.getByTestId('capability-picker-search'), { target: { value: 'restart' } });

    expect(screen.getByTestId('capability-row-services_startup')).toHaveTextContent('0 of 1 operation');
    fireEvent.click(screen.getByTestId('capability-checkbox-services_startup'));

    expect(onChange).toHaveBeenLastCalledWith(['manage_services:restart']);
  });

  it('search on the capability label keeps every operation in that capability visible', () => {
    renderPicker();

    fireEvent.change(screen.getByTestId('capability-picker-search'), { target: { value: 'Services and startup' } });

    expect(screen.getByTestId('operation-row-manage_services:restart')).toBeInTheDocument();
    expect(screen.getByTestId('operation-row-manage_services:stop')).toBeInTheDocument();
  });

  it('act mode: a script-gated run_script reads as an approval request with the script-gate note until a script is authorized (#5048 QA)', () => {
    const { rerender } = render(
      <CapabilityPicker catalog={catalog} ceiling={null} kind="patch" mode="act" entries={['run_script']} onChange={vi.fn()} />,
    );
    const row = screen.getByTestId('operation-row-run_script');
    expect(row).toHaveTextContent('Approval request');
    expect(row).not.toHaveTextContent('Executes unattended');
    expect(screen.getByTestId('operation-note-run_script')).toBeInTheDocument();
    expect(screen.getByTestId('capability-picker-summary')).toHaveTextContent('1 approval request');

    rerender(
      <CapabilityPicker catalog={catalog} ceiling={null} kind="patch" mode="act" entries={['run_script']} onChange={vi.fn()} authorizedScriptCount={1} />,
    );
    expect(screen.getByTestId('operation-row-run_script')).toHaveTextContent('Executes unattended');
    expect(screen.queryByTestId('operation-note-run_script')).not.toBeInTheDocument();
    expect(screen.getByTestId('capability-picker-summary')).toHaveTextContent('1 unattended');
  });

  it('pluralises the always-on read-only tools count', () => {
    renderPicker();

    const alwaysOn = screen.getByTestId('capability-picker-always-on');
    expect(alwaysOn).toHaveTextContent('1 read-only tool');
    expect(alwaysOn).not.toHaveTextContent('1 read-only tools');
  });

  it('pluralises the per-capability "x of y operations" text on a single-operation capability', () => {
    renderPicker();

    const row = screen.getByTestId('capability-row-scripts_commands');
    expect(row).toHaveTextContent('0 of 1 operation');
    expect(row).not.toHaveTextContent('0 of 1 operations');
  });

  it('hides the literal operation key until Show tool names is toggled on', () => {
    renderPicker({ entries: ['manage_services:restart'] });

    expect(screen.queryByText('manage_services:restart')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('capability-picker-show-names'));

    expect(screen.getByText('manage_services:restart')).toBeInTheDocument();
  });

  it('resyncs which capability is pre-expanded when kind changes after mount', () => {
    const { rerender } = render(
      <CapabilityPicker catalog={catalog} ceiling={null} kind="triage" mode="shadow" entries={[]} onChange={vi.fn()} />,
    );

    // triage's preset only touches services_startup — scripts_commands starts collapsed.
    expect(screen.queryByTestId('operation-row-run_script')).not.toBeInTheDocument();

    rerender(
      <CapabilityPicker catalog={catalog} ceiling={null} kind="patch" mode="shadow" entries={[]} onChange={vi.fn()} />,
    );

    // patch's preset touches scripts_commands (run_script) — it must now be pre-expanded, not just moved into view.
    expect(screen.getByTestId('operation-row-run_script')).toBeInTheDocument();
  });

  it('shows "Applied" once every in-ceiling preset key is selected, even when the ceiling excludes another preset key', () => {
    // The triage preset is just `manage_services:restart`, so extend it here
    // via a ceiling-scoped catalog with a two-key preset to exercise the
    // partial-ceiling case.
    const twoKeyPresetCatalog: AgentToolCatalogDto = {
      ...catalog,
      presets: { triage: ['manage_services:restart', 'manage_services:stop'], patch: [], helpdesk: [] },
    };
    const ceiling: AgentCeilingDto = { toolAllowlist: ['manage_services:restart'], supervisedActionKeys: [], scriptIds: [] };

    render(
      <CapabilityPicker
        catalog={twoKeyPresetCatalog}
        ceiling={ceiling}
        kind="triage"
        mode="shadow"
        entries={['manage_services:restart']}
        onChange={vi.fn()}
      />,
    );

    const applyButton = screen.getByTestId('capability-picker-recommended-apply') as HTMLButtonElement;
    expect(applyButton.disabled).toBe(true);
    expect(applyButton).toHaveTextContent('Applied');
  });

  it('flags a read-only entry as Unrecognised with its own reason, preserves it across an unrelated change, and only drops it via Remove', () => {
    const { onChange } = renderPicker({ entries: ['query_devices'] });

    const unrecognised = screen.getByTestId('capability-picker-unrecognised');
    expect(unrecognised).toHaveTextContent('query_devices');
    expect(unrecognised).toHaveTextContent('Read-only: always available to the agent, so this entry has no effect.');

    fireEvent.click(screen.getByTestId('operation-checkbox-manage_services:restart'));
    expect(onChange).toHaveBeenLastCalledWith(['manage_services:restart', 'query_devices']);

    fireEvent.click(screen.getByTestId('capability-picker-unrecognised-remove-query_devices'));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});
