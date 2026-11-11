import '@/lib/i18n';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PsaAlertTicketingCard, { type AlertTicketingView } from './PsaAlertTicketingCard';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, statusText: '', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const BASE = '/psa/connections/c1/alert-ticketing';

function makeView(overrides: Partial<AlertTicketingView> = {}): AlertTicketingView {
  return {
    connectionId: 'c1',
    provider: 'connectwise',
    capable: true,
    rev: 3,
    config: null,
    configInvalid: false,
    enabledAt: null,
    paused: null,
    status: { active: false, reason: 'disabled' },
    bound: true,
    serviceManagementMode: 'external',
    companyLinksConfirmed: false,
    canManage: true,
    ...overrides,
  };
}

const OPTIONS = {
  boards: { options: [{ id: 5, name: 'Service Board' }, { id: 6, name: 'Alerts Board' }], truncated: false },
  priorities: { options: [{ id: 1, name: 'P1' }, { id: 2, name: 'P2' }], truncated: false },
  statuses: null,
};
const BOARD_STATUSES = {
  ...OPTIONS,
  statuses: {
    options: [
      { id: 10, name: 'New', closed: false },
      { id: 11, name: 'Done', closed: true },
    ],
    truncated: false,
  },
};

type Recorded = { url: string; method: string; body: any };

function install(opts: {
  view: AlertTicketingView | Response | ((n: number) => AlertTicketingView | Response);
  put?: Response;
  options?: Response | ((url: string) => Response | Promise<Response>);
  recorded?: Recorded[];
}) {
  let viewCalls = 0;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'PUT') {
      opts.recorded?.push({ url, method, body: JSON.parse(init!.body as string) });
      return opts.put ?? json({ data: makeView() });
    }
    if (url.startsWith(`${BASE}/options`)) {
      const o = opts.options ?? json({ data: url.includes('boardId=') ? BOARD_STATUSES : OPTIONS });
      return typeof o === 'function' ? o(url) : o;
    }
    if (url === BASE) {
      viewCalls += 1;
      const v = typeof opts.view === 'function' ? opts.view(viewCalls) : opts.view;
      return 'ok' in v ? (v as Response) : json({ data: v });
    }
    if (url.startsWith('/psa/tickets?')) return json({ data: [], counts: {}, pagination: { total: 0, page: 1, limit: 20 } });
    throw new Error(`Unexpected fetch ${method} ${url}`);
  });
}

describe('PsaAlertTicketingCard', () => {
  it('renders ticket activity on the bound capable connection', async () => {
    install({ view: makeView() });
    render(<PsaAlertTicketingCard connectionId="c1" connectionName="Manage" />);
    expect(await screen.findByTestId('psa-ticketing-activity')).toBeInTheDocument();
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when the provider is not capable', async () => {
    install({ view: makeView({ capable: false }) });
    const { container } = render(<PsaAlertTicketingCard connectionId="c1" connectionName="CW" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(BASE));
    expect(container).toBeEmptyDOMElement();
  });

  it.each([403, 404])('renders nothing on %i', async status => {
    install({ view: json({ error: 'nope' }, status) });
    const { container } = render(<PsaAlertTicketingCard connectionId="c1" connectionName="CW" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing on 401', async () => {
    install({ view: json({ error: 'unauthorized' }, 401) });
    const { container } = render(<PsaAlertTicketingCard connectionId="c1" connectionName="CW" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a load error with a working Retry on a 500', async () => {
    install({ view: n => (n === 1 ? json({ error: 'boom' }, 500) : makeView({ companyLinksConfirmed: true })) });
    const user = userEvent.setup();
    render(<PsaAlertTicketingCard connectionId="c1" connectionName="CW" />);
    const err = await screen.findByTestId('psa-alert-ticketing-load-error');
    expect(err).toHaveTextContent('Could not load alert ticket settings');
    expect(screen.getByTestId('psa-alert-ticketing-card')).toHaveTextContent('CW');
    await user.click(screen.getByTestId('psa-alert-ticketing-load-retry'));
    expect(await screen.findByTestId('psa-alert-ticketing-form')).toBeInTheDocument();
    expect(screen.queryByTestId('psa-alert-ticketing-load-error')).not.toBeInTheDocument();
  });

  it('shows the load error when the request throws', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    render(<PsaAlertTicketingCard connectionId="c1" connectionName="CW" />);
    expect(await screen.findByTestId('psa-alert-ticketing-load-error')).toBeInTheDocument();
  });

  it('keeps the form when the reload after a 409 conflict fails', async () => {
    install({
      view: n => (n === 1 ? makeView({ companyLinksConfirmed: true, config: { ...baseConfig(), enabled: false } }) : json({ error: 'boom' }, 500)),
      put: json({ error: 'conflict', code: 'alert_ticketing_rev_conflict', currentRev: 9 }, 409),
    });
    const user = userEvent.setup();
    render(<PsaAlertTicketingCard connectionId="c1" connectionName="CW" />);
    await user.click(await screen.findByTestId('psa-alert-ticketing-save'));
    expect(await screen.findByTestId('psa-alert-ticketing-load-error')).toBeInTheDocument();
    expect(screen.getByTestId('psa-alert-ticketing-form')).toBeInTheDocument();
  });

  it('requires the replace checkbox before saving an unreadable stored config', async () => {
    const recorded: Recorded[] = [];
    install({ view: makeView({ config: null, configInvalid: true, companyLinksConfirmed: true }), recorded });
    const user = userEvent.setup();
    render(<PsaAlertTicketingCard connectionId="c1" connectionName="CW" />);
    expect(await screen.findByTestId('psa-alert-ticketing-config-invalid')).toHaveTextContent(
      'The saved alert ticket settings could not be read. Saving replaces them.',
    );
    const save = screen.getByTestId('psa-alert-ticketing-save');
    expect(save).toBeDisabled();
    await user.click(screen.getByTestId('psa-alert-ticketing-confirm-replace'));
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(recorded).toHaveLength(1));
  });

  it('clears the previous board statuses immediately when the board changes', async () => {
    install({
      view: makeView({ companyLinksConfirmed: true }),
      options: url =>
        url.includes('boardId=6') ? new Promise<Response>(() => {}) : json({ data: url.includes('boardId=') ? BOARD_STATUSES : OPTIONS }),
    });
    const user = userEvent.setup();
    render(<PsaAlertTicketingCard connectionId="c1" connectionName="CW" />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Service Board' })).toBeInTheDocument());
    await user.selectOptions(screen.getByTestId('psa-alert-ticketing-board'), '5');
    await waitFor(() => expect(screen.getAllByRole('option', { name: 'Done (closed)' })).toHaveLength(2));
    await user.selectOptions(screen.getByTestId('psa-alert-ticketing-board'), '6');
    expect(screen.queryAllByRole('option', { name: 'Done (closed)' })).toHaveLength(0);
  });

  it('clears statuses when the options fetch fails', async () => {
    install({
      view: makeView({ companyLinksConfirmed: true }),
      options: url =>
        url.includes('boardId=6') ? json({ error: 'PSA unavailable' }, 502) : json({ data: url.includes('boardId=') ? BOARD_STATUSES : OPTIONS }),
    });
    const user = userEvent.setup();
    render(<PsaAlertTicketingCard connectionId="c1" connectionName="CW" />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Service Board' })).toBeInTheDocument());
    await user.selectOptions(screen.getByTestId('psa-alert-ticketing-board'), '5');
    await waitFor(() => expect(screen.getAllByRole('option', { name: 'Done (closed)' })).toHaveLength(2));
    await user.selectOptions(screen.getByTestId('psa-alert-ticketing-board'), '6');
    await screen.findByTestId('psa-alert-ticketing-options-error');
    expect(screen.queryAllByRole('option', { name: 'Done (closed)' })).toHaveLength(0);
  });

  it('explains credentials_unusable', async () => {
    install({ view: makeView({ canManage: false, status: { active: false, reason: 'credentials_unusable' } }) });
    render(<PsaAlertTicketingCard connectionId="c1" connectionName="CW" />);
    expect(await screen.findByTestId('psa-alert-ticketing-status')).toHaveTextContent(
      "This connection's credentials are incomplete or unreadable. Edit the connection and re-enter them.",
    );
  });

  it('shows the partner-wide note, status, and paused banner', async () => {
    install({
      view: makeView({
        paused: { reason: 'auth', at: '2027-01-01T00:00:00Z' },
        status: { active: false, reason: 'paused' },
      }),
    });
    render(<PsaAlertTicketingCard connectionId="c1" connectionName="CW" />);
    expect(await screen.findByText('Partner-wide; no per-organization override.')).toBeInTheDocument();
    expect(screen.getByTestId('psa-alert-ticketing-paused')).toHaveTextContent(
      'Paused: the PSA rejected the credentials. Run Test connection to resume.',
    );
  });

  it('shows the bind hint for not_external and does not fetch options without canManage', async () => {
    install({
      view: makeView({ canManage: false, status: { active: false, reason: 'not_external' }, config: null }),
    });
    render(<PsaAlertTicketingCard connectionId="c1" connectionName="CW" />);
    expect(await screen.findByTestId('psa-alert-ticketing-status')).toHaveTextContent(
      'Bind this connection as the service-management PSA (external mode) to use alert tickets',
    );
    expect(screen.queryByTestId('psa-alert-ticketing-form')).not.toBeInTheDocument();
    expect(screen.getByTestId('psa-alert-ticketing-readonly-enabled')).toHaveTextContent('Off');
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/options'))).toBe(false);
  });

  it('active status does not promise tickets are being created', async () => {
    install({ view: makeView({ status: { active: true }, canManage: false, config: { ...baseConfig(), enabled: true } }) });
    render(<PsaAlertTicketingCard connectionId="c1" connectionName="CW" />);
    expect(await screen.findByTestId('psa-alert-ticketing-status')).toHaveTextContent(
      'Alert tickets are enabled for this connection',
    );
  });

  it('keeps Save disabled while enabling without board/statuses, then PUTs with confirmCompanyLinks and preserved fields', async () => {
    const recorded: Recorded[] = [];
    install({
      view: makeView({
        config: { ...baseConfig(), enabled: false, typeId: 77, hourlyCreateCap: 50, lookbackHours: 12, ruleIds: ['r1'] },
      }),
      recorded,
    });
    const user = userEvent.setup();
    render(<PsaAlertTicketingCard connectionId="c1" connectionName="CW" />);
    const save = await screen.findByTestId('psa-alert-ticketing-save');
    expect(save).toBeEnabled(); // disabled config can be saved as-is

    await user.click(screen.getByTestId('psa-alert-ticketing-enabled'));
    expect(save).toBeDisabled();

    await waitFor(() => expect(screen.getByRole('option', { name: 'Service Board' })).toBeInTheDocument());
    await user.selectOptions(screen.getByTestId('psa-alert-ticketing-board'), '5');
    await waitFor(() => expect(screen.getAllByRole('option', { name: 'Done (closed)' })).toHaveLength(2));
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/options?boardId=5`);
    await user.selectOptions(screen.getByTestId('psa-alert-ticketing-open-status'), '10');
    await user.selectOptions(screen.getByTestId('psa-alert-ticketing-closed-status'), '11');
    // Company links are unconfirmed: still blocked until the checkbox is ticked.
    expect(save).toBeDisabled();
    await user.click(screen.getByTestId('psa-alert-ticketing-confirm-links'));
    expect(save).toBeEnabled();

    await user.selectOptions(screen.getByTestId('psa-alert-ticketing-priority-critical'), '1');
    await user.selectOptions(screen.getByTestId('psa-alert-ticketing-min-severity'), 'medium');
    await user.click(screen.getByTestId('psa-alert-ticketing-close-on-resolve'));
    await user.click(save);

    await waitFor(() => expect(recorded).toHaveLength(1));
    expect(recorded[0].url).toBe(BASE);
    expect(recorded[0].body).toEqual({
      expectedRev: 3,
      confirmCompanyLinks: true,
      config: {
        enabled: true,
        boardId: 5,
        openStatusId: 10,
        closedStatusId: 11,
        typeId: 77,
        hourlyCreateCap: 50,
        lookbackHours: 12,
        ruleIds: ['r1'],
        priorityBySeverity: { critical: 1 },
        minSeverity: 'medium',
        closeOnResolve: true,
        noteOnAcknowledge: false,
      },
    });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
  });

  it('omits confirmCompanyLinks when links are already confirmed', async () => {
    const recorded: Recorded[] = [];
    install({
      view: makeView({
        companyLinksConfirmed: true,
        config: { ...baseConfig(), enabled: true, boardId: 5, openStatusId: 10, closedStatusId: 11 },
      }),
      recorded,
    });
    const user = userEvent.setup();
    render(<PsaAlertTicketingCard connectionId="c1" connectionName="CW" />);
    const save = await screen.findByTestId('psa-alert-ticketing-save');
    expect(screen.queryByTestId('psa-alert-ticketing-confirm-links')).not.toBeInTheDocument();
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await waitFor(() => expect(recorded).toHaveLength(1));
    expect(recorded[0].body).not.toHaveProperty('confirmCompanyLinks');
  });

  it('on a rev conflict toasts and refetches', async () => {
    const recorded: Recorded[] = [];
    install({
      view: makeView({ companyLinksConfirmed: true, config: { ...baseConfig(), enabled: false } }),
      put: json({ error: 'conflict', code: 'alert_ticketing_rev_conflict', currentRev: 9 }, 409),
      recorded,
    });
    const user = userEvent.setup();
    render(<PsaAlertTicketingCard connectionId="c1" connectionName="CW" />);
    await user.click(await screen.findByTestId('psa-alert-ticketing-save'));
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'warning', message: expect.stringContaining('changed elsewhere') }),
      ),
    );
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u, init]) => u === BASE && !init)).toHaveLength(2));
  });

  it('renders options errors inline with a working Retry', async () => {
    let calls = 0;
    install({
      view: makeView({ companyLinksConfirmed: true }),
      options: () => {
        calls += 1;
        return calls === 1
          ? json({ error: 'PSA unavailable', errorClass: 'network', detail: 'timed out' }, 502)
          : json({ data: OPTIONS });
      },
    });
    const user = userEvent.setup();
    render(<PsaAlertTicketingCard connectionId="c1" connectionName="CW" />);
    const banner = await screen.findByTestId('psa-alert-ticketing-options-error');
    expect(banner).toHaveTextContent('PSA unavailable');
    expect(banner).toHaveTextContent('timed out');
    await user.click(screen.getByTestId('psa-alert-ticketing-options-retry'));
    await waitFor(() => expect(screen.queryByTestId('psa-alert-ticketing-options-error')).not.toBeInTheDocument());
    expect(screen.getByRole('option', { name: 'Service Board' })).toBeInTheDocument();
  });

  it('notes when options were truncated', async () => {
    install({
      view: makeView(),
      options: json({ data: { ...OPTIONS, boards: { ...OPTIONS.boards, truncated: true } } }),
    });
    render(<PsaAlertTicketingCard connectionId="c1" connectionName="CW" />);
    expect(await screen.findByTestId('psa-alert-ticketing-truncated')).toBeInTheDocument();
  });
});

function baseConfig() {
  return {
    enabled: false,
    priorityBySeverity: {},
    minSeverity: 'low' as const,
    closeOnResolve: false,
    noteOnAcknowledge: false,
    hourlyCreateCap: 100,
    lookbackHours: 24,
  };
}
