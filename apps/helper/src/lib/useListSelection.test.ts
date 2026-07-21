// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { useListSelection } from './useListSelection';

function key(k: string, extra: Partial<{ metaKey: boolean; ctrlKey: boolean }> = {}) {
  return { key: k, preventDefault: vi.fn(), ...extra } as unknown as React.KeyboardEvent;
}

function setup(count = 3) {
  const onActivate = vi.fn();
  const onCopy = vi.fn();
  const { result } = renderHook(() => useListSelection(count, { onActivate, onCopy }));
  return { result, onActivate, onCopy };
}

it('ArrowDown from null selects the first row', () => {
  const { result } = setup();
  act(() => result.current.onKeyDown(key('ArrowDown')));
  expect(result.current.selected).toBe(0);
});

it('ArrowDown clamps at count - 1', () => {
  const { result } = setup(3);
  act(() => result.current.onKeyDown(key('ArrowDown')));
  act(() => result.current.onKeyDown(key('ArrowDown')));
  act(() => result.current.onKeyDown(key('ArrowDown')));
  act(() => result.current.onKeyDown(key('ArrowDown')));
  expect(result.current.selected).toBe(2);
});

it('Enter fires onActivate with the selected index', () => {
  const { result, onActivate } = setup();
  act(() => result.current.onKeyDown(key('ArrowDown')));
  act(() => result.current.onKeyDown(key('ArrowDown')));
  act(() => result.current.onKeyDown(key('Enter')));
  expect(onActivate).toHaveBeenCalledWith(1);
});

it('meta+c fires onCopy with the selected index', () => {
  const { result, onCopy } = setup();
  act(() => result.current.onKeyDown(key('ArrowDown')));
  act(() => result.current.onKeyDown(key('c', { metaKey: true })));
  expect(onCopy).toHaveBeenCalledWith(0);
});

it('Escape clears the selection first', () => {
  const { result } = setup();
  act(() => result.current.onKeyDown(key('ArrowDown')));
  expect(result.current.selected).toBe(0);
  act(() => result.current.onKeyDown(key('Escape')));
  expect(result.current.selected).toBeNull();
});
