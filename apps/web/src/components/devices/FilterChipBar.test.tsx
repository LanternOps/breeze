import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { FilterConditionGroup } from '@breeze/shared';

import { FilterChipBar } from './FilterChipBar';
import { FilterValueEditor } from './FilterValueEditor';
import { V2_FILTER_FIELDS, getFieldDef } from './filterFields';
import { QuickAddChips } from './QuickAddChips';
import { FilterSentenceBuilder, isChipRenderable } from './FilterSentenceBuilder';

// Stub fetchWithAuth so FilterPreviewFooter doesn't try to hit the network
// during tests. Always returns 404 to flip preview into the silent skip state.
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async () => ({
    ok: false,
    status: 404,
    json: async () => ({})
  }))
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('FilterChipBar', () => {
  it('add chip flow: clicking Add filter + a field appends a chip to state', () => {
    const onChange = vi.fn();
    render(<FilterChipBar value={null} onChange={onChange} />);

    fireEvent.click(screen.getByTestId('filter-add-button'));
    fireEvent.click(screen.getByTestId('filter-add-field-osType'));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as FilterConditionGroup;
    expect(next.operator).toBe('AND');
    expect(next.conditions).toHaveLength(1);
    expect(next.conditions[0]).toMatchObject({ field: 'osType', operator: 'equals' });
  });

  it('remove chip flow: clicking the X removes that condition (and clears group when last)', () => {
    const value: FilterConditionGroup = {
      operator: 'AND',
      conditions: [{ field: 'status', operator: 'equals', value: 'online' }]
    };
    const onChange = vi.fn();
    render(<FilterChipBar value={value} onChange={onChange} />);

    fireEvent.click(screen.getByTestId('filter-chip-remove-status'));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toBeNull();
  });

  it('FilterValueEditor renders correct control per field type', () => {
    const numField = getFieldDef('metrics.cpuPercent')!;
    const onChange = vi.fn();
    const { unmount: u1 } = render(
      <FilterValueEditor
        field={numField}
        condition={{ field: 'metrics.cpuPercent', operator: 'greaterThan', value: 50 }}
        onChange={onChange}
      />
    );
    expect(screen.getByTestId('filter-number-input')).toBeDefined();
    u1();

    const enumField = getFieldDef('osType')!;
    const { unmount: u2 } = render(
      <FilterValueEditor
        field={enumField}
        condition={{ field: 'osType', operator: 'equals', value: 'windows' }}
        onChange={onChange}
      />
    );
    expect(screen.getByTestId('filter-enum-select')).toBeDefined();
    u2();

    render(
      <FilterValueEditor
        field={enumField}
        condition={{ field: 'osType', operator: 'in', value: ['windows'] }}
        onChange={onChange}
      />
    );
    expect(screen.getByTestId('filter-multi-enum')).toBeDefined();
  });

  it('catalog covers spec section 5.1 Tier 1 fields', () => {
    const required = [
      'hostname', 'displayName', 'status', 'osType', 'deviceRole', 'tags',
      'agentVersion', 'lastSeenAt', 'daysSinceEnrolled', 'software.installed',
      'software.notInstalled', 'metrics.cpuPercent', 'metrics.diskPercent',
      'orgId', 'siteId'
    ];
    const keys = new Set(V2_FILTER_FIELDS.map(f => f.key));
    for (const k of required) {
      expect(keys.has(k), `missing field ${k}`).toBe(true);
    }
  });

  // ---- Spec 4.1 — Org picker renders names ----
  it('org picker renders names not UUIDs', () => {
    const orgs = [
      { id: '11111111-1111-1111-1111-111111111111', name: 'PWC Arlington' },
      { id: '22222222-2222-2222-2222-222222222222', name: 'Thorne' }
    ];
    const onChange = vi.fn();
    render(
      <FilterValueEditor
        field={getFieldDef('orgId')!}
        condition={{ field: 'orgId', operator: 'in', value: [] }}
        onChange={onChange}
        orgs={orgs}
      />
    );
    expect(screen.getByTestId('filter-org-picker')).toBeDefined();
    // Each org option's label should be the name.
    expect(screen.getByTestId(`filter-org-picker-option-${orgs[0].id}`).textContent).toContain('PWC Arlington');
    expect(screen.getByTestId(`filter-org-picker-option-${orgs[1].id}`).textContent).toContain('Thorne');

    fireEvent.click(screen.getByTestId(`filter-org-picker-option-${orgs[0].id}`));
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls[0][0];
    expect(next.operator).toBe('in');
    expect(next.value).toEqual([orgs[0].id]);
  });

  // ---- Spec 4.2 — Software multi-select add + remove ----
  it('software multi-select adds and removes selected items', () => {
    const onChange = vi.fn();
    const options = ['Quickbooks Desktop', 'ESET Endpoint', 'Huntress Agent'];
    const { rerender } = render(
      <FilterValueEditor
        field={getFieldDef('software.installed')!}
        condition={{ field: 'software.installed', operator: 'hasAny', value: [] }}
        onChange={onChange}
        softwareOptions={options}
      />
    );
    expect(screen.getByTestId('filter-software-picker')).toBeDefined();
    expect(screen.getByTestId('filter-software-all')).toBeDefined();
    expect(screen.getByTestId('filter-software-any')).toBeDefined();

    fireEvent.click(screen.getByTestId('filter-software-option-Quickbooks Desktop'));
    expect(onChange).toHaveBeenCalled();
    const afterAdd = onChange.mock.calls[0][0];
    expect(afterAdd.value).toEqual(['Quickbooks Desktop']);

    // Re-render with the added state and remove it.
    rerender(
      <FilterValueEditor
        field={getFieldDef('software.installed')!}
        condition={{ field: 'software.installed', operator: 'hasAny', value: ['Quickbooks Desktop'] }}
        onChange={onChange}
        softwareOptions={options}
      />
    );
    fireEvent.click(screen.getByTestId('filter-software-remove-Quickbooks Desktop'));
    const afterRemove = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(afterRemove.value).toEqual([]);

    // All/Any combinator toggle flips operator.
    fireEvent.click(screen.getByTestId('filter-software-all'));
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall.operator).toBe('hasAll');
  });

  // ---- Spec 4.4 — Quick-add chip adds correct condition ----
  it('quick-add chip toggles the canonical condition (add, mark active, remove)', () => {
    const onChange = vi.fn();
    const { rerender } = render(<QuickAddChips value={null} onChange={onChange} />);

    fireEvent.click(screen.getByTestId('quick-add-offline'));
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls[0][0] as FilterConditionGroup;
    expect(next.conditions[0]).toMatchObject({ field: 'status', operator: 'equals', value: 'offline' });

    rerender(<QuickAddChips value={next} onChange={onChange} />);
    // Active (not disabled) — clicking again toggles it off.
    expect(screen.getByTestId('quick-add-offline').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('quick-add-offline'));
    const after = onChange.mock.calls[1][0] as FilterConditionGroup;
    expect(after.conditions.some(c => !('conditions' in c) && c.field === 'status')).toBe(false);
  });

  // ---- Spec 4.3 — Sentence builder toggle preserves state ----
  it('sentence builder toggle preserves state and isChipRenderable detects nested groups', () => {
    const flatGroup: FilterConditionGroup = {
      operator: 'AND',
      conditions: [{ field: 'osType', operator: 'equals', value: 'windows' }]
    };
    expect(isChipRenderable(flatGroup)).toBe(true);

    const nested: FilterConditionGroup = {
      operator: 'AND',
      conditions: [
        { field: 'osType', operator: 'equals', value: 'windows' },
        { operator: 'OR', conditions: [{ field: 'status', operator: 'equals', value: 'offline' }] }
      ]
    };
    expect(isChipRenderable(nested)).toBe(false);

    // Toggling chip → advanced → chip with a chip-renderable state should
    // keep state intact.
    const onChange = vi.fn();
    const { rerender } = render(<FilterChipBar value={flatGroup} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('filter-mode-advanced'));
    expect(screen.getByTestId('filter-sentence-builder')).toBeDefined();
    // Flip back; the FilterChipBar's `mode` is internal state; the value
    // never changed, so chip mode should still render the chip on toggle.
    fireEvent.click(screen.getByTestId('filter-mode-chip'));
    expect(screen.getByTestId('filter-chip-bar')).toBeDefined();
    expect(screen.getByTestId('filter-chip-osType')).toBeDefined();

    // When state is non-chip-renderable, chip-mode button is disabled.
    rerender(<FilterChipBar value={nested} onChange={onChange} />);
    const chipBtn = screen.getByTestId('filter-mode-chip') as HTMLButtonElement;
    expect(chipBtn.disabled).toBe(true);
    expect(screen.getByTestId('filter-sentence-builder')).toBeDefined();
  });

  it('sentence builder can add a new condition row', () => {
    const onChange = vi.fn();
    const empty: FilterConditionGroup = { operator: 'AND', conditions: [] };
    render(
      <FilterSentenceBuilder value={empty} onChange={onChange} />
    );
    fireEvent.click(screen.getByTestId('sentence-add-condition-0'));
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls[0][0] as FilterConditionGroup;
    expect(next.conditions).toHaveLength(1);
  });

  // ---- Spec 4.12 — keyboard ----
  it("'/' focuses the chip bar add button", () => {
    render(<FilterChipBar value={null} onChange={() => {}} />);
    const addBtn = screen.getByTestId('filter-add-button');
    expect(document.activeElement).not.toBe(addBtn);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '/' }));
    });
    expect(document.activeElement).toBe(addBtn);
  });

  it("'?' toggles the help popover and Esc closes it", () => {
    render(<FilterChipBar value={null} onChange={() => {}} />);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
    });
    expect(screen.getByTestId('filter-help-popover')).toBeDefined();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(screen.queryByTestId('filter-help-popover')).toBeNull();
  });

  it('Ctrl+S inside the chip bar invokes onSaveRequested', () => {
    const onSave = vi.fn();
    const value: FilterConditionGroup = {
      operator: 'AND',
      conditions: [{ field: 'osType', operator: 'equals', value: 'windows' }]
    };
    render(<FilterChipBar value={value} onChange={() => {}} onSaveRequested={onSave} />);
    // Focus a chip first so the bar contains activeElement.
    const chipBtn = screen.getByTestId('filter-chip-osType');
    chipBtn.focus();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }));
    });
    expect(onSave).toHaveBeenCalledWith(value);
  });
});
