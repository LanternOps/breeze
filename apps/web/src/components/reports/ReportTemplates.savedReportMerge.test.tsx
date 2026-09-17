import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: 'org-1' }) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import ReportTemplates from './ReportTemplates';

// GET /reports/templates returns the org's saved reports. Using a curated
// template saves a report carrying the curated name, so a saved report's
// card should replace the synthetic curated card — but each saved report
// keeps its own identity, so two saved reports that both kept the curated
// name must render as two cards, not collapse onto one.
function mockSavedReports(rows: Record<string, unknown>[]) {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url === '/reports/templates') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: rows, pagination: {} }) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

describe('ReportTemplates — saved reports merged into curated cards', () => {
  beforeEach(() => vi.clearAllMocks());

  it('replaces the curated card with the saved report when exactly one matches', async () => {
    mockSavedReports([
      {
        id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
        name: 'Hardware Lifecycle Report',
        type: 'hardware_lifecycle',
        schedule: 'monthly',
        format: 'pdf',
        config: { dateRange: { preset: 'last_30_days' } }
      }
    ]);
    render(<ReportTemplates />);

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/reports/templates'));
    await waitFor(() => expect(screen.queryByText(/syncing/i)).toBeNull());

    // The saved report's card stands in for the synthetic curated one — still one card.
    expect(screen.getAllByText('Hardware Lifecycle Report')).toHaveLength(1);
  });

  it('renders a separate card per saved report when several share a curated name', async () => {
    mockSavedReports([
      {
        id: '5d0f4c1e-9c3b-4a7e-9c2f-1c9a6f1d2b33',
        name: 'Hardware Lifecycle Report',
        type: 'hardware_lifecycle',
        schedule: 'weekly',
        format: 'pdf',
        config: { dateRange: { preset: 'last_30_days' } }
      },
      {
        id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
        name: 'Hardware Lifecycle Report',
        type: 'hardware_lifecycle',
        schedule: 'monthly',
        format: 'pdf',
        config: { dateRange: { preset: 'last_30_days' } }
      }
    ]);
    render(<ReportTemplates />);

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/reports/templates'));
    await waitFor(() => expect(screen.queryByText(/syncing/i)).toBeNull());

    // Neither saved report is shadowed — both get their own card, keyed by
    // their own id, and no synthetic curated card is rendered alongside them.
    expect(screen.getAllByText('Hardware Lifecycle Report')).toHaveLength(2);
    // Total template count grows by one: 9 curated cards (#5784 W02 added
    // Threat Detection Review, W03 added the Intune endpoint-management
    // card, W04 added the Vulnerability Management card, W06 added Identity &
    // Access Review), with the hardware-lifecycle slot expanded from 1 card
    // to 2.
    expect(screen.getAllByRole('button', { name: 'Use template' })).toHaveLength(10);
  });

  it('dedupes two saved-report rows that share the same id instead of rendering both', async () => {
    mockSavedReports([
      {
        id: '5d0f4c1e-9c3b-4a7e-9c2f-1c9a6f1d2b33',
        name: 'Ad Hoc Report',
        type: 'executive_summary',
        schedule: 'one_time',
        format: 'pdf',
        config: { dateRange: { preset: 'last_30_days' } }
      },
      {
        id: '5d0f4c1e-9c3b-4a7e-9c2f-1c9a6f1d2b33',
        name: 'Ad Hoc Report',
        type: 'executive_summary',
        schedule: 'one_time',
        format: 'pdf',
        config: { dateRange: { preset: 'last_30_days' } }
      }
    ]);
    render(<ReportTemplates />);

    // A duplicate row (same id twice, e.g. a pagination overlap) must not
    // produce two React elements sharing a key — first occurrence wins.
    expect(await screen.findByText('Ad Hoc Report')).toBeTruthy();
    expect(screen.getAllByText('Ad Hoc Report')).toHaveLength(1);
  });

  it('still lists a saved report with a novel name as its own card', async () => {
    mockSavedReports([
      {
        id: '5d0f4c1e-9c3b-4a7e-9c2f-1c9a6f1d2b33',
        name: 'Quarterly board pack',
        type: 'executive_summary',
        schedule: 'quarterly',
        format: 'pdf',
        config: { dateRange: { preset: 'last_90_days' } }
      }
    ]);
    render(<ReportTemplates />);

    expect(await screen.findByText('Quarterly board pack')).toBeTruthy();
    expect(screen.getAllByText('Hardware Lifecycle Report')).toHaveLength(1);
  });
});
