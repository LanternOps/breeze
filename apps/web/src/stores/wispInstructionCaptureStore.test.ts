import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapturedInstructionDto } from '@breeze/shared';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/stores/auth', () => ({ fetchWithAuth: fetchMock }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));

import { useWispInstructionCaptureStore } from './wispInstructionCaptureStore';
import { runLogoutHooks } from './logoutHooks';

const dto = (over: Partial<CapturedInstructionDto> = {}): CapturedInstructionDto => ({
  instructionId: 'i-1', captureId: 'c-1', capturedAt: '2026-11-08T10:00:00.000Z', text: "don't reboot PC-01",
  status: 'unconfirmed', enforceable: true, verb: 'reboot', targetLabels: ['PC-01'], until: null,
  orgId: 'o-1', orgName: 'Acme', unmatched: false, keptForOrg: false, ...over,
});
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const store = () => useWispInstructionCaptureStore.getState();

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  store().reset();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('trackCapture', () => {
  it('polls at 2s, +4s, +8s and stops at the first terminal status, merging the instructions', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ status: 'pending', instructions: [] }))
      .mockResolvedValueOnce(json({ status: 'pending', instructions: [] }))
      .mockResolvedValueOnce(json({ status: 'saved', instructions: [dto()] }));
    store().trackCapture('s1', 'c-1');
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/wisp/memory/captures/status/c-1');
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(8000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(store().bySession.s1).toEqual([dto()]);
  });

  it('stops after the sixth request when still pending', async () => {
    fetchMock.mockResolvedValue(json({ status: 'pending', instructions: [] }));
    store().trackCapture('s1', 'c-1');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('stops silently on a 404 (unknown or not yours)', async () => {
    fetchMock.mockResolvedValue(json({ error: 'nope' }, 404));
    store().trackCapture('s1', 'c-1');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries through a 502 and a network error, then shows the saved instruction', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: 'bad gateway' }, 502))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(json({ status: 'saved', instructions: [dto()] }));
    store().trackCapture('s1', 'c-1');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(store().bySession.s1).toEqual([dto()]);
  });

  it('a persistent 5xx still stops after the sixth request', async () => {
    fetchMock.mockResolvedValue(json({ error: 'down' }, 503));
    store().trackCapture('s1', 'c-1');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('never polls the same captureId twice concurrently', async () => {
    fetchMock.mockResolvedValue(json({ status: 'none', instructions: [] }));
    store().trackCapture('s1', 'c-1');
    store().trackCapture('s1', 'c-1');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('loadSessionCaptures', () => {
  it('fetches once per session id, even while in flight', async () => {
    fetchMock.mockResolvedValue(json({ instructions: [dto()] }));
    const a = store().loadSessionCaptures('s1');
    const b = store().loadSessionCaptures('s1');
    await Promise.all([a, b]);
    await store().loadSessionCaptures('s1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/wisp/memory/captures?sessionId=s1');
    expect(store().bySession.s1).toEqual([dto()]);
  });

  it('allows a retry after a failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(json({ instructions: [dto()] }));
    await store().loadSessionCaptures('s1');
    await store().loadSessionCaptures('s1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store().bySession.s1).toHaveLength(1);
  });
});

describe('mutations', () => {
  it.each([
    ['keep', 'keep', 'confirmed'],
    ['forget', 'forget', 'retracted'],
    ['keepForOrg', 'keep-for-org', 'confirmed'],
  ] as const)('%s POSTs %s and merges the result', async (fn, path, status) => {
    store().applyInstructions('s1', [dto()]);
    fetchMock.mockResolvedValue(json({ instructions: [dto({ status })] }));
    await store()[fn]('s1', 'i-1');
    expect(fetchMock).toHaveBeenCalledWith(`/wisp/memory/captures/i-1/${path}`, { method: 'POST' });
    expect(store().bySession.s1).toHaveLength(1);
    expect(store().bySession.s1[0].status).toBe(status);
  });

  it('propagates a failure', async () => {
    fetchMock.mockResolvedValue(json({ error: 'cross_org' }, 409));
    await expect(store().keepForOrg('s1', 'i-1')).rejects.toMatchObject({ status: 409 });
  });
});

describe('logout', () => {
  it('clears bySession and stops polling', async () => {
    store().applyInstructions('s1', [dto()]);
    fetchMock.mockResolvedValue(json({ status: 'pending', instructions: [] }));
    store().trackCapture('s1', 'c-1');
    runLogoutHooks();
    expect(store().bySession).toEqual({});
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an in-flight load that resolves after logout does not write', async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => { resolve = r; }));
    const p = store().loadSessionCaptures('s1');
    runLogoutHooks();
    resolve(json({ instructions: [dto()] }));
    await p;
    expect(store().bySession).toEqual({});
  });
});
