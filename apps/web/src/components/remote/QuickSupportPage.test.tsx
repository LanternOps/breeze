import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import QuickSupportPage, { type SupportSessionView } from './QuickSupportPage';
import { fetchWithAuth } from '@/stores/auth';
import { runAction } from '@/lib/runAction';
import { showToast } from '@/components/shared/Toast';

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('@/stores/orgStore', () => ({
  useOrgStore: () => ({ organizations: [{ id: 'org-1', name: 'Acme Dental' }] }),
}));

vi.mock('@/components/shared/Toast', () => ({
  showToast: vi.fn(),
}));

// The real button opens sessions/deep links; only its presence matters here.
vi.mock('./ConnectDesktopButton', () => ({
  default: ({ deviceId }: { deviceId: string }) => (
    <button type="button">connect-{deviceId}</button>
  ),
}));

// Wrap (not replace) runAction so the real success/failure semantics still run
// while the test can assert that mutations actually went through it.
vi.mock('@/lib/runAction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runAction')>();
  return { ...actual, runAction: vi.fn(actual.runAction) };
});

const fetchMock = vi.mocked(fetchWithAuth);
const runActionMock = vi.mocked(runAction);
const showToastMock = vi.mocked(showToast);

const SESSION_ID = 'ss-1';
const LANDING_URL = 'https://app.example.com/quick?code=ABC-DEF-GHI';

const CREATED = {
  id: SESSION_ID,
  code: 'ABC-DEF-GHI',
  codeExpiresAt: '2026-08-04T12:10:00.000Z',
  hardExpiresAt: '2026-08-04T14:00:00.000Z',
  landingUrl: LANDING_URL,
};

function view(overrides: Partial<SupportSessionView> = {}): SupportSessionView {
  return {
    id: SESSION_ID,
    status: 'pending',
    createdAt: '2026-08-04T12:00:00.000Z',
    codeExpiresAt: CREATED.codeExpiresAt,
    hardExpiresAt: CREATED.hardExpiresAt,
    deviceId: null,
    deviceOnline: false,
    attributedOrgId: null,
    attributionLabel: null,
    endedAt: null,
    endedReason: null,
    createdByUserId: 'user-1',
    ...overrides,
  };
}

const makeResponse = (payload: unknown = {}, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const LIST_URL = '/remote/support-sessions?limit=50';
const DETAIL_URL = `/remote/support-sessions/${SESSION_ID}`;

const writeText = vi.fn().mockResolvedValue(undefined);

/**
 * Routes every request the page makes. `detailStatuses` is consumed one entry
 * per poll; the last entry sticks so a test can assert the poll stopped.
 */
function installFetch(options: {
  detail?: SupportSessionView[];
  list?: SupportSessionView[];
  endResponse?: Response;
} = {}) {
  const detailQueue = [...(options.detail ?? [view()])];
  let lastDetail = detailQueue[0];
  fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
    if (url === LIST_URL) return makeResponse({ sessions: options.list ?? [] });
    if (url === '/remote/support-sessions' && opts?.method === 'POST') {
      return makeResponse(CREATED, true, 201);
    }
    if (url === `${DETAIL_URL}/end` && opts?.method === 'POST') {
      return options.endResponse ?? makeResponse({ success: true });
    }
    if (url === DETAIL_URL) {
      if (detailQueue.length > 0) lastDetail = detailQueue.shift()!;
      return makeResponse(lastDetail);
    }
    return makeResponse({});
  });
}

function detailCallCount(): number {
  return fetchMock.mock.calls.filter(([url]) => url === DETAIL_URL).length;
}

/** Opens the dialog and submits it, returning once the code panel is on screen. */
async function createSession(label?: string) {
  fireEvent.click(screen.getByTestId('quick-support-new'));
  if (label !== undefined) {
    fireEvent.change(screen.getByLabelText('Reference label (optional)'), {
      target: { value: label },
    });
  }
  fireEvent.click(screen.getByTestId('quick-support-create'));
  await screen.findByTestId('quick-support-code');
}

beforeEach(() => {
  fetchMock.mockReset();
  runActionMock.mockClear();
  showToastMock.mockClear();
  writeText.mockClear();
  // Selection lives in the fragment — a leftover hash would auto-open a detail
  // panel (and start a poll) in the next test.
  window.location.hash = '';
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
  window.location.hash = '';
});

describe('QuickSupportPage', () => {
  it('creates a session through runAction and shows the one-time code', async () => {
    installFetch();
    render(<QuickSupportPage />);

    fireEvent.click(screen.getByTestId('quick-support-new'));
    fireEvent.change(screen.getByLabelText('Attribute to customer (optional)'), {
      target: { value: 'org-1' },
    });
    // The org picker must not read as a tenancy control.
    expect(
      screen.getByText(/Reporting only .* does not grant or change access/i),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Reference label (optional)'), {
      target: { value: "Jane's laptop" },
    });
    fireEvent.click(screen.getByTestId('quick-support-create'));

    expect(await screen.findByTestId('quick-support-code')).toHaveTextContent('ABC-DEF-GHI');

    expect(runActionMock).toHaveBeenCalledWith(
      expect.objectContaining({ errorFallback: 'Could not create the support session' }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/remote/support-sessions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ attributedOrgId: 'org-1', attributionLabel: "Jane's laptop" }),
      }),
    );
    // The "you only get this once" warning must be on screen with the code.
    expect(screen.getByText(/This code appears only once/i)).toBeInTheDocument();
  });

  it('copies the landing URL from the copy-link button', async () => {
    installFetch();
    render(<QuickSupportPage />);
    await createSession();

    fireEvent.click(screen.getByTestId('quick-support-copy-link'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(LANDING_URL));
    expect(writeText).not.toHaveBeenCalledWith('ABC-DEF-GHI');
  });

  it('polls every 3s and stops permanently once the session is terminal', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installFetch({
      detail: [
        view({ status: 'pending' }),
        view({ status: 'claimed' }),
        view({ status: 'ended', endedAt: '2026-08-04T12:30:00.000Z', endedReason: 'tech_ended' }),
      ],
    });
    render(<QuickSupportPage />);
    await createSession();

    await waitFor(() => expect(detailCallCount()).toBe(1));
    expect(screen.getByTestId('quick-support-status')).toHaveTextContent(
      'Waiting for the user to run the client',
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(detailCallCount()).toBe(2);
    expect(screen.getByTestId('quick-support-status')).toHaveTextContent('Client connecting');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(detailCallCount()).toBe(3);
    await waitFor(() =>
      expect(screen.getByTestId('quick-support-status')).toHaveTextContent('Session ended'),
    );

    // Terminal: no further polls no matter how much time passes.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(detailCallCount()).toBe(3);
    // …and the terminal session offers no End button.
    expect(screen.queryByTestId('quick-support-end')).not.toBeInTheDocument();
  });

  it('stops polling when the page unmounts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installFetch({ detail: [view({ status: 'pending' })] });
    const { unmount } = render(<QuickSupportPage />);
    await createSession();

    await waitFor(() => expect(detailCallCount()).toBe(1));
    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(detailCallCount()).toBe(1);
  });

  it('renders the connect button only once a device is enrolled and online', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installFetch({
      detail: [
        view({ status: 'claimed', deviceId: 'dev-9', deviceOnline: false }),
        view({ status: 'ready', deviceId: 'dev-9', deviceOnline: true }),
      ],
    });
    render(<QuickSupportPage />);
    await createSession();

    await waitFor(() => expect(detailCallCount()).toBe(1));
    expect(screen.queryByTestId('quick-support-connect')).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await waitFor(() =>
      expect(screen.getByTestId('quick-support-connect')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('quick-support-connect')).toHaveTextContent('connect-dev-9');
    expect(screen.getByTestId('quick-support-status')).toHaveTextContent('Ready to connect');
  });

  it('ends the session through runAction and toasts the outcome', async () => {
    installFetch({ detail: [view({ status: 'pending' })] });
    render(<QuickSupportPage />);
    await createSession();

    runActionMock.mockClear();
    fireEvent.click(screen.getByTestId('quick-support-end'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `${DETAIL_URL}/end`,
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    expect(runActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        errorFallback: 'Could not end the support session',
        successMessage: 'Support session ended',
      }),
    );
    // runAction (the real implementation) is what surfaces the outcome.
    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith({
        message: 'Support session ended',
        type: 'success',
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('quick-support-status')).toHaveTextContent('Session ended'),
    );
  });

  it('reconciles a 409 from End instead of leaving a dead button', async () => {
    installFetch({
      detail: [view({ status: 'pending' })],
      endResponse: makeResponse({ error: 'already_ended' }, false, 409),
    });
    render(<QuickSupportPage />);
    await createSession();

    fireEvent.click(screen.getByTestId('quick-support-end'));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith({
        message: 'That support session had already ended',
        type: 'warning',
      }),
    );
  });

  it('lists recent sessions with their status and label', async () => {
    installFetch({
      list: [
        view({
          id: 'ss-old',
          status: 'expired',
          attributionLabel: 'Reception PC',
          createdAt: '2026-08-01T09:00:00.000Z',
        }),
      ],
    });
    render(<QuickSupportPage />);

    const list = await screen.findByTestId('quick-support-list');
    await waitFor(() => expect(list).toHaveTextContent('Reception PC'));
    expect(list).toHaveTextContent('Session expired');
  });

  it('re-opens a session from a history row, without ever re-showing a code', async () => {
    installFetch({
      list: [
        view({
          status: 'ready',
          deviceId: 'dev-9',
          deviceOnline: true,
          attributionLabel: 'Reception PC',
        }),
      ],
      detail: [view({ status: 'ready', deviceId: 'dev-9', deviceOnline: true })],
    });
    render(<QuickSupportPage />);

    fireEvent.click(await screen.findByTestId('quick-support-row'));

    const detail = screen.getByTestId('quick-support-detail');
    expect(detail).toHaveTextContent('Reception PC');
    expect(screen.getByTestId('quick-support-status')).toHaveTextContent('Ready to connect');
    // The one-time code is gone forever once the page that minted it moved on.
    expect(screen.queryByTestId('quick-support-code')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quick-support-copy-link')).not.toBeInTheDocument();
    // Device is enrolled and online, so the tech can connect straight away.
    expect(screen.getByTestId('quick-support-connect')).toHaveTextContent('connect-dev-9');
    // Selection is deep-linkable via the fragment, never a query param.
    expect(window.location.hash).toBe(`#${SESSION_ID}`);
    expect(window.location.search).toBe('');
  });

  it('restores the hash-selected session on mount and polls it', async () => {
    window.location.hash = `#${SESSION_ID}`;
    installFetch({
      list: [view({ status: 'active', attributionLabel: 'Reception PC' })],
      detail: [view({ status: 'active' })],
    });
    render(<QuickSupportPage />);

    expect(await screen.findByTestId('quick-support-detail')).toBeInTheDocument();
    await waitFor(() => expect(detailCallCount()).toBeGreaterThanOrEqual(1));
    await waitFor(() =>
      expect(screen.getByTestId('quick-support-status')).toHaveTextContent('Session in progress'),
    );
    expect(screen.queryByTestId('quick-support-code')).not.toBeInTheDocument();
  });

  it('ends a re-opened session from the detail panel', async () => {
    installFetch({
      list: [view({ status: 'active', attributionLabel: 'Reception PC' })],
      detail: [view({ status: 'active' })],
    });
    render(<QuickSupportPage />);

    fireEvent.click(await screen.findByTestId('quick-support-row'));
    // Let the first poll land so it cannot overwrite the optimistic end below.
    await waitFor(() => expect(detailCallCount()).toBe(1));

    runActionMock.mockClear();
    fireEvent.click(screen.getByTestId('quick-support-end'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `${DETAIL_URL}/end`,
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    expect(runActionMock).toHaveBeenCalledWith(
      expect.objectContaining({ successMessage: 'Support session ended' }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('quick-support-status')).toHaveTextContent('Session ended'),
    );
    expect(screen.queryByTestId('quick-support-end')).not.toBeInTheDocument();
  });

  it('drops the freshly minted code when another session is opened from history', async () => {
    installFetch({
      list: [view({ id: 'ss-old', status: 'active', attributionLabel: 'Reception PC' })],
    });
    render(<QuickSupportPage />);
    await createSession();

    expect(screen.getByTestId('quick-support-code')).toHaveTextContent('ABC-DEF-GHI');

    fireEvent.click(await screen.findByTestId('quick-support-row'));

    expect(screen.queryByTestId('quick-support-code')).not.toBeInTheDocument();
    expect(screen.getByTestId('quick-support-detail')).toHaveTextContent('Reception PC');
    expect(window.location.hash).toBe('#ss-old');
  });

  it('surfaces a list load failure', async () => {
    fetchMock.mockResolvedValue(makeResponse({ error: 'nope' }, false));
    render(<QuickSupportPage />);

    expect(
      await screen.findByText('Could not load recent support sessions'),
    ).toBeInTheDocument();
  });
});
