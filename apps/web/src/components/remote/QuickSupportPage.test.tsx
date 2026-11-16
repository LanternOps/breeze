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
  // Relative to now: the page hides a code whose countdown has run out.
  codeExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  hardExpiresAt: new Date(Date.now() + 8 * 3_600_000).toISOString(),
  landingUrl: LANDING_URL,
};

/** A "New code" response for the same session. */
const NEW_CODE = {
  ...CREATED,
  code: 'JKL-MNP-QRS',
  landingUrl: 'https://app.example.com/quick?code=JKLMNPQRS',
  codeExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
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
  created?: typeof CREATED;
  newCodeResponse?: Response;
} = {}) {
  const detailQueue = [...(options.detail ?? [view()])];
  let lastDetail = detailQueue[0];
  fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
    if (url === LIST_URL) return makeResponse({ sessions: options.list ?? [] });
    if (url === '/remote/support-sessions' && opts?.method === 'POST') {
      return makeResponse(options.created ?? CREATED, true, 201);
    }
    if (url === `${DETAIL_URL}/end` && opts?.method === 'POST') {
      return options.endResponse ?? makeResponse({ success: true });
    }
    if (url === `${DETAIL_URL}/code` && opts?.method === 'POST') {
      return options.newCodeResponse ?? makeResponse(NEW_CODE);
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
    // #11836: the code stays readable while pending; the copy says so.
    expect(screen.getByText(/stays here until the person uses it/i)).toBeInTheDocument();
  });

  it('copies the landing URL from the copy-link button', async () => {
    installFetch();
    render(<QuickSupportPage />);
    await createSession();

    fireEvent.click(screen.getByTestId('quick-support-copy-link'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(LANDING_URL));
    expect(writeText).not.toHaveBeenCalledWith('ABC-DEF-GHI');
  });

  // #10508: an API without a configured public base returns a bare path; the
  // clipboard must still get a link that works when pasted into email or chat.
  it('copies an absolute URL when the API returns a relative landing path', async () => {
    installFetch({ created: { ...CREATED, landingUrl: '/quick?code=ABCDEFGHI' } });
    render(<QuickSupportPage />);
    await createSession();

    fireEvent.click(screen.getByTestId('quick-support-copy-link'));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/quick?code=ABCDEFGHI`),
    );
    expect(writeText).not.toHaveBeenCalledWith('/quick?code=ABCDEFGHI');
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

  it('closes the panel, clears the hash and warns when the selected session 404s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // A hash pointing at a deleted/expired/other-org session now seeds the
    // selection on mount, so the /detail GET can legitimately 404.
    window.location.hash = `#${SESSION_ID}`;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === LIST_URL) return makeResponse({ sessions: [] });
      if (url === DETAIL_URL) return makeResponse({ error: 'not_found' }, false, 404);
      return makeResponse({});
    });
    render(<QuickSupportPage />);

    // The panel flashes from the hash seed, then the 404 poll tears it down.
    await waitFor(() => expect(detailCallCount()).toBe(1));
    await waitFor(() =>
      expect(screen.queryByTestId('quick-support-detail')).not.toBeInTheDocument(),
    );
    expect(showToastMock).toHaveBeenCalledWith({
      message: 'That support session is no longer available.',
      type: 'warning',
    });
    // Hash stripped (no bare '#'), search untouched — same as the close button.
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('');

    // A definitive 404 is terminal: the dead session is never polled again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(detailCallCount()).toBe(1);
  });

  it('keeps polling a transient 5xx on the selected session', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.location.hash = `#${SESSION_ID}`;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === LIST_URL) return makeResponse({ sessions: [] });
      if (url === DETAIL_URL) return makeResponse({ error: 'boom' }, false, 503);
      return makeResponse({});
    });
    render(<QuickSupportPage />);

    await waitFor(() => expect(detailCallCount()).toBe(1));
    // A 5xx is transient — the panel stays open and the poll keeps retrying.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(detailCallCount()).toBe(2);
    expect(screen.getByTestId('quick-support-detail')).toBeInTheDocument();
    expect(showToastMock).not.toHaveBeenCalled();
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

  // #3432: the warning copy used to claim the code "can never be shown again",
  // which this path contradicts — `created` is not cleared, so re-selecting the
  // session minted in THIS page load shows the same code again. That is
  // deliberate (same operator, same tab, already saw it; a stray click should
  // not burn a live session), so the fix was to make the copy state the real
  // constraint: the server keeps only a hash, so a reload loses it for good.
  it('shows the minted code again when its own session is re-selected in the same page load', async () => {
    installFetch({
      // Both the older session and the one this page load is about to mint are
      // in history, so the tech can click between them.
      list: [
        view({ id: 'ss-old', status: 'active', attributionLabel: 'Reception PC' }),
        view({ id: SESSION_ID, status: 'pending', attributionLabel: 'New call' }),
      ],
      detail: [view({ status: 'pending' })],
    });
    render(<QuickSupportPage />);
    await createSession();

    const rows = await screen.findAllByTestId('quick-support-row');
    expect(rows).toHaveLength(2);

    // Away to the older session...
    fireEvent.click(rows[0]);
    expect(window.location.hash).toBe('#ss-old');
    expect(screen.queryByTestId('quick-support-code')).not.toBeInTheDocument();

    // ...and back to the one this page load minted: the code is on screen again.
    fireEvent.click(rows[1]);
    expect(window.location.hash).toBe(`#${SESSION_ID}`);
    expect(screen.getByTestId('quick-support-code')).toHaveTextContent('ABC-DEF-GHI');
  });

  // #11836: the code is readable from the API while the session is pending, so
  // it survives a reload.
  it('shows the server-held code, link and countdown for a pending session after a reload', async () => {
    window.location.hash = `#${SESSION_ID}`;
    const pending = view({ code: 'ABC-DEF-GHI', landingUrl: LANDING_URL, canIssueNewCode: true });
    installFetch({ list: [pending], detail: [pending] });
    render(<QuickSupportPage />);

    expect(await screen.findByTestId('quick-support-code')).toHaveTextContent('ABC-DEF-GHI');
    expect(screen.getByTestId('quick-support-landing-link')).toHaveTextContent(LANDING_URL);
    expect(screen.getByTestId('quick-support-code-countdown')).toHaveTextContent(/Expires in \d+:\d{2}/);
    expect(screen.getByTestId('quick-support-detail')).toHaveTextContent(/stays here until the person uses it/i);
    // The list row carries the code too.
    expect(screen.getByTestId('quick-support-row-code')).toHaveTextContent('ABC-DEF-GHI');

    fireEvent.click(screen.getByTestId('quick-support-copy-code'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('ABC-DEF-GHI'));
  });

  it('hides the code and offers New code once the countdown runs out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.location.hash = `#${SESSION_ID}`;
    const soon = new Date(Date.now() + 5_000).toISOString();
    const pending = view({ code: 'ABC-DEF-GHI', landingUrl: LANDING_URL, codeExpiresAt: soon, canIssueNewCode: true });
    installFetch({ list: [pending], detail: [pending] });
    render(<QuickSupportPage />);

    expect(await screen.findByTestId('quick-support-code')).toHaveTextContent('ABC-DEF-GHI');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_000);
    });
    expect(screen.queryByTestId('quick-support-code')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quick-support-row-code')).not.toBeInTheDocument();
    expect(screen.getByTestId('quick-support-code-expired')).toHaveTextContent(/has expired/i);
    expect(screen.getByTestId('quick-support-new-code')).toBeInTheDocument();
  });

  it('mints a New code through runAction and shows it in place of the old one', async () => {
    window.location.hash = `#${SESSION_ID}`;
    const pending = view({ code: 'ABC-DEF-GHI', landingUrl: LANDING_URL, canIssueNewCode: true });
    installFetch({ list: [pending], detail: [pending] });
    render(<QuickSupportPage />);
    await screen.findByTestId('quick-support-code');

    runActionMock.mockClear();
    fireEvent.click(screen.getByTestId('quick-support-new-code'));

    await waitFor(() =>
      expect(screen.getByTestId('quick-support-code')).toHaveTextContent('JKL-MNP-QRS'),
    );
    expect(fetchMock).toHaveBeenCalledWith(`${DETAIL_URL}/code`, expect.objectContaining({ method: 'POST' }));
    expect(runActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        errorFallback: 'Could not generate a new code',
        successMessage: 'New code generated. The previous code no longer works.',
      }),
    );
  });

  it('revives a reaper-expired session with New code and resumes polling it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.location.hash = `#${SESSION_ID}`;
    const lapsed = view({
      status: 'expired',
      endedReason: 'expired',
      endedAt: new Date(Date.now() - 60_000).toISOString(),
      codeExpiresAt: new Date(Date.now() - 120_000).toISOString(),
      canIssueNewCode: true,
    });
    const revived = view({ code: NEW_CODE.code, landingUrl: NEW_CODE.landingUrl, codeExpiresAt: NEW_CODE.codeExpiresAt, canIssueNewCode: true });
    installFetch({ list: [lapsed], detail: [lapsed, revived] });
    render(<QuickSupportPage />);

    expect(await screen.findByTestId('quick-support-code-expired')).toBeInTheDocument();
    await waitFor(() => expect(detailCallCount()).toBe(1));
    // Terminal: the poller stopped.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(detailCallCount()).toBe(1);

    fireEvent.click(screen.getByTestId('quick-support-new-code'));
    await waitFor(() =>
      expect(screen.getByTestId('quick-support-code')).toHaveTextContent('JKL-MNP-QRS'),
    );
    expect(screen.getByTestId('quick-support-status')).toHaveTextContent('Waiting for the user');
    // Pending again, so the poller started over.
    await waitFor(() => expect(detailCallCount()).toBeGreaterThanOrEqual(2));
  });

  it('shows neither a code nor New code when the server offers neither', async () => {
    window.location.hash = `#${SESSION_ID}`;
    // Pending and inside its TTL but no code: e.g. a session created before
    // codes were kept, viewed by someone who cannot mint Quick Support codes.
    const pending = view({ canIssueNewCode: false });
    installFetch({ list: [pending], detail: [pending] });
    render(<QuickSupportPage />);

    expect(await screen.findByTestId('quick-support-no-code')).toBeInTheDocument();
    expect(screen.queryByTestId('quick-support-code')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quick-support-new-code')).not.toBeInTheDocument();
  });

  it('refreshes instead of toasting twice when New code loses to a redeem (409)', async () => {
    window.location.hash = `#${SESSION_ID}`;
    const pending = view({ code: 'ABC-DEF-GHI', landingUrl: LANDING_URL, canIssueNewCode: true });
    installFetch({
      list: [pending],
      detail: [pending],
      newCodeResponse: makeResponse({ error: 'Support session can no longer take a new code' }, false, 409),
    });
    render(<QuickSupportPage />);
    await screen.findByTestId('quick-support-code');
    const listCallsBefore = fetchMock.mock.calls.filter(([url]) => url === LIST_URL).length;

    fireEvent.click(screen.getByTestId('quick-support-new-code'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([url]) => url === LIST_URL).length).toBeGreaterThan(listCallsBefore),
    );
    // runAction already toasted the server's message; the page adds none.
    expect(showToastMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a list load failure', async () => {
    fetchMock.mockResolvedValue(makeResponse({ error: 'nope' }, false));
    render(<QuickSupportPage />);

    expect(
      await screen.findByText('Could not load recent support sessions'),
    ).toBeInTheDocument();
  });
});
