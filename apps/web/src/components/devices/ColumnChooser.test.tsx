import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ColumnChooser, type ColumnChooserProps, type ColumnGateReason } from './ColumnChooser';
import { COLUMN_IDS, type ColumnId } from './columnVisibility';

function renderChooser(overrides: Partial<ColumnChooserProps> = {}) {
  const props: ColumnChooserProps = {
    columnOrder: [...COLUMN_IDS],
    visibleColumns: new Set<ColumnId>(['hostname', 'class', 'organization', 'status', 'cpu']),
    isColumnAvailable: () => true,
    gateReason: () => null,
    onToggle: vi.fn(),
    onMove: vi.fn(),
    onReset: vi.fn(),
    customFieldDefinitions: [],
    visibleCustomFieldKeys: new Set<string>(),
    onToggleCustomField: vi.fn(),
    ...overrides,
  };
  const utils = render(
    <div>
      <button type="button" data-testid="outside">outside</button>
      <ColumnChooser {...props} />
    </div>,
  );
  return { ...utils, props };
}

const trigger = () => screen.getByTestId('column-chooser-trigger');
const open = () => fireEvent.click(trigger());
const panel = () => screen.getByRole('dialog', { name: 'Columns' });

describe('ColumnChooser (#9034)', () => {
  it('is a dialog popover: trigger advertises it, panel is a labelled non-modal dialog', () => {
    renderChooser();
    expect(trigger()).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    open();
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(panel()).toHaveAttribute('aria-modal', 'false');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('moves focus to the search box on open', () => {
    renderChooser();
    open();
    expect(screen.getByTestId('column-chooser-search')).toHaveFocus();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    renderChooser();
    open();
    fireEvent.keyDown(screen.getByTestId('column-chooser-search'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it('closes on an outside click and returns focus to the trigger', async () => {
    renderChooser();
    open();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(trigger()).toHaveFocus());
  });

  it('does not steal focus from a focusable element clicked outside', async () => {
    renderChooser();
    open();
    const outside = screen.getByTestId('outside');
    fireEvent.mouseDown(outside);
    act(() => outside.focus());
    expect(screen.queryByRole('dialog')).toBeNull();
    await new Promise((r) => setTimeout(r, 10));
    expect(outside).toHaveFocus();
  });

  it('keeps Tab inside the panel', () => {
    renderChooser();
    open();
    const reset = screen.getByTestId('column-chooser-reset');
    act(() => reset.focus());
    fireEvent.keyDown(reset, { key: 'Tab' });
    expect(screen.getByTestId('column-chooser-search')).toHaveFocus();
    fireEvent.keyDown(screen.getByTestId('column-chooser-search'), { key: 'Tab', shiftKey: true });
    expect(reset).toHaveFocus();
  });

  it('filters column labels case-insensitively by substring', () => {
    renderChooser();
    open();
    fireEvent.change(screen.getByTestId('column-chooser-search'), { target: { value: 'VERSION' } });
    const labels = within(panel())
      .getAllByTestId(/^column-chooser-option-/)
      .map((el) => el.getAttribute('data-testid'));
    expect(labels).toEqual(
      expect.arrayContaining([
        'column-chooser-option-osVersion',
        'column-chooser-option-agentVersion',
        'column-chooser-option-watchdogVersion',
        'column-chooser-option-helperVersion',
      ]),
    );
    expect(labels).not.toContain('column-chooser-option-cpu');
    expect(labels).not.toContain('column-chooser-option-hostname');
  });

  it('says so when nothing matches', () => {
    renderChooser();
    open();
    fireEvent.change(screen.getByTestId('column-chooser-search'), { target: { value: 'zzz' } });
    expect(screen.getByTestId('column-chooser-no-matches')).toBeInTheDocument();
  });

  it('groups hidden columns under labelled sections with headers of at least 11px', () => {
    renderChooser();
    open();
    for (const group of ['identity', 'platform', 'health', 'versions', 'network', 'inventory']) {
      expect(screen.getByTestId(`column-chooser-group-${group}`)).toBeInTheDocument();
    }
    const versions = screen.getByTestId('column-chooser-group-versions');
    expect(within(versions).getByTestId('column-chooser-option-agentVersion')).toBeInTheDocument();
    expect(within(versions).queryByTestId('column-chooser-option-wanIp')).toBeNull();
    expect(panel().innerHTML).not.toContain('text-[10px]');
  });

  it('lists custom fields in their own section', () => {
    const onToggleCustomField = vi.fn();
    renderChooser({
      customFieldDefinitions: [{ id: 'cf1', fieldKey: 'asset_owner', name: 'Asset owner' }],
      onToggleCustomField,
    });
    open();
    const section = screen.getByTestId('column-chooser-group-custom');
    fireEvent.click(within(section).getByTestId('custom-column-toggle-asset_owner'));
    expect(onToggleCustomField).toHaveBeenCalledWith('asset_owner');
  });

  it('renders a class-gated column disabled and unchecked with the reason, never checked', () => {
    const gateReason = (id: ColumnId): ColumnGateReason | null => (id === 'class' ? 'agentOnlyFleet' : null);
    renderChooser({ gateReason });
    open();
    const option = screen.getByTestId('column-chooser-option-class');
    const box = within(option).getByRole('checkbox');
    expect(box).toBeDisabled();
    expect(box).not.toBeChecked();
    expect(option).toHaveTextContent('Hidden for agent-only fleets');
    // Not in the "visible, in order" list even though the preference is on.
    expect(within(screen.getByTestId('column-chooser-shown')).queryByTestId('column-chooser-option-class')).toBeNull();
  });

  it('locks the Device column: checked, disabled, "Always shown", no "Hide Device"', () => {
    const onToggle = vi.fn();
    renderChooser({ onToggle });
    open();
    const option = screen.getByTestId('column-chooser-option-hostname');
    const box = within(option).getByRole('checkbox');
    expect(box).toBeChecked();
    expect(box).toBeDisabled();
    expect(option).toHaveTextContent('Always shown');
    expect(screen.queryByLabelText('Hide Device')).toBeNull();
    fireEvent.click(box);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('toggles, reorders and resets through its callbacks', () => {
    const { props } = renderChooser();
    open();
    fireEvent.click(within(screen.getByTestId('column-chooser-option-cpu')).getByRole('checkbox'));
    expect(props.onToggle).toHaveBeenCalledWith('cpu');
    fireEvent.click(within(screen.getByTestId('column-chooser-option-status')).getByRole('button', { name: 'Move Status up' }));
    expect(props.onMove).toHaveBeenCalledWith('status', -1);
    fireEvent.click(within(screen.getByTestId('column-chooser-option-agentVersion')).getByRole('checkbox'));
    expect(props.onToggle).toHaveBeenCalledWith('agentVersion');
    fireEvent.click(screen.getByTestId('column-chooser-reset'));
    expect(props.onReset).toHaveBeenCalled();
  });

  it('omits columns that do not apply to the surface at all', () => {
    renderChooser({ isColumnAvailable: (id) => id !== 'organization' });
    open();
    expect(screen.queryByTestId('column-chooser-option-organization')).toBeNull();
  });
});
