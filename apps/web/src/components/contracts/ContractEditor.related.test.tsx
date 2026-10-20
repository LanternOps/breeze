import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractEditor from './ContractEditor';
import { fetchWithAuth } from '../../stores/auth';
import * as api from '../../lib/api/contracts';
import { overlappingSibling, relatedDetail, unrelatedSibling } from './relatedContractsFixtures';

// #9303: the editor is what a DRAFT contract renders for a writer, so it is
// where a quote-accept draft is usually activated from. Same notice, same
// overlap confirm as ContractDetail.

type Perm = { resource: string; action: string };
const state = vi.hoisted(() => ({ permissions: [] as Perm[] }));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) =>
      selector({ user: { permissions: state.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../catalog/CatalogItemPicker', () => ({ default: () => null }));
vi.mock('../../lib/api/catalog', () => ({
  listCatalog: vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) }),
}));
vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/contracts')>();
  return { ...actual, contractTransition: vi.fn(), getContractEstimate: vi.fn() };
});

const resp = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [{ resource: 'contracts', action: 'manage' }, { resource: 'contracts', action: 'write' }];
  vi.mocked(fetchWithAuth).mockImplementation(async (url: string) => {
    if (url.startsWith('/orgs/organizations')) return resp({ data: [{ id: 'org-1', name: 'Acme' }] });
    return resp({ data: [] });
  });
  vi.mocked(api.getContractEstimate).mockResolvedValue(
    resp({ data: { currencyCode: 'USD', periodTotal: '500.00', lines: [], uncoveredDevices: null, overages: [] } }),
  );
  vi.mocked(api.contractTransition).mockResolvedValue(resp({ data: null }));
});

describe('ContractEditor — related contracts (#9303)', () => {
  it('renders the notice with a link to the sibling', async () => {
    render(<ContractEditor detail={relatedDetail('draft', [overlappingSibling])} onChanged={vi.fn()} />);
    const notice = await screen.findByTestId('contract-related-notice');
    expect(within(notice).getByTestId('contract-related-link-ct-hand')).toHaveAttribute('href', '/contracts/ct-hand');
  });

  it('renders no notice without siblings', async () => {
    render(<ContractEditor detail={relatedDetail('draft', [])} onChanged={vi.fn()} />);
    await screen.findByTestId('contract-editor');
    expect(screen.queryByTestId('contract-related-notice')).not.toBeInTheDocument();
  });

  it('Activate with an overlapping sibling confirms first; Cancel sends nothing', async () => {
    render(<ContractEditor detail={relatedDetail('draft', [overlappingSibling])} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('activate-contract-btn'));
    expect(await screen.findByTestId('contract-activate-overlap-confirm')).toHaveTextContent('Hand-built MSA');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('contract-activate-overlap-confirm')).not.toBeInTheDocument());
    expect(api.contractTransition).not.toHaveBeenCalled();
  });

  it('Confirm sends exactly one activate', async () => {
    render(<ContractEditor detail={relatedDetail('draft', [overlappingSibling])} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('activate-contract-btn'));
    fireEvent.click(await screen.findByTestId('contract-activate-overlap-confirm-btn'));
    await waitFor(() => expect(api.contractTransition).toHaveBeenCalledTimes(1));
    expect(api.contractTransition).toHaveBeenCalledWith('ct-1', 'activate');
  });

  it('activates without a dialog when nothing overlaps', async () => {
    render(<ContractEditor detail={relatedDetail('draft', [unrelatedSibling])} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('activate-contract-btn'));
    await waitFor(() => expect(api.contractTransition).toHaveBeenCalledWith('ct-1', 'activate'));
    expect(screen.queryByTestId('contract-activate-overlap-confirm')).not.toBeInTheDocument();
  });
});
