import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// fetchWithAuth is called directly to load the org-name lookup (same idiom as TemplatesTab).
const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const docsApi = vi.hoisted(() => ({
  listContractDocuments: vi.fn(),
  linkContractDocument: vi.fn(),
}));
vi.mock('../../lib/api/contractDocuments', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/api/contractDocuments')>();
  return { ...orig, ...docsApi };
});

const contractsApi = vi.hoisted(() => ({
  listContracts: vi.fn(),
}));
vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/api/contracts')>();
  return { ...orig, ...contractsApi };
});

import DocumentsTab from './DocumentsTab';

const resp = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const UNATTACHED_DOC = {
  id: 'doc-1',
  orgId: 'org-1',
  contractId: null,
  quoteId: 'q-1',
  templateId: 't-1',
  templateVersionId: 'v-1',
  templateName: 'MSA',
  templateVersionNumber: 2,
  signerName: 'Jane Doe',
  signedAt: '2026-06-15T00:00:00Z',
  quoteNumber: 'Q-2026-0001',
  byteSize: 2048,
  sha256: 'a'.repeat(64),
  createdAt: '2026-06-15T00:00:00Z',
};

describe('DocumentsTab — unattached executed documents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuth.mockResolvedValue(resp({ data: [{ id: 'org-1', name: 'Acme' }] }));
    docsApi.listContractDocuments.mockResolvedValue(resp({ data: [UNATTACHED_DOC] }));
    contractsApi.listContracts.mockResolvedValue(resp({ data: [{ id: 'ct-1', name: 'Acme MSA', orgId: 'org-1' }] }));
    docsApi.linkContractDocument.mockResolvedValue(resp({ data: { ...UNATTACHED_DOC, contractId: 'ct-1' } }));
  });

  it('fetches unattached documents (contract_id IS NULL) and renders a row per document', async () => {
    render(<DocumentsTab />);
    await screen.findByTestId('contract-documents-tab');

    await waitFor(() =>
      expect(docsApi.listContractDocuments).toHaveBeenCalledWith(expect.objectContaining({ unattached: true })),
    );
    const rows = await screen.findAllByTestId('contract-document-unattached-row');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText(/MSA/)).toBeInTheDocument();
    expect(within(rows[0]).getByText('Jane Doe')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Acme')).toBeInTheDocument();
  });

  it('shows an empty state when there are no unattached documents', async () => {
    docsApi.listContractDocuments.mockResolvedValue(resp({ data: [] }));
    render(<DocumentsTab />);
    await waitFor(() => expect(screen.getByTestId('contract-documents-empty')).toBeInTheDocument());
  });

  it('surfaces an error (not an empty "no contracts") when the contract fetch fails', async () => {
    contractsApi.listContracts.mockResolvedValue(resp({ error: 'boom' }, 500));
    render(<DocumentsTab />);
    const rows = await screen.findAllByTestId('contract-document-unattached-row');
    fireEvent.click(within(rows[0]).getByTestId('contract-document-link-open'));

    await screen.findByTestId('contract-document-link-dialog');
    // The failure renders the link-error, never the misleading "No contracts" copy.
    await screen.findByTestId('contract-document-link-error');
    expect(screen.queryByText(/No contracts found/i)).not.toBeInTheDocument();
  });

  it('links a document to a contract and reloads the list', async () => {
    render(<DocumentsTab />);
    const rows = await screen.findAllByTestId('contract-document-unattached-row');
    fireEvent.click(within(rows[0]).getByTestId('contract-document-link-open'));

    await screen.findByTestId('contract-document-link-dialog');
    await waitFor(() => expect(contractsApi.listContracts).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-1' })));

    const select = screen.getByTestId('contract-document-link-select');
    await within(select).findByRole('option', { name: 'Acme MSA' });
    fireEvent.change(select, { target: { value: 'ct-1' } });
    fireEvent.click(screen.getByTestId('contract-document-link-confirm'));

    await waitFor(() => expect(docsApi.linkContractDocument).toHaveBeenCalledWith('doc-1', 'ct-1'));
    // reloads after a successful link
    await waitFor(() => expect(docsApi.listContractDocuments).toHaveBeenCalledTimes(2));
  });
});
