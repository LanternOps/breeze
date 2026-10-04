import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchWithAuth } from '../../stores/auth';
import { denialMessage, RESEARCH_POLL_CAP_MS, RESEARCH_POLL_MS, useResearchStatus } from './useResearchStatus';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (data: unknown): Response => ({ ok: true, status: 200, json: async () => ({ data }) }) as unknown as Response;
const run = (status: string, extra = {}) => ({ runId: 'r', depth: 'quick', status, errorCode: null, noSafeFix: false, finishedAt: null, ...extra });
const researchCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/remediation-suggestions/research'));

describe('useResearchStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('polls an active run, stops on a terminal status and fires onTerminal once', async () => {
    const onTerminal = vi.fn();
    let n = 0;
    fetchMock.mockImplementation(() => Promise.resolve(json(run(++n < 2 ? 'running' : 'completed', { noSafeFix: true }))));
    const { result } = renderHook(() => useResearchStatus('sourceType=alert&sourceId=a', onTerminal));
    act(() => result.current.applyLoaded(run('running') as never));
    await act(() => vi.advanceTimersByTimeAsync(RESEARCH_POLL_MS));
    expect(result.current.status?.status).toBe('running');
    await act(() => vi.advanceTimersByTimeAsync(RESEARCH_POLL_MS));
    expect(result.current.status?.status).toBe('completed');
    expect(onTerminal).toHaveBeenCalledTimes(1);
    const calls = researchCalls().length;
    await act(() => vi.advanceTimersByTimeAsync(RESEARCH_POLL_MS * 3));
    expect(researchCalls().length).toBe(calls); // no further polling after terminal
  });

  it('stops polling on unmount', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(run('running'))));
    const { result, unmount } = renderHook(() => useResearchStatus('q', vi.fn()));
    act(() => result.current.applyLoaded(run('running') as never));
    await act(() => vi.advanceTimersByTimeAsync(RESEARCH_POLL_MS));
    const calls = researchCalls().length;
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(RESEARCH_POLL_MS * 3));
    expect(researchCalls().length).toBe(calls);
  });

  it('stalls after the 5 minute cap and resumes polling on restartPolling', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(run('running'))));
    const { result } = renderHook(() => useResearchStatus('q', vi.fn()));
    act(() => result.current.applyLoaded(run('running') as never));
    await act(() => vi.advanceTimersByTimeAsync(RESEARCH_POLL_CAP_MS + RESEARCH_POLL_MS));
    expect(result.current.stalled).toBe(true);
    const stalledCalls = researchCalls().length;
    await act(() => vi.advanceTimersByTimeAsync(RESEARCH_POLL_MS * 3));
    expect(researchCalls().length).toBe(stalledCalls); // gave up
    act(() => result.current.restartPolling());
    expect(result.current.stalled).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(RESEARCH_POLL_MS));
    expect(researchCalls().length).toBeGreaterThan(stalledCalls); // polling is back
  });

  it('does not overlap a slow GET with the next tick', async () => {
    let release: (r: Response) => void = () => undefined;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { release = resolve; }));
    const { result } = renderHook(() => useResearchStatus('q', vi.fn()));
    act(() => result.current.applyLoaded(run('running') as never));
    await act(() => vi.advanceTimersByTimeAsync(RESEARCH_POLL_MS * 3));
    expect(researchCalls().length).toBe(1);
    await act(async () => { release(json(run('running'))); });
    await act(() => vi.advanceTimersByTimeAsync(RESEARCH_POLL_MS));
    expect(researchCalls().length).toBe(2);
  });

  it('a null read never erases the status on screen', () => {
    const { result } = renderHook(() => useResearchStatus('q', vi.fn()));
    act(() => result.current.applyLoaded(run('failed') as never));
    act(() => result.current.applyLoaded(null));
    expect(result.current.status?.status).toBe('failed');
  });

  it('maps denial outcomes: friendly copy for raw skip codes, API message otherwise', () => {
    const { result } = renderHook(() => useResearchStatus('q', vi.fn()));
    act(() => result.current.noteOutcome({ status: 'denied', code: 'org_budget_exceeded', message: 'org_budget_exceeded' }));
    expect(result.current.denial?.code).toBe('org_budget_exceeded');
    expect(result.current.denial?.message).not.toBe('org_budget_exceeded');
    act(() => result.current.noteOutcome({ status: 'denied', code: 'plan_gate', message: 'Upgrade your plan' }));
    expect(result.current.denial?.message).toBe('Upgrade your plan');
    const t = (key: string) => `T:${key}`;
    expect(denialMessage('research_rate', 'raw', t)).toContain('research.denial.busy');
    expect(denialMessage('unknown_code', 'raw', t)).toBe('raw');
  });

  it('a started outcome becomes a queued run', () => {
    const { result } = renderHook(() => useResearchStatus('q', vi.fn()));
    act(() => result.current.noteOutcome({ status: 'started', runId: 'r9', depth: 'deep' }));
    expect(result.current.status).toMatchObject({ runId: 'r9', depth: 'deep', status: 'queued' });
  });

  it('resets when the source changes: no stale banner, no poll of B, no onTerminal from A', async () => {
    const onTerminal = vi.fn();
    let release: (r: Response) => void = () => undefined;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { release = resolve; }));
    const { result, rerender } = renderHook(({ q }) => useResearchStatus(q, onTerminal), { initialProps: { q: 'sourceId=A' } });
    act(() => result.current.applyLoaded(run('running') as never));
    act(() => result.current.noteOutcome({ status: 'denied', code: 'plan_gate', message: 'x' }));
    await act(() => vi.advanceTimersByTimeAsync(RESEARCH_POLL_MS)); // A's poll is now in flight
    expect(researchCalls().length).toBe(1);
    rerender({ q: 'sourceId=B' });
    expect(result.current.status).toBeNull();
    expect(result.current.denial).toBeNull();
    // A's in-flight response lands as a terminal status: it must be a no-op.
    await act(async () => { release(json(run('completed'))); });
    expect(result.current.status).toBeNull();
    expect(onTerminal).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(RESEARCH_POLL_MS * 3));
    expect(researchCalls().length).toBe(1); // B has no run, so nothing polls
    // A late panel read for A is ignored; B's own run does poll.
    act(() => result.current.applyLoaded(run('failed') as never, 'sourceId=A'));
    expect(result.current.status).toBeNull();
    act(() => result.current.applyLoaded(run('running') as never, 'sourceId=B'));
    await act(() => vi.advanceTimersByTimeAsync(RESEARCH_POLL_MS));
    expect(researchCalls().length).toBe(2);
    expect(String(researchCalls()[1][0])).toContain('sourceId=B');
  });
});
