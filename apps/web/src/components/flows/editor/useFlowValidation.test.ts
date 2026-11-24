import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ validateFlowDraftDocument: vi.fn() }));
vi.mock('../api', () => api);

import { ActionError } from '@/lib/runAction';
import { useFlowValidation, VALIDATION_DEBOUNCE_MS } from './useFlowValidation';

const ok = { valid: true, effectiveTier: 3, steps: [], issues: [] };

beforeEach(() => {
  vi.useFakeTimers();
  api.validateFlowDraftDocument.mockReset();
  api.validateFlowDraftDocument.mockResolvedValue(ok);
});
afterEach(() => vi.useRealTimers());

describe('useFlowValidation', () => {
  it('debounces at 400 ms and sends the document, owner and flowId', async () => {
    expect(VALIDATION_DEBOUNCE_MS).toBe(400);
    const doc = { name: 'a' };
    const { result } = renderHook(() => useFlowValidation(doc, { ownerScope: 'partner' }, 'f1'));
    expect(api.validateFlowDraftDocument).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(399); });
    expect(api.validateFlowDraftDocument).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.validateFlowDraftDocument).toHaveBeenCalledWith({ document: doc, ownerScope: 'partner', flowId: 'f1' });
    expect(result.current.validation).toEqual(ok);
    expect(result.current.error).toBeNull();
  });

  it('only the last of rapid changes is sent', async () => {
    const { rerender } = renderHook(({ d }) => useFlowValidation(d, {}, undefined), { initialProps: { d: { n: 1 } as unknown } });
    rerender({ d: { n: 2 } });
    rerender({ d: { n: 3 } });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(api.validateFlowDraftDocument).toHaveBeenCalledTimes(1);
    expect(api.validateFlowDraftDocument).toHaveBeenCalledWith({ document: { n: 3 } });
  });

  it('sends nothing for an unparsable document', async () => {
    renderHook(() => useFlowValidation(null, {}, undefined));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(api.validateFlowDraftDocument).not.toHaveBeenCalled();
  });

  it('an owner or not-found refusal is reported as an inline error', async () => {
    api.validateFlowDraftDocument.mockRejectedValue(
      new ActionError('Organization context required', 400, 'owner_invalid', { error: 'owner_invalid', message: 'Organization context required' }),
    );
    const { result } = renderHook(() => useFlowValidation({ n: 1 }, {}, undefined));
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(result.current.error).toBe('Organization context required');
    expect(result.current.validation).toBeNull();
  });
});
