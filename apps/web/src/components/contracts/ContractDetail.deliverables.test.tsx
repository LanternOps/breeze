import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractDetail from './ContractDetail';
import * as contractsApi from '../../lib/api/contracts';
import * as documentsApi from '../../lib/api/contractDocuments';
import type { ContractDetail as ContractDetailData } from '../../lib/api/contracts';

// Auth mock (same pattern as ContractDetail.documents.test.tsx)
type Perm = { resource: string; action: string };
const state = vi.hoisted(() => ({ permissions: [] as Perm[] }));

const fetchWithAuthMock = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuthMock(...a),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) =>
      selector({ user: { permissions: state.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/contracts')>();
  return {
    ...actual,
    contractTransition: vi.fn(),
    generateContractInvoice: vi.fn(),
    getContractEstimate: vi.fn(),
    deleteContract: vi.fn(),
  };
});

vi.mock('../../lib/api/contractDocuments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/contractDocuments')>();
  return { ...actual, listContractDocuments: vi.fn() };
});

const resp = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const activeDetail: ContractDetailData = {
  contract: {
    id: 'ct-1', partnerId: 'p1', orgId: 'org-77', name: 'Acme MSA', status: 'active',
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
  (contractsApi.getContractEstimate as ReturnType<typeof vi.fn>).mockResolvedValue(
    resp({ data: { currencyCode: 'USD', periodTotal: '0.00', lines: [] } }),
  );
  (documentsApi.listContractDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(resp({ data: [] }));
  fetchWithAuthMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/orgs/org-77/deliverables')) return resp({ data: [] });
    return resp({ data: [] });
  });
});

describe('ContractDetail — service deliverables section', () => {
  it('renders the deliverables section directly under the documents section', async () => {
    render(<ContractDetail detail={activeDetail} onChanged={vi.fn()} />);
    const section = await screen.findByTestId('contract-deliverables');
    const documents = screen.getByTestId('contract-documents-section');
    // documents precede deliverables in document order
    expect(documents.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(documents.parentElement).toBe(section.parentElement);
  });

  it("lists deliverables for this contract using the contract's orgId", async () => {
    render(<ContractDetail detail={activeDetail} onChanged={vi.fn()} />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith('/orgs/org-77/deliverables?contractId=ct-1'));
    expect(await screen.findByText(/No deliverables yet/)).toBeInTheDocument();
  });
});
