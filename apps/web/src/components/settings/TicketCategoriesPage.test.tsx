import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TicketCategoriesPage from './TicketCategoriesPage';
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

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

const CAT_PARENT = {
  id: 'p1', name: 'Hardware', color: '#ff0000', parentId: null,
  defaultPriority: null, responseSlaMinutes: null, resolutionSlaMinutes: null,
  defaultBillable: false, defaultHourlyRate: null, sortOrder: 0, isActive: true
};
const CAT_CHILD = {
  id: 'c1', name: 'Printers', color: '#00ff00', parentId: 'p1',
  defaultPriority: 'high', responseSlaMinutes: 60, resolutionSlaMinutes: 480,
  defaultBillable: true, defaultHourlyRate: '150.00', sortOrder: 0, isActive: true
};
const CAT_ROOT2 = {
  id: 'r2', name: 'Software', color: '#0000ff', parentId: null,
  defaultPriority: null, responseSlaMinutes: null, resolutionSlaMinutes: null,
  defaultBillable: false, defaultHourlyRate: null, sortOrder: 1, isActive: true
};

function mockGetCategories(cats: unknown[]) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/ticket-categories' && !init?.method) {
      return makeJsonResponse({ data: cats });
    }
    if (url === '/ticket-categories' && init?.method === 'POST') {
      return makeJsonResponse({ data: { id: 'new-1', ...(cats[0] as object) } });
    }
    if (url.match(/\/ticket-categories\/.+/) && init?.method === 'PATCH') {
      return makeJsonResponse({ data: {} });
    }
    return makeJsonResponse({ error: 'unexpected' }, false, 404);
  });
}

describe('TicketCategoriesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Existing tests preserved ---

  it('renders heading and create form', async () => {
    mockGetCategories([]);
    render(<TicketCategoriesPage />);
    expect(screen.getByTestId('ticket-categories-heading')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-categories-name-input')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-categories-color-input')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-categories-create-button')).toBeInTheDocument();
  });

  it('shows empty state when no categories', async () => {
    mockGetCategories([]);
    render(<TicketCategoriesPage />);
    await screen.findByTestId('ticket-categories-empty');
  });

  it('shows error + retry on fetch failure', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ error: 'boom' }, false, 500));
    render(<TicketCategoriesPage />);
    await screen.findByTestId('ticket-categories-error');
    expect(screen.getByTestId('ticket-categories-retry')).toBeInTheDocument();

    // Retry recovers
    mockGetCategories([CAT_PARENT]);
    fireEvent.click(screen.getByTestId('ticket-categories-retry'));
    await screen.findByTestId(`ticket-category-row-${CAT_PARENT.id}`);
    expect(screen.queryByTestId('ticket-categories-error')).toBeNull();
  });

  it('creates a category and reloads list', async () => {
    mockGetCategories([]);
    render(<TicketCategoriesPage />);
    await screen.findByTestId('ticket-categories-empty');

    // Load returns the new category after creation
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/ticket-categories' && !init?.method) return makeJsonResponse({ data: [CAT_PARENT] });
      if (url === '/ticket-categories' && init?.method === 'POST') return makeJsonResponse({ data: CAT_PARENT });
      return makeJsonResponse({ error: 'unexpected' }, false, 404);
    });

    fireEvent.change(screen.getByTestId('ticket-categories-name-input'), { target: { value: 'Hardware' } });
    fireEvent.click(screen.getByTestId('ticket-categories-create-button'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/ticket-categories', expect.objectContaining({ method: 'POST' }));
    });
    await screen.findByTestId(`ticket-category-row-${CAT_PARENT.id}`);
  });

  it('toggles active/inactive', async () => {
    mockGetCategories([CAT_PARENT]);
    render(<TicketCategoriesPage />);
    await screen.findByTestId(`ticket-category-toggle-${CAT_PARENT.id}`);

    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/ticket-categories' && !init?.method) return makeJsonResponse({ data: [{ ...CAT_PARENT, isActive: false }] });
      if (url.match(/\/ticket-categories\/.+/) && init?.method === 'PATCH') return makeJsonResponse({ data: {} });
      return makeJsonResponse({ error: 'unexpected' }, false, 404);
    });

    fireEvent.click(screen.getByTestId(`ticket-category-toggle-${CAT_PARENT.id}`));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/ticket-categories/${CAT_PARENT.id}`,
        expect.objectContaining({ method: 'PATCH' })
      );
    });
  });

  // --- New tests ---

  describe('hierarchy display', () => {
    it('renders parent p1, child c1, root r2 in order; c1 has data-depth="1"', async () => {
      // The API may return them in any order; we pass [c1, r2, p1] to stress the ordering
      mockGetCategories([CAT_CHILD, CAT_ROOT2, CAT_PARENT]);
      render(<TicketCategoriesPage />);

      await screen.findByTestId(`ticket-category-row-${CAT_PARENT.id}`);
      await screen.findByTestId(`ticket-category-row-${CAT_CHILD.id}`);
      await screen.findByTestId(`ticket-category-row-${CAT_ROOT2.id}`);

      const rows = screen.getAllByRole('row');
      // Find data rows by testid
      const p1Index = rows.findIndex((r) => r.getAttribute('data-testid') === `ticket-category-row-${CAT_PARENT.id}`);
      const c1Index = rows.findIndex((r) => r.getAttribute('data-testid') === `ticket-category-row-${CAT_CHILD.id}`);
      const r2Index = rows.findIndex((r) => r.getAttribute('data-testid') === `ticket-category-row-${CAT_ROOT2.id}`);

      expect(p1Index).toBeGreaterThan(0); // exists
      expect(c1Index).toBeGreaterThan(p1Index); // child after parent
      expect(r2Index).toBeGreaterThan(c1Index); // root2 after child

      // c1 must have data-depth="1"
      const c1Row = screen.getByTestId(`ticket-category-row-${CAT_CHILD.id}`);
      expect(c1Row.getAttribute('data-depth')).toBe('1');

      // p1 and r2 must have data-depth="0"
      const p1Row = screen.getByTestId(`ticket-category-row-${CAT_PARENT.id}`);
      expect(p1Row.getAttribute('data-depth')).toBe('0');
    });
  });

  describe('create with parent', () => {
    it('includes parentId in POST when parent is selected', async () => {
      mockGetCategories([CAT_PARENT]);
      render(<TicketCategoriesPage />);
      await screen.findByTestId(`ticket-category-row-${CAT_PARENT.id}`);

      let postBody: Record<string, unknown> = {};
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === '/ticket-categories' && !init?.method) return makeJsonResponse({ data: [CAT_PARENT] });
        if (url === '/ticket-categories' && init?.method === 'POST') {
          postBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          return makeJsonResponse({ data: CAT_CHILD });
        }
        return makeJsonResponse({ error: 'unexpected' }, false, 404);
      });

      fireEvent.change(screen.getByTestId('ticket-categories-name-input'), { target: { value: 'Printers' } });
      fireEvent.change(screen.getByTestId('ticket-categories-parent-input'), { target: { value: 'p1' } });
      fireEvent.click(screen.getByTestId('ticket-categories-create-button'));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith('/ticket-categories', expect.objectContaining({ method: 'POST' }));
      });
      expect(postBody.parentId).toBe('p1');
      expect(postBody.name).toBe('Printers');
    });

    it('omits parentId when None is selected', async () => {
      mockGetCategories([CAT_PARENT]);
      render(<TicketCategoriesPage />);
      await screen.findByTestId(`ticket-category-row-${CAT_PARENT.id}`);

      let postBody: Record<string, unknown> = {};
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === '/ticket-categories' && !init?.method) return makeJsonResponse({ data: [CAT_PARENT] });
        if (url === '/ticket-categories' && init?.method === 'POST') {
          postBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          return makeJsonResponse({ data: CAT_PARENT });
        }
        return makeJsonResponse({ error: 'unexpected' }, false, 404);
      });

      fireEvent.change(screen.getByTestId('ticket-categories-name-input'), { target: { value: 'Networking' } });
      // parent stays None (default)
      fireEvent.click(screen.getByTestId('ticket-categories-create-button'));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith('/ticket-categories', expect.objectContaining({ method: 'POST' }));
      });
      expect(postBody).not.toHaveProperty('parentId');
    });
  });

  describe('edit flow', () => {
    it('prefills edit fields from category data and PATCHes with correctly typed payload', async () => {
      mockGetCategories([CAT_CHILD]);
      render(<TicketCategoriesPage />);
      await screen.findByTestId(`ticket-category-edit-${CAT_CHILD.id}`);

      fireEvent.click(screen.getByTestId(`ticket-category-edit-${CAT_CHILD.id}`));

      // Verify prefilled values
      expect(screen.getByTestId('ticket-category-edit-response-sla')).toHaveValue(60);
      const rateInput = screen.getByTestId('ticket-category-edit-rate') as HTMLInputElement;
      expect(rateInput.value).toBe('150.00');

      // Change name, clear response SLA, set rate to 99.5
      fireEvent.change(screen.getByTestId('ticket-category-edit-name'), { target: { value: 'New name' } });
      fireEvent.change(screen.getByTestId('ticket-category-edit-response-sla'), { target: { value: '' } });
      fireEvent.change(screen.getByTestId('ticket-category-edit-rate'), { target: { value: '99.5' } });

      let patchBody: Record<string, unknown> = {};
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === '/ticket-categories' && !init?.method) return makeJsonResponse({ data: [CAT_CHILD] });
        if (url === `/ticket-categories/${CAT_CHILD.id}` && init?.method === 'PATCH') {
          patchBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          return makeJsonResponse({ data: {} });
        }
        return makeJsonResponse({ error: 'unexpected' }, false, 404);
      });

      fireEvent.click(screen.getByTestId(`ticket-category-save-${CAT_CHILD.id}`));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          `/ticket-categories/${CAT_CHILD.id}`,
          expect.objectContaining({ method: 'PATCH' })
        );
      });

      expect(patchBody.name).toBe('New name');
      expect(patchBody.responseSlaMinutes).toBeNull();
      expect(patchBody.defaultHourlyRate).toBe(99.5);
      // These must be numbers, not strings
      expect(typeof patchBody.defaultHourlyRate).toBe('number');
    });

    it('closes edit panel on cancel without saving', async () => {
      mockGetCategories([CAT_PARENT]);
      render(<TicketCategoriesPage />);
      await screen.findByTestId(`ticket-category-edit-${CAT_PARENT.id}`);

      fireEvent.click(screen.getByTestId(`ticket-category-edit-${CAT_PARENT.id}`));

      // Edit fields visible
      expect(screen.getByTestId('ticket-category-edit-name')).toBeInTheDocument();

      // Click cancel
      fireEvent.click(screen.getByTestId(`ticket-category-cancel-${CAT_PARENT.id}`));

      // Edit fields gone
      expect(screen.queryByTestId('ticket-category-edit-name')).toBeNull();

      // No PATCH was called
      expect(fetchMock).not.toHaveBeenCalledWith(
        expect.stringContaining('/ticket-categories/'),
        expect.objectContaining({ method: 'PATCH' })
      );
    });

    it('save button disabled when name is empty', async () => {
      mockGetCategories([CAT_PARENT]);
      render(<TicketCategoriesPage />);
      await screen.findByTestId(`ticket-category-edit-${CAT_PARENT.id}`);

      fireEvent.click(screen.getByTestId(`ticket-category-edit-${CAT_PARENT.id}`));

      const nameInput = screen.getByTestId('ticket-category-edit-name');
      fireEvent.change(nameInput, { target: { value: '' } });

      expect(screen.getByTestId(`ticket-category-save-${CAT_PARENT.id}`)).toBeDisabled();
    });
  });

  describe('parent select in edit panel', () => {
    it('excludes the category itself and its children from the parent dropdown', async () => {
      // p1 is parent, c1 is child, r2 is another root
      mockGetCategories([CAT_PARENT, CAT_CHILD, CAT_ROOT2]);
      render(<TicketCategoriesPage />);
      await screen.findByTestId(`ticket-category-edit-${CAT_PARENT.id}`);

      // Edit p1 — cannot choose p1 itself or c1 (its child) as parent
      fireEvent.click(screen.getByTestId(`ticket-category-edit-${CAT_PARENT.id}`));
      const parentSelect = screen.getByTestId('ticket-category-edit-parent');
      const options = Array.from(parentSelect.querySelectorAll('option')).map((o) => (o as HTMLOptionElement).value);

      expect(options).not.toContain(CAT_PARENT.id); // self excluded
      expect(options).not.toContain(CAT_CHILD.id);  // child excluded
      expect(options).toContain(CAT_ROOT2.id);       // sibling root included
    });

    it('allows a child to pick a different root as parent', async () => {
      mockGetCategories([CAT_PARENT, CAT_CHILD, CAT_ROOT2]);
      render(<TicketCategoriesPage />);
      await screen.findByTestId(`ticket-category-edit-${CAT_CHILD.id}`);

      fireEvent.click(screen.getByTestId(`ticket-category-edit-${CAT_CHILD.id}`));
      const parentSelect = screen.getByTestId('ticket-category-edit-parent');
      const options = Array.from(parentSelect.querySelectorAll('option')).map((o) => (o as HTMLOptionElement).value);

      expect(options).toContain(CAT_PARENT.id); // current parent available (to keep it)
      expect(options).toContain(CAT_ROOT2.id);   // other root available
      expect(options).not.toContain(CAT_CHILD.id); // self excluded
    });
  });
});
