import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MergeOrgModal, { MERGE_POLL_INTERVAL_MS } from './MergeOrgModal';
import type { Organization } from './OrganizationList';
import { fetchWithAuth, handleSessionExpired } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  handleSessionExpired: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const sessionExpiredMock = vi.mocked(handleSessionExpired);
const toastMock = vi.mocked(showToast);

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const LOSER: Organization = {
  id: 'loser-1111-1111-1111-111111111111',
  name: 'Acme Legacy',
  status: 'active',
  deviceCount: 3,
  createdAt: '2026-01-01T00:00:00Z',
};

const SURVIVOR: Organization = {
  id: 'survivor-2222-2222-2222-222222222222',
  name: 'Acme Corp',
  status: 'active',
  deviceCount: 40,
  createdAt: '2026-01-01T00:00:00Z',
};

const TRIAL_ORG: Organization = {
  id: 'trial-3333-3333-3333-333333333333',
  name: 'Trial Co',
  status: 'trial',
  deviceCount: 1,
  createdAt: '2026-01-01T00:00:00Z',
};

const SUSPENDED_ORG: Organization = {
  id: 'suspended-4444-4444-4444-444444444444',
  name: 'Suspended Co',
  status: 'suspended',
  deviceCount: 1,
  createdAt: '2026-01-01T00:00:00Z',
};

const QUICK_SUPPORT_ORG: Organization = {
  id: 'qs-5555-5555-5555-555555555555',
  name: 'Quick Support',
  status: 'active',
  type: 'quick_support',
  deviceCount: 0,
  createdAt: '2026-01-01T00:00:00Z',
};

const ALL_ORGS = [LOSER, SURVIVOR, TRIAL_ORG, SUSPENDED_ORG, QUICK_SUPPORT_ORG];

const PREVIEW_OK = {
  tables: [
    { table: 'devices', policy: 'repoint-dedupe', loserRows: 12, wouldDrop: 0 },
    { table: 'alerts', policy: 'keep-survivor', loserRows: 4, wouldDrop: 1 },
  ],
  totalMovableRows: 16,
  verdict: 'ok' as const,
  warnings: [
    'this merge will REVOKE 1 live API key belonging to the merged-away organization',
    "the merged-away organization's audit and provenance trail is PERMANENTLY DESTROYED by this merge",
  ],
};

const PREVIEW_TOO_LARGE = {
  tables: [],
  totalMovableRows: 999999,
  verdict: 'too-large' as const,
  warnings: [],
};

interface MergeResponse {
  payload: unknown;
  status?: number;
}

function routeFetch(handlers: {
  preview?: (body: unknown) => unknown;
  merge?: (body: unknown) => MergeResponse;
  poll?: (jobId: string) => unknown;
}) {
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST' && url.endsWith('/merge-preview')) {
      const body = JSON.parse(String(init.body));
      return jsonResponse(handlers.preview?.(body) ?? PREVIEW_OK);
    }
    if (init?.method === 'POST' && /\/organizations\/[^/]+\/merge$/.test(url)) {
      const body = JSON.parse(String(init.body));
      const { payload, status = 202 } = handlers.merge?.(body) ?? { payload: { jobId: 'job-1' } };
      return jsonResponse(payload, status < 400, status);
    }
    if (url.includes('/merge-runs/')) {
      const jobId = url.split('/merge-runs/')[1];
      return jsonResponse(handlers.poll?.(jobId) ?? { state: 'active' });
    }
    return jsonResponse({});
  });
}

async function selectSurvivorAndTypeName() {
  fireEvent.change(screen.getByTestId('org-merge-survivor-select'), { target: { value: SURVIVOR.id } });
  await waitFor(() => screen.getByTestId('org-merge-confirm-input'));
  fireEvent.change(screen.getByTestId('org-merge-confirm-input'), { target: { value: LOSER.name } });
}

beforeEach(() => {
  fetchMock.mockReset();
  sessionExpiredMock.mockReset();
  toastMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MergeOrgModal — survivor picker', () => {
  it('excludes the loser, quick_support orgs, and non-active/trial orgs', () => {
    render(<MergeOrgModal loserOrg={LOSER} orgs={ALL_ORGS} onClose={vi.fn()} onMerged={vi.fn()} />);

    const select = screen.getByTestId('org-merge-survivor-select');
    const optionNames = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent);

    expect(optionNames).toContain('Acme Corp');
    expect(optionNames).toContain('Trial Co');
    expect(optionNames).not.toContain('Acme Legacy'); // the loser itself
    expect(optionNames).not.toContain('Suspended Co');
    expect(optionNames).not.toContain('Quick Support');
  });
});

describe('MergeOrgModal — preview', () => {
  it('fetches and renders the preview on survivor selection', async () => {
    routeFetch({});
    render(<MergeOrgModal loserOrg={LOSER} orgs={ALL_ORGS} onClose={vi.fn()} onMerged={vi.fn()} />);

    fireEvent.change(screen.getByTestId('org-merge-survivor-select'), { target: { value: SURVIVOR.id } });

    await waitFor(() => expect(screen.getByTestId('org-merge-total-rows')).toHaveTextContent('16'));
    expect(within(screen.getByTestId('org-merge-tables-list')).getAllByRole('listitem')).toHaveLength(2);
    for (const warning of PREVIEW_OK.warnings) {
      expect(screen.getByText(warning)).toBeInTheDocument();
    }

    const previewCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/merge-preview'));
    expect(previewCall).toBeTruthy();
    expect(String(previewCall![0])).toContain(LOSER.id);
    expect(JSON.parse(String((previewCall![1] as RequestInit).body))).toEqual({ survivorId: SURVIVOR.id });
  });

  it('disables the confirm path and shows refusal copy on a too-large verdict', async () => {
    routeFetch({ preview: () => PREVIEW_TOO_LARGE });
    render(<MergeOrgModal loserOrg={LOSER} orgs={ALL_ORGS} onClose={vi.fn()} onMerged={vi.fn()} />);

    fireEvent.change(screen.getByTestId('org-merge-survivor-select'), { target: { value: SURVIVOR.id } });

    await waitFor(() => expect(screen.getByTestId('org-merge-too-large')).toBeInTheDocument());
    expect(screen.queryByTestId('org-merge-confirm-input')).not.toBeInTheDocument();
    expect(screen.getByTestId('org-merge-submit')).toBeDisabled();
  });
});

describe('MergeOrgModal — typed-name confirmation', () => {
  it('keeps the confirm button disabled until the typed name matches exactly (case-sensitive)', async () => {
    routeFetch({});
    render(<MergeOrgModal loserOrg={LOSER} orgs={ALL_ORGS} onClose={vi.fn()} onMerged={vi.fn()} />);
    fireEvent.change(screen.getByTestId('org-merge-survivor-select'), { target: { value: SURVIVOR.id } });
    await waitFor(() => screen.getByTestId('org-merge-confirm-input'));

    const submit = screen.getByTestId('org-merge-submit');
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByTestId('org-merge-confirm-input'), { target: { value: 'acme legacy' } });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByTestId('org-merge-confirm-input'), { target: { value: LOSER.name } });
    expect(submit).not.toBeDisabled();
  });
});

describe('MergeOrgModal — submit + progress', () => {
  it('POSTs the merge with {survivorId, confirmName}, polls until completed, renders the result, and calls onMerged', async () => {
    vi.useFakeTimers();
    const onMerged = vi.fn();
    let pollCalls = 0;
    routeFetch({
      poll: () => {
        pollCalls += 1;
        return pollCalls < 2
          ? { state: 'active' }
          : {
              state: 'completed',
              result: {
                tables: { devices: { moved: 12, dropped: 0 }, alerts: { moved: 3, dropped: 1 } },
                warnings: ['w1'],
                mergeEventId: 'evt-1',
              },
            };
      },
    });

    render(<MergeOrgModal loserOrg={LOSER} orgs={ALL_ORGS} onClose={vi.fn()} onMerged={onMerged} />);
    fireEvent.change(screen.getByTestId('org-merge-survivor-select'), { target: { value: SURVIVOR.id } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.change(screen.getByTestId('org-merge-confirm-input'), { target: { value: LOSER.name } });

    await act(async () => {
      fireEvent.click(screen.getByTestId('org-merge-submit'));
      await vi.advanceTimersByTimeAsync(0);
    });

    const mergeCall = fetchMock.mock.calls.find(
      ([url, init]) => /\/organizations\/[^/]+\/merge$/.test(String(url)) && (init as RequestInit)?.method === 'POST',
    );
    expect(mergeCall).toBeTruthy();
    expect(JSON.parse(String((mergeCall![1] as RequestInit).body))).toEqual({
      survivorId: SURVIVOR.id,
      confirmName: LOSER.name,
    });
    expect(screen.getByTestId('org-merge-progress')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MERGE_POLL_INTERVAL_MS);
    });

    expect(screen.getByTestId('org-merge-done')).toBeInTheDocument();
    const summary = screen.getByTestId('org-merge-result-summary');
    expect(summary).toHaveTextContent('15');
    expect(summary).toHaveTextContent('1');
    expect(screen.getByText('w1')).toBeInTheDocument();
    expect(onMerged).toHaveBeenCalledWith(LOSER.id);
  });

  it('stops polling on unmount', async () => {
    vi.useFakeTimers();
    let pollCalls = 0;
    routeFetch({
      poll: () => {
        pollCalls += 1;
        return { state: 'active' };
      },
    });

    const { unmount } = render(
      <MergeOrgModal loserOrg={LOSER} orgs={ALL_ORGS} onClose={vi.fn()} onMerged={vi.fn()} />,
    );
    fireEvent.change(screen.getByTestId('org-merge-survivor-select'), { target: { value: SURVIVOR.id } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.change(screen.getByTestId('org-merge-confirm-input'), { target: { value: LOSER.name } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('org-merge-submit'));
      await vi.advanceTimersByTimeAsync(0);
    });

    const callsSoFar = pollCalls;
    expect(callsSoFar).toBeGreaterThan(0);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MERGE_POLL_INTERVAL_MS * 3);
    });
    expect(pollCalls).toBe(callsSoFar);
  });

  it('renders failedReason on a failed run and retries by re-POSTing merge', async () => {
    vi.useFakeTimers();
    let mergeCalls = 0;
    const job2PollCounts: number[] = [];
    routeFetch({
      merge: () => {
        mergeCalls += 1;
        return { payload: { jobId: `job-${mergeCalls}` } };
      },
      poll: (jobId) => {
        if (jobId === 'job-1') return { state: 'failed', failedReason: 'boom' };
        job2PollCounts.push(1);
        return job2PollCounts.length < 2
          ? { state: 'active' }
          : { state: 'completed', result: { tables: {}, warnings: [], mergeEventId: 'evt-2' } };
      },
    });

    render(<MergeOrgModal loserOrg={LOSER} orgs={ALL_ORGS} onClose={vi.fn()} onMerged={vi.fn()} />);
    fireEvent.change(screen.getByTestId('org-merge-survivor-select'), { target: { value: SURVIVOR.id } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.change(screen.getByTestId('org-merge-confirm-input'), { target: { value: LOSER.name } });

    await act(async () => {
      fireEvent.click(screen.getByTestId('org-merge-submit'));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByTestId('org-merge-failed')).toBeInTheDocument();
    expect(screen.getByTestId('org-merge-failed-reason')).toHaveTextContent('boom');

    await act(async () => {
      fireEvent.click(screen.getByTestId('org-merge-retry'));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mergeCalls).toBe(2);
    expect(screen.getByTestId('org-merge-progress')).toBeInTheDocument();
  });
});

describe('MergeOrgModal — server-side confirmName mismatch', () => {
  it('surfaces the 400 error without closing the modal', async () => {
    const onClose = vi.fn();
    routeFetch({
      merge: () => ({
        payload: { error: 'confirmName does not match the organization being merged away' },
        status: 400,
      }),
    });
    render(<MergeOrgModal loserOrg={LOSER} orgs={ALL_ORGS} onClose={onClose} onMerged={vi.fn()} />);
    await selectSurvivorAndTypeName();

    fireEvent.click(screen.getByTestId('org-merge-submit'));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          message: expect.stringContaining('confirmName does not match'),
        }),
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('org-merge-survivor-select')).toBeInTheDocument();
  });
});
