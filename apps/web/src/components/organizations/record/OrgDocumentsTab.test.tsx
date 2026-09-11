import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('@/components/shared/Toast', () => ({ showToast }));
// The record's own fetcher must be the ONLY door out of this tab.
const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('@/stores/auth', () => ({ fetchWithAuth }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      (vars && Object.keys(vars).length ? `${key}:${JSON.stringify(vars)}` : key),
  }),
}));

import OrgDocumentsTab from './OrgDocumentsTab';
import type { OrgFetch } from './orgRecordFetch';

const ORG = 'org-1';
const doc = (over: Record<string, unknown> = {}) => ({
  id: 'd1', orgId: ORG, title: 'Firewall baseline', description: null, category: 'baseline',
  contentType: 'application/pdf', byteSize: 2048, sha256: 'a'.repeat(64), originalFilename: 'fw.pdf',
  uploadedByUserId: 'u1', portalVisible: false, supersedesDocumentId: null, supersededByDocumentId: null,
  createdAt: '2026-10-01T00:00:00.000Z', ...over,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let orgFetch: ReturnType<typeof vi.fn>;
const renderTab = () => render(<OrgDocumentsTab orgId={ORG} orgFetch={orgFetch as unknown as OrgFetch} />);
const pdf = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'runbook.pdf', { type: 'application/pdf' });

describe('OrgDocumentsTab (#5573 W03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgFetch = vi.fn(async (path: string) => {
      if (path.startsWith(`/orgs/${ORG}/documents?`) || path === `/orgs/${ORG}/documents`) return json({ data: [doc()] });
      return json({ data: doc() });
    });
  });

  it('lists documents through orgFetch, never through ambient fetchWithAuth', async () => {
    renderTab();
    expect(await screen.findByTestId('org-documents-table')).toBeInTheDocument();
    expect(orgFetch).toHaveBeenCalled();
    expect(orgFetch.mock.calls[0]![0]).toContain(`/orgs/${ORG}/documents`);
    expect(fetchWithAuth).not.toHaveBeenCalled();
    expect(screen.getByText('Firewall baseline')).toBeInTheDocument();
    // Exactly one load: the effect must not depend on a render-unstable value
    // (a non-memoised `t` made it refetch on every render).
    expect(orgFetch.mock.calls).toHaveLength(1);
  });

  it('shows the failure message instead of an empty library when the load fails', async () => {
    orgFetch.mockResolvedValue(json({ error: 'boom', code: 'NOT_FOUND' }, 404));
    renderTab();
    expect(await screen.findByTestId('org-documents-error')).toBeInTheDocument();
    expect(screen.queryByTestId('org-documents-table')).not.toBeInTheDocument();
  });

  it('filters by category through the query string', async () => {
    renderTab();
    await screen.findByTestId('org-documents-table');
    await userEvent.selectOptions(screen.getByTestId('org-documents-category-filter'), 'runbook');
    await waitFor(() => expect(orgFetch.mock.calls.at(-1)![0]).toContain('category=runbook'));
  });

  it('includeSuperseded is sent explicitly as false, never omitted-as-true', async () => {
    renderTab();
    await screen.findByTestId('org-documents-table');
    expect(orgFetch.mock.calls[0]![0]).toContain('includeSuperseded=false');
    await userEvent.click(screen.getByTestId('org-documents-show-superseded'));
    await waitFor(() => expect(orgFetch.mock.calls.at(-1)![0]).toContain('includeSuperseded=true'));
  });

  it('uploading posts multipart (no Content-Type header) and toasts on success', async () => {
    renderTab();
    await screen.findByTestId('org-documents-table');
    await userEvent.click(screen.getByTestId('org-documents-upload-open'));
    await userEvent.type(screen.getByTestId('org-document-title'), 'Runbook');
    await userEvent.upload(screen.getByTestId('org-document-file'), pdf());
    orgFetch.mockResolvedValueOnce(json({ data: doc({ id: 'd2', title: 'Runbook' }) }, 201));
    await userEvent.click(screen.getByTestId('org-document-submit'));
    await waitFor(() => {
      const call = orgFetch.mock.calls.find((c) => c[1]?.method === 'POST');
      expect(call).toBeDefined();
      expect(call![1].body).toBeInstanceOf(FormData);
      expect((call![1].headers ?? {})['Content-Type']).toBeUndefined();
    });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('surfaces a 415 upload failure as the translated unsupported-type message, not a generic error', async () => {
    renderTab();
    await screen.findByTestId('org-documents-table');
    await userEvent.click(screen.getByTestId('org-documents-upload-open'));
    await userEvent.type(screen.getByTestId('org-document-title'), 'Runbook');
    await userEvent.upload(screen.getByTestId('org-document-file'), pdf());
    orgFetch.mockResolvedValueOnce(json({ error: 'nope', code: 'UNSUPPORTED_DOCUMENT_TYPE' }, 415));
    await userEvent.click(screen.getByTestId('org-document-submit'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: expect.stringContaining('unsupportedType'),
    })));
  });

  it('replace posts to /replace and shows the 409 NOT_HEAD message from the response body', async () => {
    renderTab();
    await screen.findByTestId('org-documents-table');
    await userEvent.click(screen.getByTestId('org-document-replace-d1'));
    await userEvent.upload(screen.getByTestId('org-document-file'), pdf());
    orgFetch.mockResolvedValueOnce(json({ error: 'stale', code: 'NOT_HEAD' }, 409));
    await userEvent.click(screen.getByTestId('org-document-submit'));
    await waitFor(() => {
      const call = orgFetch.mock.calls.find((c) => String(c[0]).endsWith('/replace'));
      expect(call).toBeDefined();
    });
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: expect.stringContaining('notHead'),
    })));
  });

  it('toggling the portal switch PATCHes portalVisible', async () => {
    renderTab();
    await screen.findByTestId('org-documents-table');
    orgFetch.mockResolvedValueOnce(json({ data: doc({ portalVisible: true }) }));
    await userEvent.click(screen.getByTestId('org-document-portal-d1'));
    await waitFor(() => {
      const call = orgFetch.mock.calls.find((c) => c[1]?.method === 'PATCH');
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1].body))).toEqual({ portalVisible: true });
    });
  });

  it('delete asks for confirmation first and does nothing when declined', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderTab();
    await screen.findByTestId('org-documents-table');
    await userEvent.click(screen.getByTestId('org-document-delete-d1'));
    expect(confirmSpy).toHaveBeenCalled();
    expect(orgFetch.mock.calls.some((c) => c[1]?.method === 'DELETE')).toBe(false);
    confirmSpy.mockRestore();
  });

  it('delete sends DELETE once confirmed', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderTab();
    await screen.findByTestId('org-documents-table');
    orgFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await userEvent.click(screen.getByTestId('org-document-delete-d1'));
    await waitFor(() => expect(orgFetch.mock.calls.some((c) => c[1]?.method === 'DELETE')).toBe(true));
    confirmSpy.mockRestore();
  });

  it('downloads through orgFetch as a blob — the content path is never a plain link', async () => {
    const createObjectURL = vi.fn(() => 'blob:doc');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderTab();
    const table = await screen.findByTestId('org-documents-table');
    expect(within(table).queryByRole('link')).toBeNull();
    orgFetch.mockResolvedValueOnce({ ok: true, status: 200, blob: async () => new Blob(['%PDF-']) } as unknown as Response);
    await userEvent.click(screen.getByTestId('org-document-download-d1'));
    await waitFor(() => expect(orgFetch.mock.calls.some((c) => String(c[0]).endsWith('/content'))).toBe(true));
    await waitFor(() => expect(open).toHaveBeenCalledWith('blob:doc', '_blank', 'noopener'));
    open.mockRestore();
  });

  it('badges a superseded row and keeps its download available', async () => {
    orgFetch.mockResolvedValueOnce(json({ data: [doc({ supersededByDocumentId: 'd2' })] }));
    renderTab();
    await screen.findByTestId('org-documents-table');
    expect(screen.getByTestId('org-document-superseded-d1')).toBeInTheDocument();
    expect(screen.getByTestId('org-document-download-d1')).toBeInTheDocument();
    // An earlier version cannot be replaced or deleted — the current one is.
    expect(screen.queryByTestId('org-document-replace-d1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('org-document-delete-d1')).not.toBeInTheDocument();
  });
});
