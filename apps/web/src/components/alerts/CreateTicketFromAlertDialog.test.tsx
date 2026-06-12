import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CreateTicketFromAlertDialog, { SEVERITY_TO_PRIORITY, orderCategoriesForSelect } from './CreateTicketFromAlertDialog';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

const fetchMock = vi.mocked(fetchWithAuth);

const ALERT_ID = '5d4c3b2a-1111-4222-8333-444455556666';
const CAT_ID = 'aaaaaaaa-1111-4222-8333-444455556666';

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

function mockApi() {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/ticket-categories' && !init?.method) {
      return makeJsonResponse({
        data: [
          { id: CAT_ID, name: 'Hardware', parentId: null, isActive: true, sortOrder: 0 },
          { id: 'inactive-1', name: 'Retired', parentId: null, isActive: false, sortOrder: 1 }
        ]
      });
    }
    if (url === `/alerts/${ALERT_ID}/create-ticket` && init?.method === 'POST') {
      return makeJsonResponse({ data: { id: 't-1', internalNumber: 'T-2026-0099' } }, true, 201);
    }
    return makeJsonResponse({ error: 'unexpected' }, false, 404);
  });
}

const baseProps = {
  alertId: ALERT_ID,
  alertTitle: 'CPU pegged on SRV-01',
  alertSeverity: 'critical',
  openTicketNumber: null as string | null,
  onClose: vi.fn(),
  onCreated: vi.fn()
};

describe('CreateTicketFromAlertDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps severity to priority', () => {
    expect(SEVERITY_TO_PRIORITY.critical).toBe('urgent');
    expect(SEVERITY_TO_PRIORITY.medium).toBe('normal');
    expect(SEVERITY_TO_PRIORITY.info).toBe('low');
  });

  it('prefills subject from the alert title and priority from severity', async () => {
    mockApi();
    render(<CreateTicketFromAlertDialog {...baseProps} />);
    expect((screen.getByTestId('alert-ticket-subject') as HTMLInputElement).value).toBe('CPU pegged on SRV-01');
    expect((screen.getByTestId('alert-ticket-priority') as HTMLSelectElement).value).toBe('urgent');
    // Inactive categories are not offered
    await waitFor(() => expect(screen.getByTestId('alert-ticket-category')).toBeInTheDocument());
    expect(screen.queryByText('Retired')).not.toBeInTheDocument();
  });

  it('POSTs subject/priority/categoryId and calls onCreated', async () => {
    mockApi();
    render(<CreateTicketFromAlertDialog {...baseProps} />);
    await waitFor(() => expect(screen.getByText('Hardware')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('alert-ticket-category'), { target: { value: CAT_ID } });
    fireEvent.click(screen.getByTestId('alert-ticket-submit'));

    await waitFor(() => expect(baseProps.onCreated).toHaveBeenCalled());
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    const body = JSON.parse(String(postCall![1]!.body));
    expect(body).toEqual({ subject: 'CPU pegged on SRV-01', priority: 'urgent', categoryId: CAT_ID });
  });

  it('omits categoryId when none selected', async () => {
    mockApi();
    render(<CreateTicketFromAlertDialog {...baseProps} />);
    fireEvent.click(screen.getByTestId('alert-ticket-submit'));
    await waitFor(() => expect(baseProps.onCreated).toHaveBeenCalled());
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(postCall![1]!.body))).not.toHaveProperty('categoryId');
  });

  it('shows a duplicate warning when an open linked ticket exists (but still allows creating)', async () => {
    mockApi();
    render(<CreateTicketFromAlertDialog {...baseProps} openTicketNumber="T-2026-0042" />);
    expect(screen.getByTestId('alert-ticket-duplicate-warning').textContent).toContain('T-2026-0042');
    expect(screen.getByTestId('alert-ticket-submit')).not.toBeDisabled();
  });

  it('disables submit when the subject is emptied', async () => {
    mockApi();
    render(<CreateTicketFromAlertDialog {...baseProps} />);
    fireEvent.change(screen.getByTestId('alert-ticket-subject'), { target: { value: '   ' } });
    expect(screen.getByTestId('alert-ticket-submit')).toBeDisabled();
  });

  it('does not call onCreated when the POST fails (runAction toasts)', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === 'POST') return makeJsonResponse({ error: 'nope' }, false, 500);
      return makeJsonResponse({ data: [] });
    });
    render(<CreateTicketFromAlertDialog {...baseProps} />);
    fireEvent.click(screen.getByTestId('alert-ticket-submit'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(baseProps.onCreated).not.toHaveBeenCalled();
  });

  it('shows a neutral notice when the duplicate check failed (no false "no duplicates")', async () => {
    mockApi();
    render(<CreateTicketFromAlertDialog {...baseProps} duplicateCheckFailed />);
    expect(screen.getByTestId('alert-ticket-duplicate-check-failed')).toBeInTheDocument();
    expect(screen.queryByTestId('alert-ticket-duplicate-warning')).not.toBeInTheDocument();
    expect(screen.getByTestId('alert-ticket-submit')).not.toBeDisabled();
  });

  it('open-ticket warning takes precedence over the failed-check notice', async () => {
    mockApi();
    render(<CreateTicketFromAlertDialog {...baseProps} openTicketNumber="T-2026-0042" duplicateCheckFailed />);
    expect(screen.getByTestId('alert-ticket-duplicate-warning')).toBeInTheDocument();
    expect(screen.queryByTestId('alert-ticket-duplicate-check-failed')).not.toBeInTheDocument();
  });

  it('shows a retry hint when categories fail to load (creation stays unblocked)', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/ticket-categories' && !init?.method) {
        return makeJsonResponse({ error: 'boom' }, false, 500);
      }
      return makeJsonResponse({ error: 'unexpected' }, false, 404);
    });
    render(<CreateTicketFromAlertDialog {...baseProps} />);
    await waitFor(() => expect(screen.getByTestId('alert-ticket-categories-failed')).toBeInTheDocument());
    expect(screen.getByTestId('alert-ticket-submit')).not.toBeDisabled();
  });
});

describe('orderCategoriesForSelect', () => {
  it('regroups children under their parent regardless of input order; orphans render as roots', () => {
    const cats = [
      { id: 'child', name: 'Printers', parentId: 'root', isActive: true },
      { id: 'root', name: 'Hardware', parentId: null, isActive: true },
      { id: 'orphan', name: 'Lost', parentId: 'missing', isActive: true }
    ];
    expect(orderCategoriesForSelect(cats).map((c) => `${c.depth}:${c.id}`)).toEqual([
      '0:root', '1:child', '0:orphan'
    ]);
  });
});
