import { render, waitFor, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Echo `count` so assertions can pin the number, not just the key; W06
    // also echoes `step` and `goal` so the step number and goal text are pinned.
    t: (key: string, opts?: unknown) => {
      if (!opts || typeof opts !== 'object') return key;
      const o = opts as { count?: number; step?: number; goal?: string };
      if ('count' in o) return `${key}:${o.count}`;
      if ('step' in o) return `${key}:step=${o.step}`;
      if ('goal' in o) return `${key}:goal=${o.goal}`;
      return key;
    },
  }),
}));

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('@/stores/auth', () => ({ fetchWithAuth }));
const decideIntentApproval = vi.hoisted(() => vi.fn());
vi.mock('@/lib/intentApprovals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/intentApprovals')>()),
  decideIntentApproval,
}));
const showToast = vi.hoisted(() => vi.fn());
vi.mock('@/components/shared/Toast', () => ({ showToast }));

import { fireEvent } from '@testing-library/react';
import { ActionError } from '@/lib/runAction';
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

  it('keeps polling on awaiting_approval while intents are pending, and shows the pending count and /approvals link', async () => {
    vi.useFakeTimers();
    try {
      fetchWithAuth.mockResolvedValue(detail({
        status: 'awaiting_approval',
        intents: [
          { id: 'i1', status: 'pending_approval', actionName: 'x', approvalScope: 'single', decidedVia: null, approvalRequestId: 'r1' },
          { id: 'i2', status: 'pending_approval', actionName: 'y', approvalScope: 'single', decidedVia: null, approvalRequestId: 'r2' },
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
      expect(fetchWithAuth.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling on awaiting_approval once no intent is pending', async () => {
    vi.useFakeTimers();
    try {
      fetchWithAuth.mockResolvedValue(detail({ status: 'awaiting_approval', intents: [] }));
      render(<AiRunCard runId={RUN} initialStatus="running" run={undefined} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the approvals block from a live awaiting_approval result before any poll returns', () => {
    fetchWithAuth.mockReturnValue(new Promise(() => {}));
    const { getByTestId } = render(
      <AiRunCard
        runId={RUN}
        initialStatus="running"
        run={{ runId: RUN, status: 'awaiting_approval', summary: 'Needs a restart', artifacts: [], progress: [], pendingIntentCount: 3 }}
      />,
    );
    expect(getByTestId('ai-run-card-approvals')).toBeTruthy();
  });

  // The live result carries a count but not the steps. Without a poll the card
  // can only say "review in /approvals", and the technician has to leave the chat.
  it('still polls after a live awaiting_approval result, so the steps get their Approve buttons', async () => {
    fetchWithAuth.mockResolvedValue(detail({
      status: 'awaiting_approval',
      intents: [{
        id: 'i1', status: 'pending_approval', actionName: 'tool_i1', approvalScope: 'supervised',
        decidedVia: null, actionLabel: 'Label i1', approvalRequestId: 'req-i1',
      }],
    }));
    const { findByTestId } = render(
      <AiRunCard
        runId={RUN}
        initialStatus="running"
        run={{ runId: RUN, status: 'awaiting_approval', summary: null, artifacts: [], progress: [], pendingIntentCount: 1 }}
      />,
    );
    expect(await findByTestId('ai-run-card-step-approve-i1')).toBeTruthy();
  });

  // A live terminal result takes exactly one poll to land the settled cost and
  // files (#12110), never a polling loop.
  it('takes exactly one poll for a run whose live result is terminal', async () => {
    vi.useFakeTimers();
    try {
      fetchWithAuth.mockResolvedValue(detail({ status: 'completed' }));
      render(
        <AiRunCard
          runId={RUN}
          initialStatus="running"
          run={{ runId: RUN, status: 'completed', summary: 'Done', artifacts: [], progress: [] }}
        />,
      );
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(fetchWithAuth).toHaveBeenCalledTimes(1);
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

  it('takes one settling poll, not a re-armed loop, when a live terminal result lands while a poll is in flight', async () => {
    vi.useFakeTimers();
    try {
      let resolveFetch!: (v: unknown) => void;
      fetchWithAuth.mockReturnValueOnce(new Promise((r) => { resolveFetch = r; }));
      // The settling poll reads the run as settled; a stale read would be
      // retried a bounded number of times (#12137), covered separately.
      fetchWithAuth.mockResolvedValue(detail({ status: 'completed' }));
      const { rerender } = render(<AiRunCard runId={RUN} initialStatus="running" run={undefined} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(fetchWithAuth).toHaveBeenCalledTimes(1);
      rerender(
        <AiRunCard
          runId={RUN}
          initialStatus="running"
          run={{ runId: RUN, status: 'completed', summary: null, artifacts: [], progress: [] }}
        />,
      );
      await act(async () => { resolveFetch(detail({ status: 'running' })); await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      // The stale in-flight poll plus the one settling poll; nothing re-arms.
      expect(fetchWithAuth).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // Interaction of the terminal one-shot (#12110) with in-chat approvals: a
  // live approval park must not take the one-shot path, or a step the viewer
  // can still decide freezes on a stale poll.
  it('keeps polling when a live awaiting_approval lands after a poll already showed the viewer\'s pending step', async () => {
    vi.useFakeTimers();
    try {
      fetchWithAuth.mockResolvedValue(detail({
        status: 'awaiting_approval',
        intents: [{
          id: 'i1', status: 'pending_approval', actionName: 'tool_i1', approvalScope: 'supervised',
          decidedVia: null, actionLabel: 'Label i1', approvalRequestId: 'req-i1',
        }],
      }));
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
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(fetchWithAuth).toHaveBeenCalledTimes(2); // the restart re-reads at once
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(fetchWithAuth.mock.calls.length).toBeGreaterThan(2);
      // Once the step is decided elsewhere, the card goes quiet.
      fetchWithAuth.mockResolvedValue(detail({ status: 'awaiting_approval', intents: [] }));
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      const quiet = fetchWithAuth.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(fetchWithAuth.mock.calls.length).toBe(quiet);
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes no poll when a live terminal result lands after a settled poll', async () => {
    vi.useFakeTimers();
    try {
      fetchWithAuth.mockResolvedValue(detail({ status: 'completed' }));
      const { rerender } = render(<AiRunCard runId={RUN} initialStatus="running" run={undefined} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(fetchWithAuth).toHaveBeenCalledTimes(1);
      rerender(
        <AiRunCard
          runId={RUN}
          initialStatus="running"
          run={{ runId: RUN, status: 'completed', summary: null, artifacts: [], progress: [] }}
        />,
      );
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // A poll that raced the live result can still say "running". Stopping there
  // would freeze the card without its steps; it must poll until the API agrees.
  it('keeps polling past a stale running poll after a live awaiting_approval, then stops once nothing is the viewer\'s to decide', async () => {
    vi.useFakeTimers();
    try {
      fetchWithAuth
        .mockResolvedValueOnce(detail({ status: 'running' }))
        .mockResolvedValue(detail({ status: 'awaiting_approval', intents: [] }));
      render(
        <AiRunCard
          runId={RUN}
          initialStatus="running"
          run={{ runId: RUN, status: 'awaiting_approval', summary: null, artifacts: [], progress: [], pendingIntentCount: 1 }}
        />,
      );
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(fetchWithAuth).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(fetchWithAuth).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(fetchWithAuth).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('inline step approvals', () => {
    const intent = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      status: 'pending_approval',
      actionName: `tool_${id}`,
      approvalScope: 'supervised',
      decidedVia: null,
      actionLabel: `Label ${id}`,
      approvalRequestId: `req-${id}`,
      ...over,
    });
    const awaiting = (intents: unknown[], over: Record<string, unknown> = {}) =>
      detail({ status: 'awaiting_approval', intents, wisp: { grantorName: 'Dana' }, ...over });

    it('renders a row per pending intent and Approve calls the shared decide client', async () => {
      vi.useFakeTimers();
      try {
        decideIntentApproval.mockResolvedValue('decided');
        fetchWithAuth.mockResolvedValueOnce(awaiting([intent('a'), intent('b')]));
        const { getAllByTestId, getByTestId } = render(<AiRunCard runId={RUN} initialStatus="running" run={undefined} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(getAllByTestId('ai-run-card-step-approval')).toHaveLength(2);
        expect(getAllByTestId('ai-run-card-step-approval')[0].textContent).toContain('Label a');
        expect(getAllByTestId('ai-run-card-step-approval')[0].textContent).toContain('aiRunCard.stepApprovals.wispFor');
        // Next poll lists only b as pending.
        fetchWithAuth.mockResolvedValue(awaiting([intent('b'), intent('a', { status: 'approved' })]));
        await act(async () => {
          fireEvent.click(getByTestId('ai-run-card-step-approve-a'));
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(decideIntentApproval).toHaveBeenCalledWith('req-a', 'approve', undefined, 'supervised');
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(getAllByTestId('ai-run-card-step-approval')).toHaveLength(1);
        expect(getAllByTestId('ai-run-card-step-approval')[0].textContent).toContain('Label b');
      } finally {
        vi.useRealTimers();
      }
    });

    it('Deny sends deny', async () => {
      decideIntentApproval.mockResolvedValue('decided');
      fetchWithAuth.mockResolvedValue(awaiting([intent('a')]));
      const { findByTestId } = render(<AiRunCard runId={RUN} initialStatus="running" run={undefined} />);
      fireEvent.click(await findByTestId('ai-run-card-step-deny-a'));
      await waitFor(() => expect(decideIntentApproval).toHaveBeenCalledWith('req-a', 'deny', undefined, 'supervised'));
    });

    // The decide restarts the poll (pollNonce). Once the last step is decided
    // the card must go quiet, or every approved run keeps a tab polling for good.
    it('stops polling after the last step is decided, starting from a live awaiting_approval', async () => {
      vi.useFakeTimers();
      try {
        decideIntentApproval.mockResolvedValue('decided');
        fetchWithAuth.mockResolvedValueOnce(awaiting([intent('a')]));
        const { getByTestId, queryAllByTestId } = render(
          <AiRunCard
            runId={RUN}
            initialStatus="running"
            run={{ runId: RUN, status: 'awaiting_approval', summary: null, artifacts: [], progress: [], pendingIntentCount: 1 }}
          />,
        );
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        fetchWithAuth.mockResolvedValue(awaiting([intent('a', { status: 'approved' })]));
        await act(async () => {
          fireEvent.click(getByTestId('ai-run-card-step-approve-a'));
          await vi.advanceTimersByTimeAsync(0);
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(queryAllByTestId('ai-run-card-step-approval')).toHaveLength(0);
        const callsOnceDecided = fetchWithAuth.mock.calls.length;
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(fetchWithAuth.mock.calls.length).toBe(callsOnceDecided);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps polling while an intent is pending_approval', async () => {
      vi.useFakeTimers();
      try {
        fetchWithAuth.mockResolvedValue(awaiting([intent('a')]));
        render(<AiRunCard runId={RUN} initialStatus="running" run={undefined} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        await act(async () => { await vi.advanceTimersByTimeAsync(11_000); });
        expect(fetchWithAuth.mock.calls.length).toBeGreaterThanOrEqual(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops polling a settled run when no pending step is the caller\'s to decide', async () => {
      vi.useFakeTimers();
      try {
        fetchWithAuth.mockResolvedValue(awaiting([intent('a', { approvalRequestId: null })]));
        render(<AiRunCard runId={RUN} initialStatus="running" run={undefined} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
        expect(fetchWithAuth).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('shows no buttons when the caller cannot decide (approvalRequestId null)', async () => {
      fetchWithAuth.mockResolvedValue(awaiting([intent('a', { approvalRequestId: null })]));
      const { findByTestId, queryByTestId } = render(<AiRunCard runId={RUN} initialStatus="running" run={undefined} />);
      const row = await findByTestId('ai-run-card-step-approval');
      expect(row.querySelector('button')).toBeNull();
      expect(row.textContent).toContain('aiRunCard.stepApprovals.waitingForApprover');
      expect(queryByTestId('ai-run-card-step-approve-a')).toBeNull();
    });

    it('is silent on a 401 ActionError', async () => {
      decideIntentApproval.mockRejectedValue(new ActionError('nope', 401));
      fetchWithAuth.mockResolvedValue(awaiting([intent('a')]));
      const { findByTestId } = render(<AiRunCard runId={RUN} initialStatus="running" run={undefined} />);
      fireEvent.click(await findByTestId('ai-run-card-step-approve-a'));
      await waitFor(() => expect(decideIntentApproval).toHaveBeenCalled());
      await act(async () => { await Promise.resolve(); });
      expect(showToast).not.toHaveBeenCalled();
    });

    it('toasts an error for a non-ActionError failure', async () => {
      decideIntentApproval.mockRejectedValue(new Error('boom'));
      fetchWithAuth.mockResolvedValue(awaiting([intent('a')]));
      const { findByTestId } = render(<AiRunCard runId={RUN} initialStatus="running" run={undefined} />);
      fireEvent.click(await findByTestId('ai-run-card-step-approve-a'));
      await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    });

    it('surfaces the needs_device outcome as an error toast with the register-device copy', async () => {
      decideIntentApproval.mockResolvedValue('needs_device');
      fetchWithAuth.mockResolvedValue(awaiting([intent('a')]));
      const { findByTestId } = render(<AiRunCard runId={RUN} initialStatus="running" run={undefined} />);
      fireEvent.click(await findByTestId('ai-run-card-step-approve-a'));
      await waitFor(() => expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: 'aiApprovalDialog.noApproverDevice' }),
      ));
    });
  });

  describe('Continue', () => {
    const settled = (over: Record<string, unknown> = {}) => detail({ status: 'completed', profile: 'device_troubleshooting', ...over });

    it('renders for a settled device_troubleshooting run and calls onContinue(runId)', async () => {
      fetchWithAuth.mockResolvedValue(settled());
      const onContinue = vi.fn();
      const { findByTestId } = render(<AiRunCard runId={RUN} initialStatus="running" run={undefined} onContinue={onContinue} />);
      fireEvent.click(await findByTestId('ai-run-card-continue'));
      expect(onContinue).toHaveBeenCalledWith(RUN);
      expect(decideIntentApproval).not.toHaveBeenCalled();
    });

    it('does not render without onContinue, for other profiles, or while running', async () => {
      fetchWithAuth.mockResolvedValue(settled());
      const a = render(<AiRunCard runId={RUN} initialStatus="running" run={undefined} />);
      await a.findByTestId('ai-run-card-open');
      expect(a.queryByTestId('ai-run-card-continue')).toBeNull();
      a.unmount();

      fetchWithAuth.mockResolvedValue(settled({ profile: 'analysis' }));
      const b = render(<AiRunCard runId={RUN} initialStatus="running" run={undefined} onContinue={vi.fn()} />);
      await b.findByTestId('ai-run-card-open');
      expect(b.queryByTestId('ai-run-card-continue')).toBeNull();
      b.unmount();

      fetchWithAuth.mockResolvedValue(settled({ status: 'running' }));
      const c = render(<AiRunCard runId={RUN} initialStatus="running" run={undefined} onContinue={vi.fn()} />);
      await act(async () => { await Promise.resolve(); });
      expect(c.queryByTestId('ai-run-card-continue')).toBeNull();
    });
  });
});

describe('analysis chain surface (W06)', () => {
  const chain = [{ id: 'r0', step: 1 }, { id: 'r1', step: 2 }, { id: RUN, step: 3 }];

  it('shows the step only when the run is in a chain', async () => {
    fetchWithAuth.mockResolvedValue(detail({ profile: 'analysis', chainDepth: 2, chain }));
    const { findByTestId } = render(<AiRunCard runId={RUN} initialStatus="queued" run={undefined} />);
    expect((await findByTestId('ai-run-card-step')).textContent).toContain('aiRunCard.chainStep:step=3');
  });

  it('omits the step for an unchained run and for an API that predates the field', async () => {
    fetchWithAuth.mockResolvedValue(detail({ profile: 'analysis', chainDepth: 0, chain: null }));
    const a = render(<AiRunCard runId={RUN} initialStatus="queued" run={undefined} />);
    await a.findByTestId('ai-run-card-summary');
    expect(a.queryByTestId('ai-run-card-step')).toBeNull();
    a.unmount();
    fetchWithAuth.mockResolvedValue(detail({ profile: 'analysis' })); // no chain keys at all
    const b = render(<AiRunCard runId={RUN} initialStatus="queued" run={undefined} />);
    await b.findByTestId('ai-run-card-summary');
    expect(b.queryByTestId('ai-run-card-step')).toBeNull();
  });

  it('shows the goal, the findings count with the high count, and the settled cost', async () => {
    fetchWithAuth.mockResolvedValue(detail({ profile: 'analysis', analysisGoal: 'correlate BSODs',
      analysis: { summary: 's', artifactHandles: [], proposedActions: [],
        findings: [{ severity: 'high' }, { severity: 'low' }, { severity: 'info' }] } }));
    const { findByTestId } = render(<AiRunCard runId={RUN} initialStatus="queued" run={undefined} />);
    expect((await findByTestId('ai-run-card-goal')).textContent).toContain('aiRunCard.goal:goal=correlate BSODs');
    const findings = (await findByTestId('ai-run-card-findings')).textContent!;
    expect(findings).toContain('aiRunCard.findings:3');
    expect(findings).toContain('aiRunCard.findingsHigh:1');
    expect((await findByTestId('ai-run-card-cost')).textContent).toMatch(/0\.19/); // (12 + 7) cents
  });

  it('shows no cost before the first poll lands, and none for a non-analysis run', async () => {
    fetchWithAuth.mockResolvedValue(detail({ profile: 'device_troubleshooting', costCents: 40 }));
    const a = render(<AiRunCard runId={RUN} initialStatus="completed" run={undefined} />);
    await a.findByTestId('ai-run-card-summary');
    expect(a.queryByTestId('ai-run-card-cost')).toBeNull();
    a.unmount();
    // The poll never resolves: the stream says completed, but no cost is known yet.
    fetchWithAuth.mockReturnValue(new Promise(() => {}));
    const b = render(<AiRunCard runId={RUN} initialStatus="completed" run={undefined} />);
    expect(b.queryByTestId('ai-run-card-cost')).toBeNull();
  });

  it('does not show a mid-run poll cost as final when run_result arrives live; re-polls once for the settled cost', async () => {
    fetchWithAuth.mockResolvedValueOnce(detail({ profile: 'analysis', status: 'running', costCents: 5, computeCents: 0 }));
    fetchWithAuth.mockResolvedValue(detail({ profile: 'analysis', status: 'completed', costCents: 12, computeCents: 7 }));
    const live = (status: string) => ({ runId: RUN, status, summary: null, artifacts: [], progress: [] }) as never;
    const { queryByTestId, rerender } = render(
      <AiRunCard runId={RUN} initialStatus="queued" run={live('running')} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    // The stream reports completion while the last poll is still the partial one.
    fetchWithAuth.mockImplementationOnce(() => new Promise(() => {})); // hold the re-poll open
    rerender(<AiRunCard runId={RUN} initialStatus="queued" run={live('completed')} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(2));
    expect(queryByTestId('ai-run-card-cost')).toBeNull(); // 5c partial must not appear
  });

  it('shows the settled cost after the single re-poll and does not poll again', async () => {
    fetchWithAuth.mockResolvedValueOnce(detail({ profile: 'analysis', status: 'running', costCents: 5, computeCents: 0 }));
    fetchWithAuth.mockResolvedValue(detail({ profile: 'analysis', status: 'completed', costCents: 12, computeCents: 7 }));
    const live = (status: string) => ({ runId: RUN, status, summary: null, artifacts: [], progress: [] }) as never;
    const { findByTestId, queryByTestId, rerender } = render(
      <AiRunCard runId={RUN} initialStatus="queued" run={live('running')} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    rerender(<AiRunCard runId={RUN} initialStatus="queued" run={live('completed')} />);
    expect((await findByTestId('ai-run-card-cost')).textContent).toMatch(/0\.19/);
    expect(queryByTestId('ai-run-card-cost')!.textContent).not.toMatch(/0\.05/);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  // #12137: the settled cost comes from the single one-shot poll, so a failed or
  // stale read of it gets a short, bounded retry instead of leaving no cost.
  describe('settling poll retry (#12137)', () => {
    const liveDone = { runId: RUN, status: 'completed', summary: null, artifacts: [], progress: [] } as never;
    const settled = () => detail({ profile: 'analysis', status: 'completed', costCents: 12, computeCents: 7 });

    it('retries the settling poll after an HTTP error and then shows the settled cost', async () => {
      vi.useFakeTimers();
      try {
        fetchWithAuth.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
        fetchWithAuth.mockResolvedValue(settled());
        const { queryByTestId } = render(<AiRunCard runId={RUN} initialStatus="running" run={liveDone} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(fetchWithAuth).toHaveBeenCalledTimes(1);
        expect(queryByTestId('ai-run-card-cost')).toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
        expect(fetchWithAuth).toHaveBeenCalledTimes(2);
        expect(queryByTestId('ai-run-card-cost')!.textContent).toMatch(/0\.19/);
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
        expect(fetchWithAuth).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('retries the settling poll after a network error', async () => {
      vi.useFakeTimers();
      try {
        fetchWithAuth.mockRejectedValueOnce(new Error('network'));
        fetchWithAuth.mockResolvedValue(settled());
        const { queryByTestId } = render(<AiRunCard runId={RUN} initialStatus="running" run={liveDone} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
        expect(fetchWithAuth).toHaveBeenCalledTimes(2);
        expect(queryByTestId('ai-run-card-cost')!.textContent).toMatch(/0\.19/);
      } finally {
        vi.useRealTimers();
      }
    });

    it('retries when the settling poll still reads the run as in progress', async () => {
      vi.useFakeTimers();
      try {
        fetchWithAuth.mockResolvedValueOnce(detail({ profile: 'analysis', status: 'running', costCents: 5, computeCents: 0 }));
        fetchWithAuth.mockResolvedValue(settled());
        const { queryByTestId } = render(<AiRunCard runId={RUN} initialStatus="running" run={liveDone} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(queryByTestId('ai-run-card-cost')).toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
        expect(fetchWithAuth).toHaveBeenCalledTimes(2);
        expect(queryByTestId('ai-run-card-cost')!.textContent).toMatch(/0\.19/);
      } finally {
        vi.useRealTimers();
      }
    });

    it('retries 2 s apart, not on the 5 s polling cadence', async () => {
      vi.useFakeTimers();
      try {
        fetchWithAuth.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
        render(<AiRunCard runId={RUN} initialStatus="running" run={liveDone} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(1_999); });
        expect(fetchWithAuth).toHaveBeenCalledTimes(1);
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(fetchWithAuth).toHaveBeenCalledTimes(2);
        await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
        expect(fetchWithAuth).toHaveBeenCalledTimes(3);
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
        expect(fetchWithAuth).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('retries when the settling poll still reads awaiting_approval after a live terminal result', async () => {
      vi.useFakeTimers();
      try {
        fetchWithAuth.mockResolvedValueOnce(detail({ profile: 'analysis', status: 'awaiting_approval', intents: [] }));
        fetchWithAuth.mockResolvedValue(settled());
        const { queryByTestId } = render(<AiRunCard runId={RUN} initialStatus="running" run={liveDone} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(fetchWithAuth).toHaveBeenCalledTimes(1);
        await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
        expect(fetchWithAuth).toHaveBeenCalledTimes(2);
        expect(queryByTestId('ai-run-card-cost')!.textContent).toMatch(/0\.19/);
      } finally {
        vi.useRealTimers();
      }
    });

    it('takes a settling poll when a live terminal result lands after an awaiting_approval poll', async () => {
      vi.useFakeTimers();
      try {
        fetchWithAuth.mockResolvedValueOnce(detail({ profile: 'analysis', status: 'awaiting_approval', intents: [] }));
        fetchWithAuth.mockResolvedValue(settled());
        const { queryByTestId, rerender } = render(<AiRunCard runId={RUN} initialStatus="running" run={undefined} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
        // Nothing is the viewer's to decide, so the approval-parked poll stopped.
        expect(fetchWithAuth).toHaveBeenCalledTimes(1);
        rerender(<AiRunCard runId={RUN} initialStatus="running" run={liveDone} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(fetchWithAuth).toHaveBeenCalledTimes(2);
        expect(queryByTestId('ai-run-card-cost')!.textContent).toMatch(/0\.19/);
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
        expect(fetchWithAuth).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('gives up after two retries rather than polling forever', async () => {
      vi.useFakeTimers();
      try {
        fetchWithAuth.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
        const { queryByTestId } = render(<AiRunCard runId={RUN} initialStatus="running" run={liveDone} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(fetchWithAuth).toHaveBeenCalledTimes(3);
        expect(queryByTestId('ai-run-card-cost')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not retry after unmount', async () => {
      vi.useFakeTimers();
      try {
        fetchWithAuth.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
        const { unmount } = render(<AiRunCard runId={RUN} initialStatus="running" run={liveDone} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        unmount();
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(fetchWithAuth).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('lists no files from the live stream before the first poll lands', () => {
    fetchWithAuth.mockReturnValue(new Promise(() => {}));
    const { queryByTestId } = render(
      <AiRunCard runId={RUN} initialStatus="running"
        run={{ runId: RUN, status: 'completed', summary: null, progress: [],
          artifacts: [{ handle: 'h1', name: 'live.csv', bytes: 1, contentType: 'text/csv' }] } as never} />);
    expect(queryByTestId('ai-run-card-artifact-h1')).toBeNull();
    expect(queryByTestId('ai-run-card-files')).toBeNull();
  });

  it('keeps an output file whose expiry it cannot parse rather than hiding it', async () => {
    fetchWithAuth.mockResolvedValue(detail({ profile: 'analysis', artifacts: [
      { id: 'o3', name: 'x.csv', bytes: 1, contentType: 'text/csv', kind: 'output', expiresAt: 'not-a-date', downloadPath: '/api/v1/ai/artifacts/o3' },
    ] }));
    const { findByTestId } = render(<AiRunCard runId={RUN} initialStatus="queued" run={undefined} />);
    expect(await findByTestId('ai-run-card-artifact-o3')).toBeTruthy();
  });

  it('omits the high count when no finding is high', async () => {
    fetchWithAuth.mockResolvedValue(detail({ profile: 'analysis',
      analysis: { summary: 's', artifactHandles: [], proposedActions: [], findings: [{ severity: 'low' }] } }));
    const { findByTestId } = render(<AiRunCard runId={RUN} initialStatus="queued" run={undefined} />);
    expect((await findByTestId('ai-run-card-findings')).textContent).not.toContain('findingsHigh');
  });

  it('lists only unexpired output files for an analysis run', async () => {
    const future = '2099-01-01T00:00:00.000Z'; const past = '2020-01-01T00:00:00.000Z';
    fetchWithAuth.mockResolvedValue(detail({ profile: 'analysis', artifacts: [
      { id: 'o1', name: 'bsod_by_driver.csv', bytes: 14336, contentType: 'text/csv', kind: 'output', expiresAt: future, downloadPath: '/api/v1/ai/artifacts/o1' },
      { id: 'o2', name: 'old.csv', bytes: 10, contentType: 'text/csv', kind: 'output', expiresAt: past, downloadPath: '/api/v1/ai/artifacts/o2' },
      { id: 'x1', name: 'export.jsonl', bytes: 10, contentType: 'application/jsonl', kind: 'input_capture', expiresAt: future, downloadPath: '/api/v1/ai/artifacts/x1' },
      { id: 's1', name: 'step-1.py', bytes: 10, contentType: 'text/x-python', kind: 'step_script', expiresAt: future, downloadPath: '/api/v1/ai/artifacts/s1' },
    ] }));
    const { findByTestId, queryByTestId } = render(<AiRunCard runId={RUN} initialStatus="queued" run={undefined} />);
    expect((await findByTestId('ai-run-card-artifact-o1')).getAttribute('href')).toBe('/api/v1/ai/artifacts/o1');
    for (const id of ['o2', 'x1', 's1']) expect(queryByTestId(`ai-run-card-artifact-${id}`)).toBeNull();
    expect(queryByTestId('ai-run-card-files')).not.toBeNull();
  });
});
