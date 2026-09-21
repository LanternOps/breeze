import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useDesignSelection } from './useDesignSelection';

describe('useDesignSelection', () => {
  it('selects and deselects a plain item ref', () => {
    const { result } = renderHook(() => useDesignSelection(new Set()));

    act(() => result.current.toggle('functions:workstation'));
    expect(result.current.isSelected('functions:workstation')).toBe(true);

    act(() => result.current.toggle('functions:workstation'));
    expect(result.current.isSelected('functions:workstation')).toBe(false);
  });

  it('auto-selects the owning function when a monitoring item is selected', () => {
    const { result } = renderHook(() => useDesignSelection(new Set()));

    act(() => result.current.toggle('monitoring:workstation:watch:0'));

    expect(result.current.isSelected('monitoring:workstation:watch:0')).toBe(true);
    expect(result.current.isSelected('functions:workstation')).toBe(true);
  });

  it('auto-selects the owning function for a rule ref too', () => {
    const { result } = renderHook(() => useDesignSelection(new Set()));

    act(() => result.current.toggle('monitoring:server:rule:2'));

    expect(result.current.isSelected('functions:server')).toBe(true);
  });

  it('deselecting a monitoring item does not deselect its already-selected function', () => {
    const { result } = renderHook(() => useDesignSelection(new Set()));

    act(() => result.current.toggle('monitoring:workstation:watch:0'));
    act(() => result.current.toggle('monitoring:workstation:watch:0'));

    expect(result.current.isSelected('monitoring:workstation:watch:0')).toBe(false);
    expect(result.current.isSelected('functions:workstation')).toBe(true);
  });

  it('treats a ref with an applied ledger row as not selectable', () => {
    const applied = new Set(['functions:workstation']);
    const { result } = renderHook(() => useDesignSelection(applied));

    expect(result.current.isApplied('functions:workstation')).toBe(true);

    act(() => result.current.toggle('functions:workstation'));
    expect(result.current.isSelected('functions:workstation')).toBe(false);
  });

  it('does not re-select an already-applied function via a monitoring auto-select', () => {
    const applied = new Set(['functions:workstation']);
    const { result } = renderHook(() => useDesignSelection(applied));

    act(() => result.current.toggle('monitoring:workstation:watch:0'));

    expect(result.current.isSelected('monitoring:workstation:watch:0')).toBe(true);
    // The function is already applied — the auto-select must not add it back
    // to the SELECTION set (it isn't a thing to re-apply).
    expect(result.current.isSelected('functions:workstation')).toBe(false);
  });

  it('builds the approval body from the current selection, stripping ref prefixes where the wire shape wants bare ids', () => {
    const { result } = renderHook(() => useDesignSelection(new Set()));

    act(() => {
      result.current.toggle('functions:workstation');
      result.current.toggle('monitoring:workstation:watch:0');
      result.current.toggle('retired:0');
      result.current.toggle('roleCorrections:device-1');
    });

    const approval = result.current.toApproval();
    expect(approval.functions).toEqual(['workstation']);
    expect(approval.monitoring).toEqual(['monitoring:workstation:watch:0']);
    expect(approval.retired).toEqual(['retired:0']);
    expect(approval.roleCorrections).toEqual(['device-1']);
    expect(approval.automation).toEqual([]);
    expect(approval.legacy).toEqual([]);
  });

  it('selects an automation script ref like any other selectable item', () => {
    const { result } = renderHook(() => useDesignSelection(new Set()));

    act(() => result.current.toggle('automation:workstation:script:0'));
    expect(result.current.isSelected('automation:workstation:script:0')).toBe(true);

    act(() => result.current.toggle('automation:workstation:script:0'));
    expect(result.current.isSelected('automation:workstation:script:0')).toBe(false);
  });

  it('does not auto-select the owning function when an automation script is selected', () => {
    const { result } = renderHook(() => useDesignSelection(new Set()));

    act(() => result.current.toggle('automation:workstation:script:0'));

    expect(result.current.isSelected('automation:workstation:script:0')).toBe(true);
    expect(result.current.isSelected('functions:workstation')).toBe(false);
  });

  it('carries selected automation refs (full ref strings) into the approval body', () => {
    const { result } = renderHook(() => useDesignSelection(new Set()));

    act(() => {
      result.current.toggle('automation:workstation:script:0');
      result.current.toggle('automation:workstation:script:1');
    });

    const approval = result.current.toApproval();
    expect(approval.automation).toEqual(['automation:workstation:script:0', 'automation:workstation:script:1']);
    expect(approval.functions).toEqual([]);
    expect(approval.legacy).toEqual([]);
  });

  it('clear empties the selection', () => {
    const { result } = renderHook(() => useDesignSelection(new Set()));

    act(() => result.current.toggle('functions:workstation'));
    act(() => result.current.clear());

    expect(result.current.selected.size).toBe(0);
  });
});
