import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TicketPrioritiesTab from './TicketPrioritiesTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

vi.mock('../../lib/authScope', () => ({
  loginPathWithNext: () => '/login?next=%2Fsettings%2Ftickets'
}));

const invalidateTicketConfig = vi.fn();
vi.mock('../../lib/ticketConfigApi', () => ({
  invalidateTicketConfig: () => invalidateTicketConfig()
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

const FETCHED_PRIORITIES = {
  urgent: { label: 'Critical', responseSlaMinutes: 30, resolutionSlaMinutes: 120 },
  high:   { label: null,       responseSlaMinutes: 240, resolutionSlaMinutes: 1440 },
  normal: { label: null,       responseSlaMinutes: null, resolutionSlaMinutes: null },
  low:    { label: null,       responseSlaMinutes: null, resolutionSlaMinutes: null },
};

function mockGetPriorities(priorities: unknown) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/ticket-config' && (!init?.method || init.method === 'GET')) {
      return makeJsonResponse({ data: { statuses: [], priorities } });
    }
    if (url === '/ticket-config/priorities' && init?.method === 'PUT') {
      return makeJsonResponse({ data: { priorities } });
    }
    return makeJsonResponse({ error: 'unexpected' }, false, 404);
  });
}

describe('TicketPrioritiesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('renders fetched values', () => {
    it('pre-fills label input with fetched label', async () => {
      mockGetPriorities(FETCHED_PRIORITIES);
      render(<TicketPrioritiesTab />);

      const urgentLabel = await screen.findByTestId('priority-label-urgent') as HTMLInputElement;
      expect(urgentLabel.value).toBe('Critical');
    });

    it('pre-fills response input with fetched minutes as string', async () => {
      mockGetPriorities(FETCHED_PRIORITIES);
      render(<TicketPrioritiesTab />);

      const urgentResponse = await screen.findByTestId('priority-response-urgent') as HTMLInputElement;
      expect(urgentResponse.value).toBe('30');
    });

    it('pre-fills resolution input with fetched minutes as string', async () => {
      mockGetPriorities(FETCHED_PRIORITIES);
      render(<TicketPrioritiesTab />);

      const urgentResolution = await screen.findByTestId('priority-resolution-urgent') as HTMLInputElement;
      expect(urgentResolution.value).toBe('120');
    });

    it('leaves inputs blank when fetched value is null', async () => {
      mockGetPriorities(FETCHED_PRIORITIES);
      render(<TicketPrioritiesTab />);

      const normalResponse = await screen.findByTestId('priority-response-normal') as HTMLInputElement;
      expect(normalResponse.value).toBe('');

      const lowResolution = screen.getByTestId('priority-resolution-low') as HTMLInputElement;
      expect(lowResolution.value).toBe('');
    });

    it('renders all four priority rows', async () => {
      mockGetPriorities(FETCHED_PRIORITIES);
      render(<TicketPrioritiesTab />);

      await screen.findByTestId('priority-row-urgent');
      expect(screen.getByTestId('priority-row-high')).toBeInTheDocument();
      expect(screen.getByTestId('priority-row-normal')).toBeInTheDocument();
      expect(screen.getByTestId('priority-row-low')).toBeInTheDocument();
    });

    it('renders all required testids', async () => {
      mockGetPriorities(FETCHED_PRIORITIES);
      render(<TicketPrioritiesTab />);

      await screen.findByTestId('priorities-save');
      for (const p of ['urgent', 'high', 'normal', 'low']) {
        expect(screen.getByTestId(`priority-label-${p}`)).toBeInTheDocument();
        expect(screen.getByTestId(`priority-response-${p}`)).toBeInTheDocument();
        expect(screen.getByTestId(`priority-resolution-${p}`)).toBeInTheDocument();
      }
    });

    it('renders the precedence note', async () => {
      mockGetPriorities(FETCHED_PRIORITIES);
      render(<TicketPrioritiesTab />);

      await screen.findByTestId('priorities-save');
      expect(screen.getByText(/Order of precedence: category SLA → org override → these defaults/)).toBeInTheDocument();
    });
  });

  describe('save — PUTs the correct body shape', () => {
    it('sends full four-priority object with parsed integers', async () => {
      mockGetPriorities(FETCHED_PRIORITIES);
      render(<TicketPrioritiesTab />);

      await screen.findByTestId('priorities-save');

      // Change urgent label
      fireEvent.change(screen.getByTestId('priority-label-urgent'), { target: { value: 'P1' } });
      // Change normal response to a number
      fireEvent.change(screen.getByTestId('priority-response-normal'), { target: { value: '120' } });

      let putBody: Record<string, unknown> = {};
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === '/ticket-config' && (!init?.method || init.method === 'GET')) {
          return makeJsonResponse({ data: { statuses: [], priorities: FETCHED_PRIORITIES } });
        }
        if (url === '/ticket-config/priorities' && init?.method === 'PUT') {
          putBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          return makeJsonResponse({ data: {} });
        }
        return makeJsonResponse({ error: 'unexpected' }, false, 404);
      });

      fireEvent.click(screen.getByTestId('priorities-save'));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/ticket-config/priorities',
          expect.objectContaining({ method: 'PUT' })
        );
      });

      const sent = putBody.priorities as Record<string, unknown>;
      expect(sent).toBeDefined();
      // All four priorities present
      expect(Object.keys(sent)).toHaveLength(4);
      // label change applied
      expect((sent.urgent as Record<string, unknown>).label).toBe('P1');
      // number parsed as int
      expect((sent.normal as Record<string, unknown>).responseSlaMinutes).toBe(120);
    });

    it('sends null for blank label input', async () => {
      mockGetPriorities({
        urgent: { label: null, responseSlaMinutes: null, resolutionSlaMinutes: null },
        high:   { label: null, responseSlaMinutes: null, resolutionSlaMinutes: null },
        normal: { label: null, responseSlaMinutes: null, resolutionSlaMinutes: null },
        low:    { label: null, responseSlaMinutes: null, resolutionSlaMinutes: null },
      });
      render(<TicketPrioritiesTab />);

      await screen.findByTestId('priorities-save');

      // Verify urgent label is blank
      const urgentLabel = screen.getByTestId('priority-label-urgent') as HTMLInputElement;
      expect(urgentLabel.value).toBe('');

      let putBody: Record<string, unknown> = {};
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === '/ticket-config' && (!init?.method || init.method === 'GET')) {
          return makeJsonResponse({ data: { statuses: [], priorities: {} } });
        }
        if (url === '/ticket-config/priorities' && init?.method === 'PUT') {
          putBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          return makeJsonResponse({ data: {} });
        }
        return makeJsonResponse({ error: 'unexpected' }, false, 404);
      });

      fireEvent.click(screen.getByTestId('priorities-save'));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/ticket-config/priorities',
          expect.objectContaining({ method: 'PUT' })
        );
      });

      const sent = putBody.priorities as Record<string, unknown>;
      expect((sent.urgent as Record<string, unknown>).label).toBeNull();
    });

    it('sends null for blank minutes input', async () => {
      mockGetPriorities(FETCHED_PRIORITIES);
      render(<TicketPrioritiesTab />);

      await screen.findByTestId('priorities-save');

      // Clear urgent response
      fireEvent.change(screen.getByTestId('priority-response-urgent'), { target: { value: '' } });

      let putBody: Record<string, unknown> = {};
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === '/ticket-config' && (!init?.method || init.method === 'GET')) {
          return makeJsonResponse({ data: { statuses: [], priorities: FETCHED_PRIORITIES } });
        }
        if (url === '/ticket-config/priorities' && init?.method === 'PUT') {
          putBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          return makeJsonResponse({ data: {} });
        }
        return makeJsonResponse({ error: 'unexpected' }, false, 404);
      });

      fireEvent.click(screen.getByTestId('priorities-save'));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/ticket-config/priorities',
          expect.objectContaining({ method: 'PUT' })
        );
      });

      const sent = putBody.priorities as Record<string, unknown>;
      expect((sent.urgent as Record<string, unknown>).responseSlaMinutes).toBeNull();
    });

    it('calls invalidateTicketConfig after successful save', async () => {
      mockGetPriorities(FETCHED_PRIORITIES);
      render(<TicketPrioritiesTab />);

      await screen.findByTestId('priorities-save');
      fireEvent.click(screen.getByTestId('priorities-save'));

      await waitFor(() => {
        expect(invalidateTicketConfig).toHaveBeenCalled();
      });
    });
  });

  describe('non-admin 403', () => {
    it('surfaces API error message via toast on 403', async () => {
      mockGetPriorities(FETCHED_PRIORITIES);
      render(<TicketPrioritiesTab />);

      await screen.findByTestId('priorities-save');

      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === '/ticket-config' && (!init?.method || init.method === 'GET')) {
          return makeJsonResponse({ data: { statuses: [], priorities: FETCHED_PRIORITIES } });
        }
        if (url === '/ticket-config/priorities' && init?.method === 'PUT') {
          return makeJsonResponse(
            { error: 'Managing ticket configuration requires an admin role' },
            false,
            403
          );
        }
        return makeJsonResponse({ error: 'unexpected' }, false, 404);
      });

      fireEvent.click(screen.getByTestId('priorities-save'));

      await waitFor(() => {
        expect(showToast).toHaveBeenCalledWith({
          type: 'error',
          message: 'Managing ticket configuration requires an admin role'
        });
      });
    });
  });

  describe('loading and error states', () => {
    it('shows loading state initially', () => {
      fetchMock.mockImplementation(() => new Promise(() => {})); // never resolves
      render(<TicketPrioritiesTab />);
      expect(screen.getByTestId('ticket-priorities-loading')).toBeInTheDocument();
    });

    it('shows error state on fetch failure with retry button', async () => {
      fetchMock.mockResolvedValue(makeJsonResponse({ error: 'boom' }, false, 500));
      render(<TicketPrioritiesTab />);
      await screen.findByTestId('ticket-priorities-error');
      expect(screen.getByTestId('ticket-priorities-retry')).toBeInTheDocument();
    });

    it('retry button reloads priorities', async () => {
      fetchMock.mockResolvedValue(makeJsonResponse({ error: 'boom' }, false, 500));
      render(<TicketPrioritiesTab />);
      await screen.findByTestId('ticket-priorities-retry');

      mockGetPriorities(FETCHED_PRIORITIES);
      fireEvent.click(screen.getByTestId('ticket-priorities-retry'));
      await screen.findByTestId('priorities-save');
      expect(screen.queryByTestId('ticket-priorities-error')).toBeNull();
    });
  });
});
