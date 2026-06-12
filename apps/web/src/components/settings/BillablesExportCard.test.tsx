import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

// jsdom doesn't support anchor .click() navigation — stub it so the download
// path doesn't throw.
vi.stubGlobal('HTMLAnchorElement', class extends HTMLAnchorElement {
  click() { /* no-op in jsdom */ }
});

import BillablesExportCard from './BillablesExportCard';

beforeEach(() => {
  fetchWithAuth.mockReset();
  showToast.mockReset();
  fetchWithAuth.mockImplementation(async (url: string) =>
    url.startsWith('/orgs/organizations')
      ? ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'o-1', name: 'Acme' }] }) } as Response)
      : ({ ok: true, status: 200, blob: async () => new Blob(['date,type'], { type: 'text/csv' }) } as unknown as Response));
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});

describe('BillablesExportCard', () => {
  it('downloads the CSV with from/to/orgId params', async () => {
    render(<BillablesExportCard />);
    await screen.findByTestId('billables-export-org');
    fireEvent.change(screen.getByTestId('billables-export-from'), { target: { value: '2026-06-01' } });
    fireEvent.change(screen.getByTestId('billables-export-to'), { target: { value: '2026-06-12' } });
    fireEvent.change(screen.getByTestId('billables-export-org'), { target: { value: 'o-1' } });
    fireEvent.click(screen.getByTestId('billables-export-download'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(expect.stringMatching(/^\/tickets\/export\/billables\.csv\?from=2026-06-01&to=2026-06-12&orgId=o-1$/)));
  });

  it('shows an error toast when the export fails', async () => {
    render(<BillablesExportCard />);
    await screen.findByTestId('billables-export-org');
    fetchWithAuth.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: 'window too large' }) } as Response);
    fireEvent.click(screen.getByTestId('billables-export-download'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
  });
});
