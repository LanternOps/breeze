import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchWithAuth).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
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
    expect(queryByTestId('ai-run-card-open')).toBeNull();
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
});
