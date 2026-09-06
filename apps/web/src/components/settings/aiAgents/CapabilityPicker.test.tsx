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
        { key: 'manage_services:list', action: 'list', tier: 2, readOnly: true, policyDecidable: false, actEligible: false },
        { key: 'manage_services:restart', action: 'restart', tier: 3, readOnly: false, policyDecidable: true, actEligible: true },
        { key: 'manage_services:stop', action: 'stop', tier: 3, readOnly: false, policyDecidable: true, actEligible: false },
      ],
    },
    {
      name: 'run_script',
      capability: 'scripts_commands',
      tier: 3,
      readOnly: false,
      operations: [{ key: 'run_script', action: null, tier: 3, readOnly: false, policyDecidable: false, actEligible: true }],
    },
    {
      name: 'query_devices',
      capability: 'scripts_commands',
      tier: 1,
      readOnly: true,
      operations: [{ key: 'query_devices', action: null, tier: 1, readOnly: true, policyDecidable: false, actEligible: false }],
    },
  ],
  presets: { triage: ['manage_services:restart'], patch: [], helpdesk: [] },
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
    renderPicker({ ceiling: { toolAllowlist: ['manage_services:restart'], supervisedActionKeys: [] } });

    const stopCheckbox = screen.getByTestId('operation-checkbox-manage_services:stop') as HTMLInputElement;
    expect(stopCheckbox.disabled).toBe(true);

    const row = screen.getByTestId('operation-row-manage_services:stop');
    expect(row).toHaveTextContent('Not in partner baseline');

    const restartCheckbox = screen.getByTestId('operation-checkbox-manage_services:restart') as HTMLInputElement;
    expect(restartCheckbox.disabled).toBe(false);
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
    expect(summary).toHaveTextContent('1 capabilities');
    expect(summary).toHaveTextContent('2 approval requests');
  });

  it('hides the literal operation key until Show tool names is toggled on', () => {
    renderPicker({ entries: ['manage_services:restart'] });

    expect(screen.queryByText('manage_services:restart')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('capability-picker-show-names'));

    expect(screen.getByText('manage_services:restart')).toBeInTheDocument();
  });
});
