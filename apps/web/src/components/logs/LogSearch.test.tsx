import '@/lib/i18n';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import LogSearch from './LogSearch';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const orgState = vi.hoisted(() => ({ currentOrgId: null as string | null }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: typeof orgState) => unknown) => selector(orgState),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

function makeResponse(payload: unknown, ok = true): Response {
  return {
    ok,
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

describe('LogSearch', () => {
  beforeEach(() => {
    orgState.currentOrgId = null;
    fetchWithAuthMock.mockReset();
    fetchWithAuthMock.mockResolvedValue(
      makeResponse({ results: [], total: 0 }),
    );
  });

  // #7158: search/source/start/end datetime inputs each had a sibling
  // <label> that was never linked via htmlFor, so they had no accessible
  // name. Assert the labels now resolve the inputs.
  it('links the search, source, and date range labels to their inputs', async () => {
    render(<LogSearch />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());

    expect(screen.getByLabelText('Search')).toBeInTheDocument();
    expect(screen.getByLabelText('Source')).toBeInTheDocument();
    expect(screen.getByLabelText('Start')).toBeInTheDocument();
    expect(screen.getByLabelText('End')).toBeInTheDocument();
  });

  it('runs saved queries without replacing their filters and pages at the returned limit', async () => {
    const savedQueryId = '75c55207-b3b4-462f-848b-fdd9e849e56d';
    const savedSearches: unknown[] = [];
    fetchWithAuthMock.mockImplementation(async (url, options) => {
      if (url === '/logs/queries') return makeResponse({ data: [{ id: savedQueryId, name: 'Service failures' }] });
      const body = JSON.parse(String(options?.body));
      if (!body.savedQueryId) return makeResponse({ results: [], total: 0 });
      savedSearches.push(body);
      return makeResponse({ results: [], total: null, limit: 17, hasMore: body.offset === 0 });
    });

    render(<LogSearch />);
    await screen.findByRole('option', { name: 'Service failures' });
    fireEvent.change(screen.getByLabelText('Saved queries'), { target: { value: savedQueryId } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Page 2');
    expect(savedSearches).toEqual([{ savedQueryId, offset: 0 }, { savedQueryId, offset: 17 }]);
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save Query' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Saved queries'), { target: { value: '' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Query' })).toBeEnabled());
    expect(JSON.parse(String(fetchWithAuthMock.mock.lastCall?.[1]?.body))).toMatchObject({ limit: 100, offset: 0 });
  });

  // #12297: a partner user with several orgs has no implicit org, so the API
  // refuses to save unless the body names the org picked in the switcher.
  it.each([
    ['sends the selected organization', 'org-b', { orgId: 'org-b' }],
    ['sends no organization when none is selected', null, {}],
  ])('Save Query %s (#12297)', async (_label, currentOrgId, expectedOrg) => {
    orgState.currentOrgId = currentOrgId;
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('Service failures');
    render(<LogSearch />);
    const save = screen.getByRole('button', { name: 'Save Query' });
    await waitFor(() => expect(save).toBeEnabled());

    fireEvent.click(save);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith('/logs/queries', expect.objectContaining({ method: 'POST' })));
    const post = fetchWithAuthMock.mock.calls.find(([url, options]) => url === '/logs/queries' && options?.method === 'POST')!;
    const body = JSON.parse(String(post[1]?.body));
    expect(body).toMatchObject({ name: 'Service failures', ...expectedOrg });
    if (!currentOrgId) expect(body).not.toHaveProperty('orgId');
    prompt.mockRestore();
  });

  it('keeps custom search available when listing saved queries fails', async () => {
    fetchWithAuthMock.mockImplementation(async (url) => url === '/logs/queries'
      ? makeResponse({}, false)
      : makeResponse({ results: [], total: 0 }));
    render(<LogSearch />);
    expect(await screen.findByText('Could not load saved queries.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Search Fleet Logs' })).toBeEnabled());
  });

  it.each(['/logs/queries', '/logs/search'])(
    'bounds a stalled %s request without suppressing its timeout error', async (endpoint) => {
      const timeouts: AbortController[] = [];
      const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
        const controller = new AbortController();
        timeouts.push(controller);
        return controller.signal;
      });
      let pendingSignal: AbortSignal | undefined;
      fetchWithAuthMock.mockImplementation(async (url, options) => {
        if (url !== endpoint) return makeResponse({ data: [], results: [], total: 0 });
        pendingSignal = options?.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          pendingSignal!.addEventListener('abort', () => reject(pendingSignal!.reason), { once: true });
        });
      });
      try {
        render(<LogSearch />);
        await waitFor(() => expect(pendingSignal).toBeDefined());
        expect(timeout).toHaveBeenCalledWith(30_000);
        await act(async () => {
          for (const controller of timeouts) controller.abort(new DOMException('Request timed out', 'TimeoutError'));
        });
        expect(pendingSignal!.aborted).toBe(true);
        expect(await screen.findByText(endpoint === '/logs/queries'
          ? 'Could not load saved queries.' : 'Failed to search logs')).toBeInTheDocument();
        await waitFor(() => expect(screen.getByRole('button', { name: 'Search Fleet Logs' })).toBeEnabled());
      } finally {
        timeout.mockRestore();
      }
    },
  );

  it('ignores a superseded search response after choosing a saved query', async () => {
    const savedQueryId = '75c55207-b3b4-462f-848b-fdd9e849e56d';
    let finishCustom!: (response: Response) => void;
    const pendingCustom = new Promise<Response>((resolve) => { finishCustom = resolve; });
    fetchWithAuthMock.mockImplementation(async (url, options) => {
      if (url === '/logs/queries') return makeResponse({ data: [{ id: savedQueryId, name: 'Service failures' }] });
      return JSON.parse(String(options?.body)).savedQueryId
        ? makeResponse({ results: [], total: 2, limit: 17 })
        : pendingCustom;
    });

    render(<LogSearch />);
    await screen.findByRole('option', { name: 'Service failures' });
    fireEvent.change(screen.getByLabelText('Saved queries'), { target: { value: savedQueryId } });
    await screen.findByText('0 shown of 2 total');
    await act(async () => finishCustom(makeResponse({ results: [], total: 20 })));
    expect(screen.getByText('0 shown of 2 total')).toBeInTheDocument();
  });
});

describe('LogSearch rows select accessible name (#7156)', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    fetchWithAuthMock.mockResolvedValue(
      makeResponse({ results: [], total: 0 }),
    );
  });

  it('ties the "Rows" label to the select via htmlFor/id', () => {
    render(<LogSearch />);
    expect(screen.getByRole('combobox', { name: 'Rows' })).toBeInTheDocument();
  });
});
