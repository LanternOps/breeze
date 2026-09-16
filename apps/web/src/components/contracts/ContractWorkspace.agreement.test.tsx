import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@/lib/i18n';

const api = vi.hoisted(() => ({ getContract: vi.fn(), listContractDocuments: vi.fn() }));
vi.mock('../../lib/api/contracts', async (o) => ({ ...(await o<typeof import('../../lib/api/contracts')>()), getContract: api.getContract }));
vi.mock('../../lib/api/contractDocuments', async (o) => ({ ...(await o<typeof import('../../lib/api/contractDocuments')>()), listContractDocuments: api.listContractDocuments }));
vi.mock('./ContractDetail', () => ({ default: () => <div data-testid="stub-detail" /> }));
vi.mock('./ContractEditor', () => ({ default: () => <div data-testid="stub-editor" /> }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import ContractWorkspace from './ContractWorkspace';

const resp = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const doc = (over: Record<string, unknown> = {}) => ({
  id: 'd1', orgId: 'org-1', contractId: 'ct-1', quoteId: 'q1', templateId: 't1', templateVersionId: 'v1',
  templateName: 'Master Services Agreement', templateVersionNumber: 2, signerName: 'Jane Doe',
  signedAt: '2026-06-01T00:00:00Z', quoteNumber: 'Q-1', byteSize: 1, sha256: 'a', createdAt: '2026-06-01T00:00:00Z',
  ...over,
});

describe('ContractWorkspace agreement pill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getContract.mockResolvedValue(resp({ data: { contract: { id: 'ct-1', name: 'Acme MSA', status: 'active' } } }));
  });

  it('names the FIRST-created signed agreement, not the newest', async () => {
    // The API returns newest-first (contractDocumentService orders desc), so the
    // first-created row is the LAST element.
    api.listContractDocuments.mockResolvedValue(resp({ data: [
      doc({ id: 'd2', templateName: 'Addendum', templateVersionNumber: 5, createdAt: '2026-07-01T00:00:00Z' }),
      doc({ id: 'd1', templateName: 'Master Services Agreement', templateVersionNumber: 2 }),
    ] }));
    render(<ContractWorkspace contractId="ct-1" />);
    const pill = await screen.findByTestId('contract-under-agreement-pill');
    expect(pill).toHaveTextContent('Master Services Agreement');
    expect(pill).toHaveTextContent('2');
    expect(pill).not.toHaveTextContent('Addendum');
  });

  it('renders no pill when the contract has no signed agreement', async () => {
    api.listContractDocuments.mockResolvedValue(resp({ data: [] }));
    render(<ContractWorkspace contractId="ct-1" />);
    await screen.findByTestId('contract-workspace');
    expect(screen.queryByTestId('contract-under-agreement-pill')).not.toBeInTheDocument();
  });

  it('renders no pill (and no error) when the documents fetch fails', async () => {
    api.listContractDocuments.mockResolvedValue(resp({ error: 'boom' }, 500));
    render(<ContractWorkspace contractId="ct-1" />);
    await screen.findByTestId('contract-workspace');
    expect(screen.queryByTestId('contract-under-agreement-pill')).not.toBeInTheDocument();
  });

  it('shows the pill on a DRAFT contract too, where the detail view never mounts', async () => {
    api.getContract.mockResolvedValue(resp({ data: { contract: { id: 'ct-1', name: 'Q-1 — Monthly', status: 'draft' } } }));
    api.listContractDocuments.mockResolvedValue(resp({ data: [doc()] }));
    render(<ContractWorkspace contractId="ct-1" />);
    expect(await screen.findByTestId('contract-under-agreement-pill')).toBeInTheDocument();
  });

  it('links the pill to the signed agreements section on the page', async () => {
    api.listContractDocuments.mockResolvedValue(resp({ data: [doc()] }));
    render(<ContractWorkspace contractId="ct-1" />);
    expect(await screen.findByTestId('contract-under-agreement-pill'))
      .toHaveAttribute('href', '#signed-agreements');
  });
});
