import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TicketStatusesTab, { moveFlatList, type StatusRow } from './TicketStatusesTab';
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

const STATUS_NEW_SYSTEM = {
  id: 's-new', partnerId: 'p1', name: 'New', coreStatus: 'new' as const,
  color: '#1c8a9e', sortOrder: 0, isSystem: true, isActive: true
} satisfies StatusRow;
const STATUS_OPEN_SYSTEM = {
  id: 's-open', partnerId: 'p1', name: 'Open', coreStatus: 'open' as const,
  color: '#00aa00', sortOrder: 1, isSystem: true, isActive: true
} satisfies StatusRow;
const STATUS_CUSTOM_OPEN = {
  id: 's-custom', partnerId: 'p1', name: 'In Progress', coreStatus: 'open' as const,
  color: '#aabbcc', sortOrder: 2, isSystem: false, isActive: true
} satisfies StatusRow;
const STATUS_INACTIVE = {
  id: 's-inactive', partnerId: 'p1', name: 'Dormant', coreStatus: 'pending' as const,
  color: null, sortOrder: 3, isSystem: false, isActive: false
} satisfies StatusRow;

function mockGetStatuses(statuses: unknown[]) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/ticket-config' && (!init?.method || init.method === 'GET')) {
      return makeJsonResponse({ data: { statuses, priorities: {} } });
    }
    if (url === '/ticket-config/statuses' && init?.method === 'POST') {
      return makeJsonResponse({ data: { id: 'new-id', ...((statuses[0] as object) ?? {}) } }, true, 201);
    }
    if (url.match(/\/ticket-config\/statuses\/.+/) && init?.method === 'PATCH') {
      return makeJsonResponse({ data: {} });
    }
    if (url === '/ticket-config/statuses/reorder' && init?.method === 'POST') {
      return makeJsonResponse({ data: {} });
    }
    return makeJsonResponse({ error: 'unexpected' }, false, 404);
  });
}

describe('TicketStatusesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('groups render', () => {
    it('renders groups from mocked GET, grouped by coreStatus', async () => {
      mockGetStatuses([STATUS_NEW_SYSTEM, STATUS_OPEN_SYSTEM, STATUS_CUSTOM_OPEN]);
      render(<TicketStatusesTab />);

      // Wait for rows to appear
      await screen.findByTestId(`status-row-${STATUS_NEW_SYSTEM.id}`);
      expect(screen.getByTestId(`status-row-${STATUS_OPEN_SYSTEM.id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`status-row-${STATUS_CUSTOM_OPEN.id}`)).toBeInTheDocument();

      // Groups should be present for the statuses' coreStatuses
      expect(screen.getByTestId('status-group-new')).toBeInTheDocument();
      expect(screen.getByTestId('status-group-open')).toBeInTheDocument();
    });

    it('renders "new" group header before "open" group (canonical order)', async () => {
      mockGetStatuses([STATUS_NEW_SYSTEM, STATUS_OPEN_SYSTEM]);
      render(<TicketStatusesTab />);

      await screen.findByTestId('status-group-new');
      const newGroup = screen.getByTestId('status-group-new');
      const openGroup = screen.getByTestId('status-group-open');

      // new should appear before open in DOM
      expect(
        newGroup.compareDocumentPosition(openGroup) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });

    it('renders system badge for isSystem rows', async () => {
      mockGetStatuses([STATUS_NEW_SYSTEM]);
      render(<TicketStatusesTab />);

      await screen.findByTestId(`status-system-badge-${STATUS_NEW_SYSTEM.id}`);
    });

    it('does not render system badge for non-system rows', async () => {
      mockGetStatuses([STATUS_CUSTOM_OPEN]);
      render(<TicketStatusesTab />);

      await screen.findByTestId(`status-row-${STATUS_CUSTOM_OPEN.id}`);
      expect(screen.queryByTestId(`status-system-badge-${STATUS_CUSTOM_OPEN.id}`)).toBeNull();
    });

    it('shows Inactive badge for inactive statuses', async () => {
      mockGetStatuses([STATUS_INACTIVE]);
      render(<TicketStatusesTab />);

      await screen.findByTestId(`status-row-${STATUS_INACTIVE.id}`);
      const row = screen.getByTestId(`status-row-${STATUS_INACTIVE.id}`);
      expect(row.textContent).toContain('Inactive');
    });
  });

  describe('add form', () => {
    it('is hidden by default', () => {
      mockGetStatuses([]);
      render(<TicketStatusesTab />);
      expect(screen.queryByTestId('status-form-name')).toBeNull();
    });

    it('toggles open on add-toggle click', async () => {
      mockGetStatuses([]);
      render(<TicketStatusesTab />);
      fireEvent.click(screen.getByTestId('status-add-toggle'));
      expect(screen.getByTestId('status-form-name')).toBeInTheDocument();
      expect(screen.getByTestId('status-form-core')).toBeInTheDocument();
      expect(screen.getByTestId('status-form-color')).toBeInTheDocument();
      expect(screen.getByTestId('status-form-submit')).toBeInTheDocument();
    });

    it('submit is disabled when name is empty', async () => {
      mockGetStatuses([]);
      render(<TicketStatusesTab />);
      fireEvent.click(screen.getByTestId('status-add-toggle'));
      expect(screen.getByTestId('status-form-submit')).toBeDisabled();
    });

    it('POSTs correct body on add', async () => {
      mockGetStatuses([STATUS_CUSTOM_OPEN]);
      render(<TicketStatusesTab />);
      fireEvent.click(screen.getByTestId('status-add-toggle'));

      fireEvent.change(screen.getByTestId('status-form-name'), { target: { value: 'Waiting' } });
      fireEvent.change(screen.getByTestId('status-form-core'), { target: { value: 'pending' } });

      let postBody: Record<string, unknown> = {};
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === '/ticket-config' && (!init?.method || init.method === 'GET')) {
          return makeJsonResponse({ data: { statuses: [STATUS_CUSTOM_OPEN], priorities: {} } });
        }
        if (url === '/ticket-config/statuses' && init?.method === 'POST') {
          postBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          return makeJsonResponse({ data: { id: 'new-id' } }, true, 201);
        }
        return makeJsonResponse({ error: 'unexpected' }, false, 404);
      });

      fireEvent.click(screen.getByTestId('status-form-submit'));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/ticket-config/statuses',
          expect.objectContaining({ method: 'POST' })
        );
      });

      expect(postBody.name).toBe('Waiting');
      expect(postBody.coreStatus).toBe('pending');
      expect(postBody).toHaveProperty('color');
    });

    it('calls invalidateTicketConfig after successful add', async () => {
      mockGetStatuses([]);
      render(<TicketStatusesTab />);
      fireEvent.click(screen.getByTestId('status-add-toggle'));
      fireEvent.change(screen.getByTestId('status-form-name'), { target: { value: 'Waiting' } });
      fireEvent.click(screen.getByTestId('status-form-submit'));

      await waitFor(() => {
        expect(invalidateTicketConfig).toHaveBeenCalled();
      });
    });
  });

  describe('reorder', () => {
    it('POSTs full ids array (flat across groups) on move-down', async () => {
      // s-new (sortOrder 0, new) and s-custom (sortOrder 2, open)
      mockGetStatuses([STATUS_NEW_SYSTEM, STATUS_CUSTOM_OPEN]);
      render(<TicketStatusesTab />);

      await screen.findByTestId(`status-down-${STATUS_NEW_SYSTEM.id}`);

      let postBody: Record<string, unknown> = {};
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === '/ticket-config' && (!init?.method || init.method === 'GET')) {
          return makeJsonResponse({ data: { statuses: [STATUS_NEW_SYSTEM, STATUS_CUSTOM_OPEN], priorities: {} } });
        }
        if (url === '/ticket-config/statuses/reorder' && init?.method === 'POST') {
          postBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          return makeJsonResponse({ data: {} });
        }
        return makeJsonResponse({ error: 'unexpected' }, false, 404);
      });

      fireEvent.click(screen.getByTestId(`status-down-${STATUS_NEW_SYSTEM.id}`));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/ticket-config/statuses/reorder',
          expect.objectContaining({ method: 'POST' })
        );
      });

      // Full flat ids array — swapped order
      expect(postBody.ids).toEqual([STATUS_CUSTOM_OPEN.id, STATUS_NEW_SYSTEM.id]);
    });

    it('disables up arrow on first item and down arrow on last item', async () => {
      mockGetStatuses([STATUS_NEW_SYSTEM, STATUS_CUSTOM_OPEN]);
      render(<TicketStatusesTab />);

      await screen.findByTestId(`status-up-${STATUS_NEW_SYSTEM.id}`);
      expect(screen.getByTestId(`status-up-${STATUS_NEW_SYSTEM.id}`)).toBeDisabled();
      expect(screen.getByTestId(`status-down-${STATUS_NEW_SYSTEM.id}`)).not.toBeDisabled();
      expect(screen.getByTestId(`status-down-${STATUS_CUSTOM_OPEN.id}`)).toBeDisabled();
    });

    it('calls invalidateTicketConfig after successful reorder', async () => {
      mockGetStatuses([STATUS_NEW_SYSTEM, STATUS_CUSTOM_OPEN]);
      render(<TicketStatusesTab />);

      await screen.findByTestId(`status-down-${STATUS_NEW_SYSTEM.id}`);
      fireEvent.click(screen.getByTestId(`status-down-${STATUS_NEW_SYSTEM.id}`));

      await waitFor(() => {
        expect(invalidateTicketConfig).toHaveBeenCalled();
      });
    });
  });

  describe('isSystem rows', () => {
    it('hides Deactivate button for isSystem rows', async () => {
      mockGetStatuses([STATUS_NEW_SYSTEM]);
      render(<TicketStatusesTab />);

      await screen.findByTestId(`status-row-${STATUS_NEW_SYSTEM.id}`);
      expect(screen.queryByTestId(`status-toggle-${STATUS_NEW_SYSTEM.id}`)).toBeNull();
    });

    it('shows Deactivate button for non-system rows', async () => {
      mockGetStatuses([STATUS_CUSTOM_OPEN]);
      render(<TicketStatusesTab />);

      await screen.findByTestId(`status-toggle-${STATUS_CUSTOM_OPEN.id}`);
    });

    it('disables core-state select in edit for isSystem rows', async () => {
      mockGetStatuses([STATUS_NEW_SYSTEM]);
      render(<TicketStatusesTab />);

      await screen.findByTestId(`status-edit-${STATUS_NEW_SYSTEM.id}`);
      fireEvent.click(screen.getByTestId(`status-edit-${STATUS_NEW_SYSTEM.id}`));

      const coreSelect = screen.getByTestId(`status-edit-core-${STATUS_NEW_SYSTEM.id}`);
      expect(coreSelect).toBeDisabled();
    });

    it('enables core-state select in edit for non-system rows', async () => {
      mockGetStatuses([STATUS_CUSTOM_OPEN]);
      render(<TicketStatusesTab />);

      await screen.findByTestId(`status-edit-${STATUS_CUSTOM_OPEN.id}`);
      fireEvent.click(screen.getByTestId(`status-edit-${STATUS_CUSTOM_OPEN.id}`));

      const coreSelect = screen.getByTestId(`status-edit-core-${STATUS_CUSTOM_OPEN.id}`);
      expect(coreSelect).not.toBeDisabled();
    });
  });

  describe('edit flow', () => {
    it('edit form pre-fills from row data', async () => {
      mockGetStatuses([STATUS_CUSTOM_OPEN]);
      render(<TicketStatusesTab />);

      await screen.findByTestId(`status-edit-${STATUS_CUSTOM_OPEN.id}`);
      fireEvent.click(screen.getByTestId(`status-edit-${STATUS_CUSTOM_OPEN.id}`));

      const nameInput = screen.getByTestId(`status-edit-name-${STATUS_CUSTOM_OPEN.id}`) as HTMLInputElement;
      expect(nameInput.value).toBe(STATUS_CUSTOM_OPEN.name);

      const coreSelect = screen.getByTestId(`status-edit-core-${STATUS_CUSTOM_OPEN.id}`) as HTMLSelectElement;
      expect(coreSelect.value).toBe(STATUS_CUSTOM_OPEN.coreStatus);
    });

    it('PATCHes correct body on save', async () => {
      mockGetStatuses([STATUS_CUSTOM_OPEN]);
      render(<TicketStatusesTab />);

      await screen.findByTestId(`status-edit-${STATUS_CUSTOM_OPEN.id}`);
      fireEvent.click(screen.getByTestId(`status-edit-${STATUS_CUSTOM_OPEN.id}`));

      fireEvent.change(screen.getByTestId(`status-edit-name-${STATUS_CUSTOM_OPEN.id}`), {
        target: { value: 'Working On It' }
      });

      let patchBody: Record<string, unknown> = {};
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === '/ticket-config' && (!init?.method || init.method === 'GET')) {
          return makeJsonResponse({ data: { statuses: [STATUS_CUSTOM_OPEN], priorities: {} } });
        }
        if (url === `/ticket-config/statuses/${STATUS_CUSTOM_OPEN.id}` && init?.method === 'PATCH') {
          patchBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          return makeJsonResponse({ data: {} });
        }
        return makeJsonResponse({ error: 'unexpected' }, false, 404);
      });

      fireEvent.click(screen.getByTestId(`status-save-${STATUS_CUSTOM_OPEN.id}`));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          `/ticket-config/statuses/${STATUS_CUSTOM_OPEN.id}`,
          expect.objectContaining({ method: 'PATCH' })
        );
      });

      expect(patchBody.name).toBe('Working On It');
      expect(patchBody.coreStatus).toBe(STATUS_CUSTOM_OPEN.coreStatus);
    });

    it('does not include coreStatus in PATCH body for isSystem rows', async () => {
      mockGetStatuses([STATUS_NEW_SYSTEM]);
      render(<TicketStatusesTab />);

      await screen.findByTestId(`status-edit-${STATUS_NEW_SYSTEM.id}`);
      fireEvent.click(screen.getByTestId(`status-edit-${STATUS_NEW_SYSTEM.id}`));

      fireEvent.change(screen.getByTestId(`status-edit-name-${STATUS_NEW_SYSTEM.id}`), {
        target: { value: 'Fresh' }
      });

      let patchBody: Record<string, unknown> = {};
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === '/ticket-config' && (!init?.method || init.method === 'GET')) {
          return makeJsonResponse({ data: { statuses: [STATUS_NEW_SYSTEM], priorities: {} } });
        }
        if (url === `/ticket-config/statuses/${STATUS_NEW_SYSTEM.id}` && init?.method === 'PATCH') {
          patchBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          return makeJsonResponse({ data: {} });
        }
        return makeJsonResponse({ error: 'unexpected' }, false, 404);
      });

      fireEvent.click(screen.getByTestId(`status-save-${STATUS_NEW_SYSTEM.id}`));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          `/ticket-config/statuses/${STATUS_NEW_SYSTEM.id}`,
          expect.objectContaining({ method: 'PATCH' })
        );
      });

      expect(patchBody).not.toHaveProperty('coreStatus');
    });

    it('closes edit panel on cancel without saving', async () => {
      mockGetStatuses([STATUS_CUSTOM_OPEN]);
      render(<TicketStatusesTab />);

      await screen.findByTestId(`status-edit-${STATUS_CUSTOM_OPEN.id}`);
      fireEvent.click(screen.getByTestId(`status-edit-${STATUS_CUSTOM_OPEN.id}`));

      expect(screen.getByTestId(`status-edit-name-${STATUS_CUSTOM_OPEN.id}`)).toBeInTheDocument();

      fireEvent.click(screen.getByTestId(`status-cancel-${STATUS_CUSTOM_OPEN.id}`));

      expect(screen.queryByTestId(`status-edit-name-${STATUS_CUSTOM_OPEN.id}`)).toBeNull();

      expect(fetchMock).not.toHaveBeenCalledWith(
        expect.stringContaining('/ticket-config/statuses/'),
        expect.objectContaining({ method: 'PATCH' })
      );
    });

    it('calls invalidateTicketConfig after successful edit', async () => {
      mockGetStatuses([STATUS_CUSTOM_OPEN]);
      render(<TicketStatusesTab />);

      await screen.findByTestId(`status-edit-${STATUS_CUSTOM_OPEN.id}`);
      fireEvent.click(screen.getByTestId(`status-edit-${STATUS_CUSTOM_OPEN.id}`));

      fireEvent.click(screen.getByTestId(`status-save-${STATUS_CUSTOM_OPEN.id}`));

      await waitFor(() => {
        expect(invalidateTicketConfig).toHaveBeenCalled();
      });
    });
  });

  describe('STATUS_NAME_TAKEN error path', () => {
    it('shows friendly message when STATUS_NAME_TAKEN code is returned', async () => {
      mockGetStatuses([]);
      render(<TicketStatusesTab />);
      fireEvent.click(screen.getByTestId('status-add-toggle'));
      fireEvent.change(screen.getByTestId('status-form-name'), { target: { value: 'Duplicate' } });

      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === '/ticket-config' && (!init?.method || init.method === 'GET')) {
          return makeJsonResponse({ data: { statuses: [], priorities: {} } });
        }
        if (url === '/ticket-config/statuses' && init?.method === 'POST') {
          return makeJsonResponse(
            { error: 'Status name already taken', code: 'STATUS_NAME_TAKEN' },
            false,
            422
          );
        }
        return makeJsonResponse({ error: 'unexpected' }, false, 404);
      });

      fireEvent.click(screen.getByTestId('status-form-submit'));

      await waitFor(() => {
        expect(showToast).toHaveBeenCalledWith({
          type: 'error',
          message: 'A status with that name already exists.'
        });
      });
    });
  });

  describe('loading and error states', () => {
    it('shows loading state initially', () => {
      fetchMock.mockImplementation(() => new Promise(() => {})); // never resolves
      render(<TicketStatusesTab />);
      expect(screen.getByTestId('ticket-statuses-loading')).toBeInTheDocument();
    });

    it('shows error state on fetch failure with retry button', async () => {
      fetchMock.mockResolvedValue(makeJsonResponse({ error: 'boom' }, false, 500));
      render(<TicketStatusesTab />);
      await screen.findByTestId('ticket-statuses-error');
      expect(screen.getByTestId('ticket-statuses-retry')).toBeInTheDocument();
    });

    it('retry button reloads statuses', async () => {
      fetchMock.mockResolvedValue(makeJsonResponse({ error: 'boom' }, false, 500));
      render(<TicketStatusesTab />);
      await screen.findByTestId('ticket-statuses-retry');

      mockGetStatuses([STATUS_NEW_SYSTEM]);
      fireEvent.click(screen.getByTestId('ticket-statuses-retry'));
      await screen.findByTestId(`status-row-${STATUS_NEW_SYSTEM.id}`);
      expect(screen.queryByTestId('ticket-statuses-error')).toBeNull();
    });
  });
});

describe('moveFlatList', () => {
  const statuses = [
    { ...STATUS_NEW_SYSTEM, sortOrder: 0 },
    { ...STATUS_OPEN_SYSTEM, sortOrder: 1 },
    { ...STATUS_CUSTOM_OPEN, sortOrder: 2 },
  ];

  it('moves an item down: swaps with the next item in flat list', () => {
    expect(moveFlatList(statuses, STATUS_NEW_SYSTEM.id, 1)).toEqual([
      STATUS_OPEN_SYSTEM.id, STATUS_NEW_SYSTEM.id, STATUS_CUSTOM_OPEN.id
    ]);
  });

  it('moves an item up', () => {
    expect(moveFlatList(statuses, STATUS_CUSTOM_OPEN.id, -1)).toEqual([
      STATUS_NEW_SYSTEM.id, STATUS_CUSTOM_OPEN.id, STATUS_OPEN_SYSTEM.id
    ]);
  });

  it('returns null at the top edge', () => {
    expect(moveFlatList(statuses, STATUS_NEW_SYSTEM.id, -1)).toBeNull();
  });

  it('returns null at the bottom edge', () => {
    expect(moveFlatList(statuses, STATUS_CUSTOM_OPEN.id, 1)).toBeNull();
  });

  it('returns null for unknown id', () => {
    expect(moveFlatList(statuses, 'nonexistent', 1)).toBeNull();
  });
});
