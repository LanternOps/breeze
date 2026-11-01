import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractEditor from './ContractEditor';
import { fetchWithAuth } from '../../stores/auth';
import * as api from '../../lib/api/contracts';
import type { ContractDetail } from '../../lib/api/contracts';

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

const draftDetail: ContractDetail = {
  autopayEnabled: false,
  contract: {
    autopayExcluded: false,
    id: 'ct-1', partnerId: 'p1', orgId: 'org-1', name: 'Acme MSA', status: 'draft',
    billingTiming: 'advance', intervalMonths: 1, startDate: '2026-06-01', endDate: null,
    nextBillingAt: null, autoIssue: false, autoRenew: false, renewalTermMonths: null, renewalNoticeDays: null,
    currencyCode: 'USD', notes: null, terms: null,
    createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  },
  lines: [],
  periods: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [{ resource: 'contracts', action: 'write' }];
  fetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/orgs/organizations')) return resp({ data: [{ id: 'org-1', name: 'Acme' }] });
    if (url.startsWith('/orgs/sites')) return resp({ data: [] });
    if (url.startsWith('/orgs/org-1/deliverables')) return resp({ data: [] });
    return resp({ data: {} });
  });
  (api.getContractEstimate as ReturnType<typeof vi.fn>).mockResolvedValue(
    resp({ data: { currencyCode: 'USD', periodTotal: '0.00', lines: [], uncoveredDevices: null, overages: [] } }),
  );
});

// #9958: a writer sees a draft through ContractEditor, never ContractDetail, so
// the deliverables section (and its #9309 "Paused" note) has to live here too.
describe('ContractEditor — service deliverables section (#9958)', () => {
  it('a draft lists its deliverables and says they are paused until activation', async () => {
    render(<ContractEditor detail={draftDetail} onChanged={vi.fn()} />);
    await screen.findByTestId('contract-deliverables');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/orgs/org-1/deliverables?contractId=ct-1'));
    expect(screen.getByTestId('contract-deliverables-paused')).toHaveTextContent('Paused until the contract is activated');
    expect(screen.getByTestId('contract-deliverables-add')).toBeInTheDocument();
  });

  it('an active contract opened for editing shows deliverables without the paused note', async () => {
    const active: ContractDetail = { ...draftDetail, contract: { ...draftDetail.contract, status: 'active' } };
    render(<ContractEditor detail={active} onChanged={vi.fn()} />);
    await screen.findByTestId('contract-deliverables');
    expect(screen.queryByTestId('contract-deliverables-paused')).not.toBeInTheDocument();
  });

  it('the create form has no deliverables section (there is no contract to attach to yet)', async () => {
    render(<ContractEditor />);
    await waitFor(() => expect(screen.getByTestId('contract-editor')).toBeInTheDocument());
    expect(screen.queryByTestId('contract-deliverables')).not.toBeInTheDocument();
  });
});
