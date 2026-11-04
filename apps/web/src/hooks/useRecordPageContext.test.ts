import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRecordPageContext } from './useRecordPageContext';

const setPageContext = vi.hoisted(() => vi.fn());
vi.mock('../stores/aiStore', () => ({ useAiStore: (select: (s: unknown) => unknown) => select({ setPageContext }) }));
const ctx = { kind: 'ticket' as const, id: 'ticket-1', orgId: 'org-1', label: 'T-1 Printer offline' };

describe('useRecordPageContext', () => {
  beforeEach(() => vi.clearAllMocks());
  it('sets and clears the record context', () => {
    const { unmount } = renderHook(() => useRecordPageContext(ctx));
    expect(setPageContext).toHaveBeenCalledWith({ type: 'record', ...ctx });
    unmount();
    expect(setPageContext).toHaveBeenLastCalledWith(null);
  });
  it('re-sets on id change but not object identity', () => {
    const { rerender } = renderHook((value) => useRecordPageContext(value), { initialProps: ctx });
    rerender({ ...ctx });
    expect(setPageContext).toHaveBeenCalledTimes(1);
    rerender({ ...ctx, id: 'ticket-2' });
    expect(setPageContext).toHaveBeenLastCalledWith({ type: 'record', ...ctx, id: 'ticket-2' });
  });
  it('does not set a null context', () => {
    const { unmount } = renderHook(() => useRecordPageContext(null));
    unmount();
    expect(setPageContext).not.toHaveBeenCalled();
  });
  it('truncates the label and omits an unknown org', () => {
    renderHook(() => useRecordPageContext({ ...ctx, orgId: null, label: 'x'.repeat(201) }));
    expect(setPageContext).toHaveBeenCalledWith({ type: 'record', ...ctx, orgId: undefined, label: 'x'.repeat(200) });
  });
  it('truncates a 201-code-point emoji label without splitting a surrogate pair', () => {
    const label = 'x' + '😀'.repeat(200);
    renderHook(() => useRecordPageContext({ ...ctx, label }));
    expect(setPageContext).toHaveBeenCalledWith({ type: 'record', ...ctx, label: 'x' + '😀'.repeat(199) });
  });
  it('updates kind, org and label and clears when the record unloads', () => {
    const { rerender } = renderHook<void, Parameters<typeof useRecordPageContext>[0]>((value) => useRecordPageContext(value), { initialProps: ctx });
    rerender({ ...ctx, kind: 'site', orgId: 'org-2', label: 'Office' });
    expect(setPageContext).toHaveBeenLastCalledWith({ type: 'record', id: ctx.id, kind: 'site', orgId: 'org-2', label: 'Office' });
    rerender(null);
    expect(setPageContext).toHaveBeenLastCalledWith(null);
  });
});
