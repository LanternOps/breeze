import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import QuickbooksCustomerImport from './QuickbooksCustomerImport';

const fetchWithAuthMock = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuthMock(...a) }));

// runAction surfaces success/error toasts via showToast from ../shared/Toast.
const showToastMock = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToastMock(...a) }));

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('QuickbooksCustomerImport', () => {
  it('loads customers and disables already-imported rows', async () => {
    fetchWithAuthMock.mockReturnValueOnce(jsonResponse({ data: [
      { id: '1', displayName: 'Acme', email: 'a@acme.test', alreadyImported: false, organizationId: null },
      { id: '2', displayName: 'Imported Inc', alreadyImported: true, organizationId: 'org-2' },
    ] }));

    render(<QuickbooksCustomerImport />);
    fireEvent.click(screen.getByTestId('quickbooks-import-load'));

    await waitFor(() => expect(screen.getByTestId('quickbooks-import-row-1')).toBeInTheDocument());
    expect(screen.getByTestId('quickbooks-import-select-1')).not.toBeDisabled();
    expect(screen.getByTestId('quickbooks-import-select-2')).toBeDisabled();
  });

  it('imports selected customers and surfaces the summary via runAction', async () => {
    fetchWithAuthMock
      .mockReturnValueOnce(jsonResponse({ data: [{ id: '1', displayName: 'Acme', alreadyImported: false, organizationId: null }] }))
      .mockReturnValueOnce(jsonResponse({ data: { imported: [{ customerId: '1', organizationId: 'org-1', siteId: 's1' }], skipped: [], errors: [] } }))
      .mockReturnValueOnce(jsonResponse({ data: [{ id: '1', displayName: 'Acme', alreadyImported: true, organizationId: 'org-1' }] }));

    render(<QuickbooksCustomerImport />);
    fireEvent.click(screen.getByTestId('quickbooks-import-load'));
    await waitFor(() => expect(screen.getByTestId('quickbooks-import-select-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quickbooks-import-select-1'));
    fireEvent.click(screen.getByTestId('quickbooks-import-submit'));

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
    // POST body carried the selected id.
    const postCall = fetchWithAuthMock.mock.calls[1]!;
    expect(postCall[0]).toBe('/accounting/quickbooks/customers/import');
    expect(JSON.parse((postCall[1] as RequestInit).body as string)).toEqual({ customerIds: ['1'] });
  });

  it('shows an error toast when loading fails', async () => {
    fetchWithAuthMock.mockReturnValueOnce(jsonResponse({ error: 'not connected' }, 404));
    render(<QuickbooksCustomerImport />);
    fireEvent.click(screen.getByTestId('quickbooks-import-load'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
  });

  it('shows an ERROR toast and lists failures when every selected customer fails', async () => {
    fetchWithAuthMock
      .mockReturnValueOnce(jsonResponse({ data: [{ id: '1', displayName: 'Acme', alreadyImported: false, organizationId: null }] }))
      .mockReturnValueOnce(jsonResponse({ data: { imported: [], skipped: [], errors: [{ customerId: '1', displayName: 'Acme', error: 'boom' }] } }))
      .mockReturnValueOnce(jsonResponse({ data: [{ id: '1', displayName: 'Acme', alreadyImported: false, organizationId: null }] }));

    render(<QuickbooksCustomerImport />);
    fireEvent.click(screen.getByTestId('quickbooks-import-load'));
    await waitFor(() => expect(screen.getByTestId('quickbooks-import-select-1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('quickbooks-import-select-1'));
    fireEvent.click(screen.getByTestId('quickbooks-import-submit'));

    // A total failure must NOT be a green success toast.
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(showToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    // The failed customer + reason are surfaced, not just a count.
    await waitFor(() => expect(screen.getByTestId('quickbooks-import-failure-1')).toHaveTextContent('boom'));
  });

  it('shows a WARNING toast on partial failure', async () => {
    fetchWithAuthMock
      .mockReturnValueOnce(jsonResponse({ data: [
        { id: '1', displayName: 'A', alreadyImported: false, organizationId: null },
        { id: '2', displayName: 'B', alreadyImported: false, organizationId: null },
      ] }))
      .mockReturnValueOnce(jsonResponse({ data: { imported: [{ customerId: '1' }], skipped: [], errors: [{ customerId: '2', displayName: 'B', error: 'boom' }] } }))
      .mockReturnValueOnce(jsonResponse({ data: [] }));

    render(<QuickbooksCustomerImport />);
    fireEvent.click(screen.getByTestId('quickbooks-import-load'));
    await waitFor(() => expect(screen.getByTestId('quickbooks-import-select-all')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('quickbooks-import-select-all'));
    fireEvent.click(screen.getByTestId('quickbooks-import-submit'));

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' })));
  });

  it('select-all toggles only importable rows, never the already-imported ones', async () => {
    fetchWithAuthMock.mockReturnValueOnce(jsonResponse({ data: [
      { id: '1', displayName: 'Importable', alreadyImported: false, organizationId: null },
      { id: '2', displayName: 'Done', alreadyImported: true, organizationId: 'org-2' },
    ] }));

    render(<QuickbooksCustomerImport />);
    fireEvent.click(screen.getByTestId('quickbooks-import-load'));
    await waitFor(() => expect(screen.getByTestId('quickbooks-import-select-all')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quickbooks-import-select-all'));
    expect(screen.getByTestId('quickbooks-import-select-1')).toBeChecked();
    expect(screen.getByTestId('quickbooks-import-select-2')).not.toBeChecked();
    expect(screen.getByTestId('quickbooks-import-select-2')).toBeDisabled();

    fireEvent.click(screen.getByTestId('quickbooks-import-select-all'));
    expect(screen.getByTestId('quickbooks-import-select-1')).not.toBeChecked();
  });
});
