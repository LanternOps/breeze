import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractEditor from './ContractEditor';
import { fetchWithAuth } from '../../stores/auth';
import * as api from '../../lib/api/contracts';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  // usePermissions() (billing-RBAC UI gating) reads grants off the store; grant
  // the admin wildcard so every gated control renders and these tests exercise
  // full functionality.
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
// The catalog typeahead is exercised in the invoice-editor test; stub it here.
vi.mock('../catalog/CatalogItemPicker', () => ({ default: () => null }));
vi.mock('../../lib/api/catalog', () => ({
  listCatalog: vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) }),
}));
vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/contracts')>();
  return {
    ...actual,
    createContract: vi.fn(),
    updateContract: vi.fn(),
    addContractLine: vi.fn(),
    removeContractLine: vi.fn(),
    contractTransition: vi.fn(),
    getContractEstimate: vi.fn(),
  };
});

const fetchMock = vi.mocked(fetchWithAuth);
const resp = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('ContractEditor (create)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/orgs/organizations')) return resp({ data: [{ id: 'org-1', name: 'Acme' }] });
      if (url.startsWith('/orgs/sites')) return resp({ data: [] });
      return resp({ data: {} });
    });
    (api.createContract as any).mockResolvedValue(resp({ data: { id: 'new-1' } }));
  });

  it('includes the Terms field in the create payload', async () => {
    render(<ContractEditor />);
    await screen.findByTestId('contract-form-org');

    fireEvent.change(screen.getByTestId('contract-form-org'), { target: { value: 'org-1' } });
    fireEvent.change(screen.getByTestId('contract-form-name'), { target: { value: 'Acme MSA' } });
    fireEvent.change(screen.getByTestId('contract-form-terms'), { target: { value: 'Net 30. Auto-renews.' } });
    fireEvent.click(screen.getByTestId('save-contract-btn'));

    await waitFor(() => expect(api.createContract).toHaveBeenCalled());
    expect((api.createContract as any).mock.calls[0][0]).toMatchObject({
      orgId: 'org-1', name: 'Acme MSA', terms: 'Net 30. Auto-renews.',
    });
  });
});
