import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CatalogItemsTab from './CatalogItemsTab';
import { fetchWithAuth } from '../../stores/auth';

type Perm = { resource: string; action: string };

// Mutable grant set the mocked auth store reads from, so each test can vary the
// catalog permissions the tab sees. This file exists to cover the NEGATIVE
// gating branches — the sibling CatalogItemsTab.test.tsx grants the wildcard and
// only ever exercises the visible/true branch, so a mis-wired (resource,action)
// pair (e.g. gating Archive on catalog:write instead of catalog:delete) would
// pass there. These tests pin the read vs write vs delete distinction.
const state = vi.hoisted(() => ({ permissions: [] as Perm[] }));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) =>
      selector({ user: { permissions: state.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('../../lib/authScope', () => ({
  getJwtClaims: () => ({ scope: 'partner' }),
  loginPathWithNext: () => '/login',
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const LAPTOP = {
  partnerId: 'p1', description: null, billingType: 'one_time' as const,
  markupPercent: null, unitOfMeasure: 'each', taxable: true, taxCategory: null,
  isActive: true, createdAt: '2026-01-01', updatedAt: '2026-01-01',
  id: 'l1', itemType: 'hardware' as const, name: 'Laptop', sku: 'LAP-9',
  unitPrice: '1200.00', costBasis: null, isBundle: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [];
  fetchMock.mockImplementation(async (url) => {
    if (String(url).startsWith('/catalog?')) return jsonResponse({ data: [LAPTOP] });
    return jsonResponse({});
  });
});

describe('CatalogItemsTab — permission gating', () => {
  it('read-only (catalog:read) hides Add item and the whole row action menu', async () => {
    state.permissions = [{ resource: 'catalog', action: 'read' }];
    render(<CatalogItemsTab />);
    await screen.findByText('Laptop');

    expect(screen.queryByTestId('catalog-add-item')).not.toBeInTheDocument();
    // RowActions has nothing actionable → it renders no kebab trigger at all.
    expect(screen.queryByTestId('catalog-actions-l1')).not.toBeInTheDocument();
  });

  it('write-without-delete shows Add item and Edit but NOT Archive', async () => {
    // The subtle case: Archive needs catalog:delete, Edit needs catalog:write.
    state.permissions = [{ resource: 'catalog', action: 'write' }];
    render(<CatalogItemsTab />);
    await screen.findByText('Laptop');

    expect(screen.getByTestId('catalog-add-item')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('catalog-actions-l1'));
    expect(await screen.findByTestId('catalog-edit-l1')).toBeInTheDocument();
    expect(screen.queryByTestId('catalog-archive-l1')).not.toBeInTheDocument();
  });

  it('delete grant reveals Archive in the row menu', async () => {
    state.permissions = [
      { resource: 'catalog', action: 'write' },
      { resource: 'catalog', action: 'delete' },
    ];
    render(<CatalogItemsTab />);
    await screen.findByText('Laptop');

    fireEvent.click(screen.getByTestId('catalog-actions-l1'));
    await waitFor(() => expect(screen.getByTestId('catalog-archive-l1')).toBeInTheDocument());
  });
});
