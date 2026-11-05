import { render, waitFor, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Echo `count` so assertions can pin the number, not just the key.
    t: (key: string, opts?: unknown) =>
      opts && typeof opts === 'object' && 'count' in opts ? `${key}:${(opts as { count: number }).count}` : key,
  }),
}));

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('@/stores/auth', () => ({ fetchWithAuth }));

import AiRunCard from './AiRunCard';

const RUN = '11111111-1111-4111-8111-111111111111';

function detail(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    json: async () => ({
      data: {
        id: RUN,
        status: 'completed',
        summary: 'Three accounts failed logon.',
        computeCents: 7,
        costCents: 12,
        artifacts: [{
          id: 'a1',
          name: 'failed-logons.csv',
          bytes: 40112,
          contentType: 'text/csv',
          kind: 'output',
          downloadPath: '/api/v1/ai/artifacts/a1',
        }],
        ...overrides,
      },
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchWithAuth.mockResolvedValue(detail());
});

describe('AiRunCard (spec §5.5)', () => {
  it('renders the queued state from the tool result before any poll returns', () => {
    const { getByTestId } = render(<AiRunCard runId={RUN} initialStatus="queued" run={undefined} />);
    expect(getByTestId('ai-run-card-status').textContent).toContain('queued');
  });

  it('shows the summary and one downloadable artifact chip once the run completes', async () => {
    const { getByTestId, findByTestId } = render(
      <AiRunCard runId={RUN} initialStatus="queued" run={undefined} />,
    );
    const chip = await findByTestId('ai-run-card-artifact-a1');
    expect(chip.getAttribute('href')).toBe('/api/v1/ai/artifacts/a1');
    expect(chip.getAttribute('download')).toBe('failed-logons.csv');
    expect(getByTestId('ai-run-card-summary').textContent).toContain('Three accounts failed logon.');
  });

  it('renders live progress steps from the store without waiting for a poll', () => {
    const { getByTestId } = render(
      <AiRunCard
        runId={RUN}
        initialStatus="queued"
        run={{
          runId: RUN,
          status: 'running',
          summary: null,
          artifacts: [],
          progress: [{ step: 'export_dataset', label: 'Exported 12,400 rows', ordinal: 1 }],
        }}
      />,
    );
    expect(getByTestId('ai-run-card-progress').textContent).toContain('Exported 12,400 rows');
  });

  it('points at the run page when the result arrived with no live stream', async () => {
    // No `run` prop: the turn was over long before the run finished, so the
    // summary came from the poll and the conversation itself never showed it.
    const { findByTestId } = render(<AiRunCard runId={RUN} initialStatus="queued" run={undefined} />);
    expect((await findByTestId('ai-run-card-offline-notice')).textContent)
      .toContain('aiRunCard.resultOnRunPage');
    expect((await findByTestId('ai-run-card-open')).getAttribute('href'))
      .toBe(`/ai-agents/runs/${RUN}`);
  });

  it('omits that notice when the result was delivered live into this conversation', async () => {
    const { findByTestId, queryByTestId } = render(
      <AiRunCard
        runId={RUN}
        initialStatus="queued"
        run={{ runId: RUN, status: 'completed', summary: 'done', artifacts: [], progress: [] }}
      />,
    );
    await findByTestId('ai-run-card-open');
    expect(queryByTestId('ai-run-card-offline-notice')).toBeNull();
  });

  it('stops polling once the run is terminal', async () => {
    render(<AiRunCard runId={RUN} initialStatus="queued" run={undefined} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    await new Promise((r) => { setTimeout(r, 50); });
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('keeps polling after a transient HTTP error instead of stopping forever', async () => {
    // `if (!res.ok) return` used to exit BEFORE the reschedule, so a single 500
    // — or a 403 after an org-access change — froze the card on its spinner
    // permanently, with no error, no retry and no way to tell. That is strictly
    // worse than the "the next tick retries" the catch block promises.
    vi.useFakeTimers();
    try {
      fetchWithAuth.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
      fetchWithAuth.mockResolvedValue(detail());
      render(<AiRunCard runId={RUN} initialStatus="queued" run={undefined} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(fetchWithAuth).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(fetchWithAuth).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a cancelled run as terminal and stops polling', async () => {
    // TERMINAL was a hand-copied Set<string> with no compile-time link to
    // AiAgentRunStatus. A status the card does not recognise as terminal means
    // every open tab polls that run every five seconds forever.
    fetchWithAuth.mockResolvedValue(detail({ status: 'cancelled', summary: null, artifacts: [] }));
    const { findByTestId } = render(<AiRunCard runId={RUN} initialStatus="queued" run={undefined} />);
    await findByTestId('ai-run-card-open');
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    await new Promise((r) => { setTimeout(r, 50); });
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('does not treat awaiting_approval as terminal — that run is still going', async () => {
    fetchWithAuth.mockResolvedValue(detail({ status: 'awaiting_approval' }));
    const { queryByTestId, getByTestId } = render(
      <AiRunCard runId={RUN} initialStatus="queued" run={undefined} />,
    );
    await waitFor(() => expect(getByTestId('ai-run-card-status').textContent).toContain('awaiting_approval'));
    // The run link is useful while parked on approval; the offline notice is terminal-only.
    expect(getByTestId('ai-run-card-open').getAttribute('href')).toBe(`/ai-agents/runs/${RUN}`);
    expect(queryByTestId('ai-run-card-offline-notice')).toBeNull();
  });

  it('escapes artifact names rather than interpreting them as markup', async () => {
    fetchWithAuth.mockResolvedValue(detail({
      artifacts: [{
        id: 'a2',
        name: '<img src=x onerror=alert(1)>.csv',
        bytes: 10,
        contentType: 'text/csv',
        kind: 'output',
        downloadPath: '/api/v1/ai/artifacts/a2',
      }],
    }));
    const { findByTestId, container } = render(
      <AiRunCard runId={RUN} initialStatus="queued" run={undefined} />,
    );
    await findByTestId('ai-run-card-artifact-a2');
    expect(container.querySelector('img')).toBeNull();
  });
  it('fills the step list from the poll when no live stream is attached', async () => {
    fetchWithAuth.mockResolvedValue(detail({
      status: 'running',
      progress: [
        { step: 'get_device_health', label: 'Checking device health', ordinal: 1 },
        { step: 'search_logs', label: 'Searching logs', ordinal: 2 },
      ],
    }));
    const { findByTestId } = render(<AiRunCard runId={RUN} initialStatus="queued" run={undefined} />);
    const list = await findByTestId('ai-run-card-progress');
    expect(list.textContent).toContain('Checking device health');
    expect(list.textContent).toContain('Searching logs');
  });

  it('merges live and polled steps by ordinal without duplicates', async () => {
    fetchWithAuth.mockResolvedValue(detail({
      status: 'running',
      progress: [
        { step: 'a', label: 'Polled one', ordinal: 1 },
        { step: 'b', label: 'Polled two', ordinal: 2 },
      ],
    }));
    const { findByTestId } = render(
      <AiRunCard
        runId={RUN}
        initialStatus="running"
        run={{
          runId: RUN, status: 'running', summary: null, artifacts: [],
          progress: [
            { step: 'b', label: 'Live two', ordinal: 2 },
            { step: 'c', label: 'Live three', ordinal: 3 },
          ],
        }}
      />,
    );
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    const list = await findByTestId('ai-run-card-progress');
    await waitFor(() => expect(list.querySelectorAll('li')).toHaveLength(3));
    const text = Array.from(list.querySelectorAll('li')).map((li) => li.textContent);
    expect(text).toEqual(['Polled one', 'Live two', 'Live three']);
  });

  it('stops polling on awaiting_approval and shows the pending count and /approvals link', async () => {
    vi.useFakeTimers();
    try {
      fetchWithAuth.mockResolvedValue(detail({
        status: 'awaiting_approval',
        intents: [
          { id: 'i1', status: 'pending_approval', actionName: 'x', approvalScope: 'single', decidedVia: null },
          { id: 'i2', status: 'pending_approval', actionName: 'y', approvalScope: 'single', decidedVia: null },
          { id: 'i3', status: 'completed', actionName: 'z', approvalScope: 'single', decidedVia: null },
        ],
      }));
      const { getByTestId, queryByTestId } = render(
        <AiRunCard runId={RUN} initialStatus="running" run={undefined} />,
      );
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const block = getByTestId('ai-run-card-approvals');
      // Two pending_approval intents; the completed one is filtered out.
      expect(block.textContent).toContain('aiRunCard.approvals.pending:2');
      expect(block.querySelector('a')?.getAttribute('href')).toBe('/approvals');
      expect(queryByTestId('ai-run-card-open')).not.toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the approvals block from a live awaiting_approval result and does not poll', async () => {
    vi.useFakeTimers();
    try {
      const { getByTestId } = render(
        <AiRunCard
          runId={RUN}
          initialStatus="running"
          run={{ runId: RUN, status: 'awaiting_approval', summary: 'Needs a restart', artifacts: [], progress: [], pendingIntentCount: 3 }}
        />,
      );
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(getByTestId('ai-run-card-approvals')).toBeTruthy();
      expect(fetchWithAuth).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not spin on awaiting_approval (static clock icon)', async () => {
    fetchWithAuth.mockResolvedValue(detail({ status: 'awaiting_approval' }));
    const { getByTestId, container } = render(
      <AiRunCard runId={RUN} initialStatus="running" run={undefined} />,
    );
    await waitFor(() => expect(getByTestId('ai-run-card-status').textContent).toContain('awaiting_approval'));
    expect(container.querySelector('svg.animate-spin')).toBeNull();
  });

  it('does not spin on a cancelled run either', async () => {
    fetchWithAuth.mockResolvedValue(detail({ status: 'cancelled', summary: null, artifacts: [] }));
    const { findByTestId, container } = render(
      <AiRunCard runId={RUN} initialStatus="running" run={undefined} />,
    );
    await findByTestId('ai-run-card-open');
    expect(container.querySelector('svg.animate-spin')).toBeNull();
  });

  it('still spins while running', () => {
    const { container } = render(<AiRunCard runId={RUN} initialStatus="running" run={undefined} />);
    expect(container.querySelector('svg.animate-spin')).not.toBeNull();
  });

  it('renders no approvals block when nothing is pending any more (count 0)', async () => {
    const { queryByTestId } = render(
      <AiRunCard
        runId={RUN}
        initialStatus="running"
        run={{ runId: RUN, status: 'awaiting_approval', summary: null, artifacts: [], progress: [], pendingIntentCount: 0 }}
      />,
    );
    expect(queryByTestId('ai-run-card-approvals')).toBeNull();
  });

  it('keeps the generic waiting line when the count is unknown', () => {
    const { getByTestId } = render(
      <AiRunCard
        runId={RUN}
        initialStatus="running"
        run={{ runId: RUN, status: 'awaiting_approval', summary: null, artifacts: [], progress: [] }}
      />,
    );
    expect(getByTestId('ai-run-card-approvals').textContent).toContain('aiRunCard.approvals.waiting');
  });

  it('a live pendingIntentCount wins while the poll still says running', async () => {
    fetchWithAuth.mockResolvedValue(detail({
      status: 'running',
      intents: [{ id: 'i1', status: 'pending_approval' }],
    }));
    const { rerender, getByTestId } = render(
      <AiRunCard runId={RUN} initialStatus="running" run={undefined} />,
    );
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    rerender(
      <AiRunCard
        runId={RUN}
        initialStatus="running"
        run={{ runId: RUN, status: 'awaiting_approval', summary: null, artifacts: [], progress: [], pendingIntentCount: 3 }}
      />,
    );
    expect(getByTestId('ai-run-card-approvals').textContent).toContain('aiRunCard.approvals.pending:3');
  });

  it('the polled count wins once the poll says awaiting_approval', async () => {
    fetchWithAuth.mockResolvedValue(detail({
      status: 'awaiting_approval',
      intents: [{ id: 'i1', status: 'pending_approval' }, { id: 'i2', status: 'completed' }],
    }));
    const { getByTestId } = render(
      <AiRunCard
        runId={RUN}
        initialStatus="running"
        run={{ runId: RUN, status: 'running', summary: null, artifacts: [], progress: [], pendingIntentCount: 3 }}
      />,
    );
    await waitFor(() => expect(getByTestId('ai-run-card-approvals').textContent).toContain('aiRunCard.approvals.pending:1'));
  });

  it('a poll resolving running after a live awaiting_approval does not regress the status', async () => {
    let resolveFetch!: (v: unknown) => void;
    fetchWithAuth.mockReturnValue(new Promise((r) => { resolveFetch = r; }));
    const { rerender, getByTestId } = render(
      <AiRunCard runId={RUN} initialStatus="running" run={undefined} />,
    );
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    rerender(
      <AiRunCard
        runId={RUN}
        initialStatus="running"
        run={{ runId: RUN, status: 'awaiting_approval', summary: null, artifacts: [], progress: [], pendingIntentCount: 2 }}
      />,
    );
    await act(async () => { resolveFetch(detail({ status: 'running' })); await Promise.resolve(); });
    expect(getByTestId('ai-run-card-status').textContent).toContain('awaiting_approval');
  });

  it('does not re-arm polling when live settles while a poll is in flight', async () => {
    vi.useFakeTimers();
    try {
      let resolveFetch!: (v: unknown) => void;
      fetchWithAuth.mockReturnValue(new Promise((r) => { resolveFetch = r; }));
      const { rerender } = render(<AiRunCard runId={RUN} initialStatus="running" run={undefined} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(fetchWithAuth).toHaveBeenCalledTimes(1);
      rerender(
        <AiRunCard
          runId={RUN}
          initialStatus="running"
          run={{ runId: RUN, status: 'awaiting_approval', summary: null, artifacts: [], progress: [], pendingIntentCount: 1 }}
        />,
      );
      await act(async () => { resolveFetch(detail({ status: 'running' })); await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
