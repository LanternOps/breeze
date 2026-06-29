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
});
