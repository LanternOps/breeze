/** Tool Catalog W4 (#5219) B3 — runs tab on the flow detail page. */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ listFlowRuns: vi.fn() }));
vi.mock('./api', () => api);
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (sel?: (s: unknown) => unknown) => {
    const st = { organizations: [{ id: 'org-1', name: 'Acme Corp' }], currentOrgId: null };
    return sel ? sel(st) : st;
  },
}));

import { FlowRunsTab } from './FlowRunsTab';

const base = {
  flowId: 'f1', flowName: 'Nightly', orgId: 'org-1', definitionVersion: 2,
  triggerKind: 'manual', triggeredVia: 'ui', errorCode: null, currentStepId: null,
  createdAt: '2026-10-20T02:00:00.000Z', startedAt: '2026-10-20T02:00:00.000Z', finishedAt: '2026-10-20T02:01:05.000Z',
};
const runs = [
  { ...base, id: 'run-a', status: 'completed' },
  { ...base, id: 'run-b', status: 'failed', errorCode: 'step_failed', triggerKind: 'schedule', triggeredVia: 'scheduler' },
];

describe('FlowRunsTab', () => {
  beforeEach(() => {
    api.listFlowRuns.mockReset();
    api.listFlowRuns.mockResolvedValue({ runs, total: 2 });
  });
  afterEach(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    vi.useRealTimers();
  });

  it('renders a row per run linking to the run page, with org for partner-wide flows', async () => {
    render(<FlowRunsTab flowId="f1" ownerScope="partner" />);
    const link = await screen.findByTestId('flow-run-link-run-a');
    expect(link.getAttribute('href')).toBe('/flows/runs/run-a');
    expect(screen.getByTestId('flow-run-link-run-b').getAttribute('href')).toBe('/flows/runs/run-b');
    expect(screen.getByTestId('flow-run-status-run-a').textContent).toBe('Completed');
    expect(screen.getAllByText('Acme Corp').length).toBeGreaterThan(0);
  });

  it('hides the org column for org-owned flows', async () => {
    render(<FlowRunsTab flowId="f1" ownerScope="organization" />);
    await screen.findByTestId('flow-run-link-run-a');
    expect(screen.queryByText('Acme Corp')).toBeNull();
  });

  it('status filter reloads with the chosen status', async () => {
    render(<FlowRunsTab flowId="f1" ownerScope="organization" />);
    await screen.findByTestId('flow-run-link-run-a');
    await userEvent.setup().selectOptions(screen.getByTestId('flow-runs-status-filter'), 'failed');
    expect(api.listFlowRuns).toHaveBeenLastCalledWith('f1', expect.objectContaining({ status: 'failed' }));
  });

  it('polls every 10 s while a visible run is active, then stops', async () => {
    vi.useFakeTimers();
    api.listFlowRuns
      .mockResolvedValueOnce({ runs: [{ ...base, id: 'run-a', status: 'running', finishedAt: null }], total: 1 })
      .mockResolvedValueOnce({ runs: [{ ...base, id: 'run-a', status: 'completed' }], total: 1 });
    render(<FlowRunsTab flowId="f1" ownerScope="organization" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.listFlowRuns).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(api.listFlowRuns).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(api.listFlowRuns).toHaveBeenCalledTimes(2);
  });

  it('reloads when the tab becomes visible after a fetch finished while it was hidden', async () => {
    vi.useFakeTimers();
    const setHidden = (hidden: boolean) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    let resolveFirst: (v: unknown) => void = () => {};
    api.listFlowRuns.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));
    api.listFlowRuns.mockResolvedValue({ runs: [{ ...base, id: 'run-a', status: 'running', finishedAt: null }], total: 1 });
    render(<FlowRunsTab flowId="f1" ownerScope="organization" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.listFlowRuns).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    await act(async () => {
      resolveFirst({ runs: [{ ...base, id: 'run-a', status: 'running', finishedAt: null }], total: 1 });
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(api.listFlowRuns).toHaveBeenCalledTimes(1); // no timer was scheduled while hidden
    await act(async () => { setHidden(false); await vi.advanceTimersByTimeAsync(0); });
    expect(api.listFlowRuns).toHaveBeenCalledTimes(2);
  });
});
