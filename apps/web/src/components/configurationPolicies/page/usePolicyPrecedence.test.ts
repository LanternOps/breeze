import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
import { fetchWithAuth } from '../../../stores/auth';
import { usePolicyPrecedence } from './usePolicyPrecedence';

const fetchMock = vi.mocked(fetchWithAuth);
const respond = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(body) }) as unknown as Response;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const THREE = { capped: false, features: { patch: { reached: 40, outranked: 3 } } };
const NONE = { capped: false, features: {} };

describe('usePolicyPrecedence (#12472)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('reload drops the old answer at once, before the new read answers', async () => {
    const second = deferred<Response>();
    fetchMock.mockResolvedValueOnce(respond(200, THREE)).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => usePolicyPrecedence('pol-1'));
    await waitFor(() => expect(result.current.precedence).toEqual(THREE));

    act(() => result.current.reload());
    expect(result.current.precedence).toBeNull();

    await act(async () => second.resolve(respond(200, NONE)));
    expect(result.current.precedence).toEqual(NONE);
  });

  it('a slow older read never lands over a newer one', async () => {
    const first = deferred<Response>();
    fetchMock.mockReturnValueOnce(first.promise).mockResolvedValueOnce(respond(200, NONE));
    const { result } = renderHook(() => usePolicyPrecedence('pol-1'));

    act(() => result.current.reload());
    await waitFor(() => expect(result.current.precedence).toEqual(NONE));

    await act(async () => first.resolve(respond(200, THREE)));
    expect(result.current.precedence).toEqual(NONE);
  });

  it('a slow older read that fails does not wipe a newer answer', async () => {
    const first = deferred<Response>();
    fetchMock.mockReturnValueOnce(first.promise).mockResolvedValueOnce(respond(200, THREE));
    const { result } = renderHook(() => usePolicyPrecedence('pol-1'));

    act(() => result.current.reload());
    await waitFor(() => expect(result.current.precedence).toEqual(THREE));

    await act(async () => first.reject(new Error('network')));
    expect(result.current.precedence).toEqual(THREE);
  });

  it("another policy's answer is never shown: a switch starts from unknown", async () => {
    const forB = deferred<Response>();
    fetchMock.mockResolvedValueOnce(respond(200, THREE)).mockReturnValueOnce(forB.promise);
    const { result, rerender } = renderHook(({ id }) => usePolicyPrecedence(id), {
      initialProps: { id: 'pol-a' as string | undefined },
    });
    await waitFor(() => expect(result.current.precedence).toEqual(THREE));

    rerender({ id: 'pol-b' });
    expect(result.current.precedence).toBeNull();
    expect(fetchMock).toHaveBeenLastCalledWith('/configuration-policies/pol-b/precedence');
    await act(async () => forB.resolve(respond(200, NONE)));
    expect(result.current.precedence).toEqual(NONE);
  });

  it('a failed read is unknown (null)', async () => {
    fetchMock.mockResolvedValueOnce(respond(404, { error: 'Configuration policy not found' }));
    const { result } = renderHook(() => usePolicyPrecedence('pol-1'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(result.current.precedence).toBeNull();
  });
});
