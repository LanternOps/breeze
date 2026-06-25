import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBulkSelection } from './useBulkSelection';

describe('useBulkSelection', () => {
  it('toggles ids on and off', () => {
    const { result } = renderHook(() => useBulkSelection());
    act(() => result.current.toggle('a'));
    expect(result.current.has('a')).toBe(true);
    expect(result.current.size).toBe(1);
    act(() => result.current.toggle('a'));
    expect(result.current.has('a')).toBe(false);
    expect(result.current.size).toBe(0);
  });

  it('selectAll adds all ids and clear empties', () => {
    const { result } = renderHook(() => useBulkSelection());
    act(() => result.current.selectAll(['a', 'b', 'c']));
    expect(result.current.size).toBe(3);
    act(() => result.current.clear());
    expect(result.current.size).toBe(0);
  });
});
