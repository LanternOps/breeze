import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// fetchWithAuth is called directly to load the org-name lookup (same idiom as TemplatesPage).
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

import SignedAgreementsPage from './SignedAgreementsPage';

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

describe('SignedAgreementsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
    fetchWithAuth.mockResolvedValue(resp({ data: [{ id: 'org-1', name: 'Acme' }] }));
    docsApi.listContractDocuments.mockResolvedValue(resp({ data: [UNATTACHED_DOC] }));
    contractsApi.listContracts.mockResolvedValue(resp({ data: [{ id: 'ct-1', name: 'Acme MSA', orgId: 'org-1' }] }));
    docsApi.linkContractDocument.mockResolvedValue(resp({ data: { ...UNATTACHED_DOC, contractId: 'ct-1' } }));
  });

  it('fetches the whole inventory by default and renders a row per document', async () => {
    render(<SignedAgreementsPage />);
    await screen.findByTestId('signed-agreements-tab');

    await waitFor(() =>
      expect(docsApi.listContractDocuments).toHaveBeenCalledWith(expect.objectContaining({ linked: 'all' })),
    );
    const rows = await screen.findAllByTestId('contract-document-row');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText(/MSA/)).toBeInTheDocument();
    expect(within(rows[0]).getByText('Jane Doe')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Acme')).toBeInTheDocument();
  });

  it('shows an empty state when there are no unattached documents', async () => {
    docsApi.listContractDocuments.mockResolvedValue(resp({ data: [] }));
    render(<SignedAgreementsPage />);
    await waitFor(() => expect(screen.getByTestId('contract-documents-empty')).toBeInTheDocument());
  });

  it('surfaces an error (not an empty "no contracts") when the contract fetch fails', async () => {
    contractsApi.listContracts.mockResolvedValue(resp({ error: 'boom' }, 500));
    render(<SignedAgreementsPage />);
    const rows = await screen.findAllByTestId('contract-document-row');
    fireEvent.click(within(rows[0]).getByTestId('contract-document-link-open'));

    await screen.findByTestId('contract-document-link-dialog');
    // The failure renders the link-error, never the misleading "No contracts" copy.
    await screen.findByTestId('contract-document-link-error');
    expect(screen.queryByText(/No contracts found/i)).not.toBeInTheDocument();
  });

  it('links a document to a contract and reloads the list', async () => {
    render(<SignedAgreementsPage />);
    const rows = await screen.findAllByTestId('contract-document-row');
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
  it('refetches with linked=unlinked when the Unlinked only chip is turned on', async () => {
    render(<SignedAgreementsPage />);
    await screen.findByTestId('signed-agreements-tab');
    fireEvent.click(screen.getByTestId('signed-agreements-unlinked-filter'));
    await waitFor(() =>
      expect(docsApi.listContractDocuments).toHaveBeenLastCalledWith(
        expect.objectContaining({ linked: 'unlinked' }),
      ),
    );
    expect(window.location.hash).toContain('unlinked=1');
  });

  it('starts with the chip on and asks for unlinked when defaultUnlinkedOnly is set', async () => {
    render(<SignedAgreementsPage defaultUnlinkedOnly />);
    await waitFor(() =>
      expect(docsApi.listContractDocuments).toHaveBeenCalledWith(expect.objectContaining({ linked: 'unlinked' })),
    );
  });

  it('pins to one org and hides the Organization column when lockedOrgId is set', async () => {
    render(<SignedAgreementsPage lockedOrgId="org-1" />);
    await waitFor(() =>
      expect(docsApi.listContractDocuments).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: 'org-1', linked: 'all' }),
      ),
    );
    expect(screen.queryByText('Organization')).not.toBeInTheDocument();
  });

  it('pins to one contract, hides the Contract column and offers no link action', async () => {
    render(<SignedAgreementsPage lockedContractId="ct-1" />);
    await waitFor(() =>
      expect(docsApi.listContractDocuments).toHaveBeenCalledWith(expect.objectContaining({ contractId: 'ct-1' })),
    );
    const rows = await screen.findAllByTestId('contract-document-row');
    expect(within(rows[0]).queryByTestId('contract-document-link-open')).not.toBeInTheDocument();
    expect(screen.queryByText('Contract')).not.toBeInTheDocument();
  });

  it('renders the acceptance subtitle from the quote, signer and signed date', async () => {
    render(<SignedAgreementsPage />);
    const rows = await screen.findAllByTestId('contract-document-row');
    expect(within(rows[0]).getByTestId('signed-agreement-subtitle'))
      .toHaveTextContent(/Q-2026-0001.*Jane Doe/);
  });

  it('links a linked row to its contract', async () => {
    docsApi.listContractDocuments.mockResolvedValue(resp({ data: [{ ...UNATTACHED_DOC, contractId: 'ct-9' }] }));
    render(<SignedAgreementsPage />);
    const rows = await screen.findAllByTestId('contract-document-row');
    expect(within(rows[0]).getByTestId('signed-agreement-contract-link')).toHaveAttribute('href', '/contracts/ct-9');
  });

  it('shows the unlinked-specific empty state only when the chip is on', async () => {
    docsApi.listContractDocuments.mockResolvedValue(resp({ data: [] }));
    render(<SignedAgreementsPage />);
    const empty = await screen.findByTestId('contract-documents-empty');
    expect(empty).toHaveTextContent(/No signed agreements yet/i);
    fireEvent.click(screen.getByTestId('signed-agreements-unlinked-filter'));
    await waitFor(() =>
      expect(screen.getByTestId('contract-documents-empty')).toHaveTextContent(/No unlinked signed agreements/i),
    );
  });
});
