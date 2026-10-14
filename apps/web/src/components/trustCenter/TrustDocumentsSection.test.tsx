// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@/lib/i18n';
const api = vi.hoisted(() => ({ updateTrustDocuments: vi.fn() }));
vi.mock('@/lib/api/trustPage', () => api);
const lib = vi.hoisted(() => ({ listOrgDocuments: vi.fn() }));
vi.mock('@/lib/api/orgDocuments', () => lib);
import TrustDocumentsSection from './TrustDocumentsSection';

const doc = (id: string, title: string, category: string, superseded: string | null = null) => ({ id, title, category, contentType: 'application/pdf', byteSize: 2048, supersededByDocumentId: superseded, createdAt: '2026-10-01T00:00:00Z' });
const orgFetch = vi.fn() as never;
const ok = () => new Response(JSON.stringify({ data: { documents: [], publicationRevision: 4 } }), { status: 200 });
const mount = (props: Record<string, unknown> = {}) => {
  const onReload = vi.fn(async () => {});
  render(<TrustDocumentsSection orgId="o1" orgFetch={orgFetch} canWrite initialLinks={[]} onReload={onReload} {...props} />);
  return onReload;
};

describe('TrustDocumentsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.updateTrustDocuments.mockResolvedValue(ok());
    lib.listOrgDocuments.mockResolvedValue([doc('d-ev', 'Evidence pack', 'evidence'), doc('d-pol', 'Security policy', 'policy'), doc('d-run', 'Runbook', 'runbook')]);
  });
  it('lists policy/report/evidence before other categories', async () => {
    mount();
    await screen.findByTestId('trust-doc-lib-d-pol');
    const ids = screen.getAllByTestId(/^trust-doc-lib-/).map((e) => e.getAttribute('data-testid'));
    expect(ids).toEqual(['trust-doc-lib-d-pol', 'trust-doc-lib-d-ev', 'trust-doc-lib-d-run']);
    expect(lib.listOrgDocuments).toHaveBeenCalledWith(orgFetch, 'o1', { includeSuperseded: false });
  });
  it('adding a document requires the disclosure confirmation, and Save sends order + disclosureConfirmed', async () => {
    const onReload = mount();
    fireEvent.click(await screen.findByTestId('trust-doc-add-d-pol'));
    const confirm = screen.getByTestId('trust-doc-disclosure-confirm');
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByTestId('trust-doc-linked-d-pol')).toBeNull();
    fireEvent.click(screen.getByTestId('trust-doc-disclosure-checkbox'));
    expect(confirm).toHaveAttribute('aria-disabled', 'false');
    fireEvent.click(confirm);
    fireEvent.click(await screen.findByTestId('trust-doc-add-d-ev'));
    fireEvent.click(screen.getByTestId('trust-doc-disclosure-checkbox'));
    fireEvent.click(screen.getByTestId('trust-doc-disclosure-confirm'));
    await screen.findByTestId('trust-doc-linked-d-ev');
    fireEvent.click(screen.getByTestId('trust-doc-up-d-ev'));
    fireEvent.click(screen.getByTestId('trust-docs-save'));
    await waitFor(() => expect(api.updateTrustDocuments).toHaveBeenCalledWith(orgFetch, 'o1', [
      { documentId: 'd-ev', visibility: 'public', disclosureConfirmed: true },
      { documentId: 'd-pol', visibility: 'public', disclosureConfirmed: true },
    ]));
    await waitFor(() => expect(onReload).toHaveBeenCalled());
  });
  it('warns on a linked document that has been superseded or is missing', async () => {
    mount({ initialLinks: [
      { documentId: 'd-old', title: 'Old policy', disclosureConfirmed: true },
      { documentId: 'd-gone', title: 'Gone doc', disclosureConfirmed: true },
    ] });
    lib.listOrgDocuments.mockResolvedValue([doc('d-new', 'New policy', 'policy')]);
    // library loads after mount; superseded rows are excluded by the API, so both read as unavailable
    expect(await screen.findAllByText(/Superseded — relink the newer version/)).toHaveLength(2);
  });
  it('maps DOCUMENT_UNAVAILABLE to a message naming the document', async () => {
    api.updateTrustDocuments.mockResolvedValue(new Response(JSON.stringify({ error: 'x', code: 'DOCUMENT_UNAVAILABLE', details: { documentIds: ['d-pol'] } }), { status: 422 }));
    mount({ initialLinks: [{ documentId: 'd-pol', title: 'Security policy', disclosureConfirmed: true }] });
    await screen.findByTestId('trust-doc-linked-d-pol');
    fireEvent.click(screen.getByTestId('trust-docs-save'));
    await waitFor(() => expect(api.updateTrustDocuments).toHaveBeenCalled());
    expect(await screen.findByTestId('trust-docs-error')).toHaveTextContent('Security policy');
  });
  it('removes a linked document and disables controls without write', async () => {
    mount({ canWrite: false, initialLinks: [{ documentId: 'd-pol', title: 'Security policy', disclosureConfirmed: true }] });
    expect(await screen.findByTestId('trust-docs-save')).toBeDisabled();
    expect(screen.getByTestId('trust-doc-remove-d-pol')).toBeDisabled();
    expect(await screen.findByTestId('trust-doc-add-d-ev')).toBeDisabled();
  });
});
