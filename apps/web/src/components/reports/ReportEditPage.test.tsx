import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

import ReportEditPage from './ReportEditPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (
  payload: unknown,
  ok = true,
  status = ok ? 200 : 500,
): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('ReportEditPage back link (#7158)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // #7158: the icon-only back-arrow link in the not-found/error state had no
  // accessible name; it now carries aria-label={t('reports.reportEditPage.backToReports')}.
  it('gives the back link an accessible name when the report is not found', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({}, false, 404));

    const { container } = render(<ReportEditPage reportId="missing-report" />);

    await waitFor(() =>
      expect(screen.getByTestId('report-edit-not-found')).toBeInTheDocument(),
    );

    // Two links share the visible/accessible text "Back to Reports" in this
    // state (the icon-only header link and a text CTA below) — target the
    // icon-only one by its aria-label attribute, the actual regression surface.
    const iconOnlyBackLink = container.querySelector('a[aria-label="Back to Reports"]');
    expect(iconOnlyBackLink).toHaveAttribute('href', '/reports');
  });
});
