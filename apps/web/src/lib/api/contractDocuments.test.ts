import { describe, expect, it, vi, beforeEach } from 'vitest';

const fetchWithAuth = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200 }) as unknown as Response);
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: [string, RequestInit?]) => fetchWithAuth(...a) }));

import { listContractDocuments, contractDocumentPdfPath } from './contractDocuments';

describe('listContractDocuments query building', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends no query string at all when nothing is asked for', async () => {
    await listContractDocuments();
    expect(fetchWithAuth).toHaveBeenCalledWith('/contracts/contract-documents');
  });

  it('sends linked=all for the full inventory (the server default is unlinked)', async () => {
    await listContractDocuments({ linked: 'all' });
    expect(fetchWithAuth).toHaveBeenCalledWith('/contracts/contract-documents?linked=all');
  });

  it('combines orgId with the link filter', async () => {
    await listContractDocuments({ orgId: 'org-1', linked: 'all' });
    const url = fetchWithAuth.mock.calls[0]![0];
    expect(url.startsWith('/contracts/contract-documents?')).toBe(true);
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('orgId')).toBe('org-1');
    expect(params.get('linked')).toBe('all');
  });

  it('still supports contractId for the contract-detail embed', async () => {
    await listContractDocuments({ contractId: 'ct-1' });
    expect(fetchWithAuth).toHaveBeenCalledWith('/contracts/contract-documents?contractId=ct-1');
  });

  // The path is asserted here because the e2e PDF regex keys off it
  // (quote-contract-proposal.spec.ts:332) — renaming it silently reddens e2e only.
  it('builds the PDF path under the unchanged contracts mount', () => {
    expect(contractDocumentPdfPath('doc-1')).toBe('/contracts/contract-documents/doc-1/pdf');
  });
});
