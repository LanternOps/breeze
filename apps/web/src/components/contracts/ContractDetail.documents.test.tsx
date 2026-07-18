import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractDetail from './ContractDetail';
import * as contractsApi from '../../lib/api/contracts';
import * as documentsApi from '../../lib/api/contractDocuments';
import type { ContractDetail as ContractDetailData } from '../../lib/api/contracts';
import type { ContractDocument } from '../../lib/api/contractDocuments';

// Auth mock (same pattern as ContractDetail.delete.test.tsx)
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
    id: 'ct-1', partnerId: 'p1', orgId: 'org-1', name: 'Acme MSA', status: 'active',
    billingTiming: 'advance', intervalMonths: 1, startDate: '2026-06-01', endDate: null,
    nextBillingAt: null, autoIssue: false, autoRenew: false, renewalTermMonths: null, renewalNoticeDays: null,
    currencyCode: 'USD', notes: null, terms: null,
    createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  },
  lines: [],
  periods: [],
};

const DOCUMENT: ContractDocument = {
  id: 'doc-1',
  orgId: 'org-1',
  contractId: 'ct-1',
  quoteId: 'q-1',
  templateId: 't-1',
  templateVersionId: 'v-1',
  templateName: 'MSA',
  templateVersionNumber: 3,
  signerName: 'Jane Doe',
  signedAt: '2026-06-15T00:00:00Z',
  quoteNumber: 'Q-2026-0001',
  byteSize: 2048,
  sha256: 'a'.repeat(64),
  createdAt: '2026-06-15T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [{ resource: 'contracts', action: 'write' }];
  (contractsApi.getContractEstimate as ReturnType<typeof vi.fn>).mockResolvedValue(
    resp({ data: { currencyCode: 'USD', periodTotal: '0.00', lines: [] } }),
  );
  (documentsApi.listContractDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(resp({ data: [DOCUMENT] }));
});

describe('ContractDetail — executed documents section', () => {
  it('renders the documents section and fetches documents scoped to this contract', async () => {
    render(<ContractDetail detail={activeDetail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('contract-documents-section')).toBeInTheDocument());
    await waitFor(() =>
      expect(documentsApi.listContractDocuments).toHaveBeenCalledWith(expect.objectContaining({ contractId: 'ct-1' })),
    );
  });

  it('shows template name + version, signer, signed date, and a quote link for each document', async () => {
    render(<ContractDetail detail={activeDetail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('contract-document-row')).toBeInTheDocument());

    expect(screen.getByText(/MSA/)).toBeInTheDocument();
    expect(screen.getByText(/3/)).toBeInTheDocument();
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    const quoteLink = screen.getByTestId('contract-document-quote-link-doc-1');
    expect(quoteLink).toHaveAttribute('href', '/billing/quotes/q-1');
    expect(quoteLink).toHaveTextContent('Q-2026-0001');
  });

  it('shows an empty state when the contract has no executed documents', async () => {
    (documentsApi.listContractDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(resp({ data: [] }));
    render(<ContractDetail detail={activeDetail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('contract-documents-empty')).toBeInTheDocument());
  });

  it('downloads the PDF via an authenticated fetch when Download is clicked', async () => {
    fetchWithAuthMock.mockResolvedValue({
      ok: true,
      status: 200,
      blob: vi.fn().mockResolvedValue(new Blob(['%PDF'])),
    } as unknown as Response);
    Object.assign(window.URL, {
      createObjectURL: vi.fn().mockReturnValue('blob:mock'),
      revokeObjectURL: vi.fn(),
    });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(<ContractDetail detail={activeDetail} onChanged={vi.fn()} />);
    const downloadBtn = await screen.findByTestId('contract-document-download-doc-1');
    fireEvent.click(downloadBtn);

    await waitFor(() =>
      expect(fetchWithAuthMock).toHaveBeenCalledWith('/contracts/contract-documents/doc-1/pdf'),
    );
    clickSpy.mockRestore();
  });
});
