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
const sd = (documentId: string, title: string, sortOrder: number, supersededByDocumentId: string | null = null, deleted = false) => ({
  documentId, visibility: 'public' as const, disclosureConfirmedAt: '2026-10-01T00:00:00Z', sortOrder, title, category: 'policy',
  contentType: 'application/pdf', byteSize: 1, supersededByDocumentId, deleted,
});
const orgFetch = vi.fn() as never;
const ok = () => new Response(JSON.stringify({ data: { documents: [], publicationRevision: 4 } }), { status: 200 });
const mount = (props: Record<string, unknown> = {}) => {
  const onReload = vi.fn(async () => {});
  render(<TrustDocumentsSection orgId="o1" orgFetch={orgFetch} canWrite documents={[]} onReload={onReload} {...props} />);
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
    mount({ documents: [
      sd('d-old', 'Old policy', 0, 'd-new'),
      sd('d-gone', 'Gone doc', 1, null, true),
    ] });
    lib.listOrgDocuments.mockResolvedValue([doc('d-new', 'New policy', 'policy')]);
    // library loads after mount; superseded rows are excluded by the API, so both read as unavailable
    expect(await screen.findAllByText(/Superseded — relink the newer version/)).toHaveLength(2);
  });
  it('maps DOCUMENT_UNAVAILABLE to a message naming the document', async () => {
    api.updateTrustDocuments.mockResolvedValue(new Response(JSON.stringify({ error: 'x', code: 'DOCUMENT_UNAVAILABLE', details: { documentIds: ['d-pol'] } }), { status: 422 }));
    mount({ documents: [{ documentId: 'd-pol', title: 'Security policy', disclosureConfirmed: true }] });
    await screen.findByTestId('trust-doc-linked-d-pol');
    fireEvent.click(screen.getByTestId('trust-docs-save'));
    await waitFor(() => expect(api.updateTrustDocuments).toHaveBeenCalled());
    expect(await screen.findByTestId('trust-docs-error')).toHaveTextContent('Security policy');
  });
  it('renders server links in sortOrder with the warning on the superseded one, and Save sends ALL of them', async () => {
    lib.listOrgDocuments.mockResolvedValue([doc('d-b', 'Second', 'policy')]);
    mount({ documents: [sd('d-b', 'Second', 1), sd('d-a', 'First', 0, 'd-new')] });
    await screen.findByTestId('trust-docs-library-empty');
    const rows = (await screen.findAllByTestId(/^trust-doc-linked-/)).map((e) => e.getAttribute('data-testid'));
    expect(rows).toEqual(['trust-doc-linked-d-a', 'trust-doc-linked-d-b']);
    expect(screen.getByTestId('trust-doc-superseded-d-a')).toBeInTheDocument();
    expect(screen.queryByTestId('trust-doc-superseded-d-b')).toBeNull();
    fireEvent.click(screen.getByTestId('trust-docs-save'));
    await waitFor(() => expect(api.updateTrustDocuments).toHaveBeenCalledWith(orgFetch, 'o1', [
      { documentId: 'd-a', visibility: 'public', disclosureConfirmed: true },
      { documentId: 'd-b', visibility: 'public', disclosureConfirmed: true },
    ]));
  });
  it('re-seeds the list when the server documents change', async () => {
    const { rerender } = render(<TrustDocumentsSection orgId="o1" orgFetch={orgFetch} canWrite documents={[]} onReload={vi.fn(async () => {})} />);
    await screen.findByTestId('trust-docs-linked-empty');
    rerender(<TrustDocumentsSection orgId="o1" orgFetch={orgFetch} canWrite documents={[sd('d-pol', 'Security policy', 0)]} onReload={vi.fn(async () => {})} />);
    expect(await screen.findByTestId('trust-doc-linked-d-pol')).toBeInTheDocument();
  });
  it('removes a linked document and disables controls without write', async () => {
    mount({ canWrite: false, documents: [{ documentId: 'd-pol', title: 'Security policy', disclosureConfirmed: true }] });
    expect(await screen.findByTestId('trust-docs-save')).toBeDisabled();
    expect(screen.getByTestId('trust-doc-remove-d-pol')).toBeDisabled();
    expect(await screen.findByTestId('trust-doc-add-d-ev')).toBeDisabled();
  });
});
