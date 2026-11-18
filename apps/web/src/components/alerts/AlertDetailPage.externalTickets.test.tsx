import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../lib/i18n';
vi.mock('../remediation/RemediationSuggestionsPanel', () => ({ default: () => null }));
vi.mock('../../lib/permissions', () => ({ usePermissions: () => ({ can: () => true }), hasPermission: () => true }));
const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args), registerOrgIdProvider: vi.fn() }));
import AlertDetailPage from './AlertDetailPage';
const alert = { id: 'alert-1', orgId: 'org-1', title: 'CPU high', message: 'CPU over 90%', severity: 'critical', status: 'acknowledged', deviceId: 'device-1', deviceName: 'web-01', triggeredAt: '2026-10-29T00:00:00Z' };
const ref = { source: 'partner_api', partnerServicePrincipalId: 'principal-1', externalId: 'id-42', externalNumber: 'INC-42', externalUrl: 'https://psa.example/42' };
function responses(refs: unknown[], ok = true) {
  fetchWithAuth.mockImplementation(async (url: string) => ({
    ok: url.endsWith('/external-tickets') ? ok : true, status: 200,
    json: async () => url.endsWith('/external-tickets') ? { data: refs } : url.endsWith('/tickets') ? { data: [] } : alert,
  }));
}
beforeEach(() => { fetchWithAuth.mockReset(); });
describe('AlertDetailPage external tickets', () => {
  it('renders the number and secure link using the staff read endpoint', async () => {
    responses([ref]); render(<AlertDetailPage alertId={alert.id} />);
    const link = await screen.findByTestId('alert-external-ticket-link');
    expect(link.textContent).toBe('INC-42');
    expect(link.getAttribute('href')).toBe(ref.externalUrl);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(fetchWithAuth).toHaveBeenCalledWith('/alerts/alert-1/external-tickets');
  });
  it.each([null, 'http://psa.example/42', 'javascript:alert(1)', 'ftp://psa.example/42'])('renders an unlinked id for %s', async externalUrl => {
    responses([{ ...ref, externalNumber: null, externalUrl }]); render(<AlertDetailPage alertId={alert.id} />);
    const chip = await screen.findByTestId('alert-external-ticket-label');
    expect(chip.textContent).toBe('id-42');
    expect(screen.queryByTestId('alert-external-ticket-link')).toBeNull();
  });
  it('hides the section when no external tickets exist', async () => {
    responses([]); render(<AlertDetailPage alertId={alert.id} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/alerts/alert-1/external-tickets'));
    expect(screen.queryByTestId('alert-external-tickets')).toBeNull();
  });
  it('shows a read failure without hiding the alert', async () => {
    responses([], false); render(<AlertDetailPage alertId={alert.id} />);
    expect(await screen.findByTestId('alert-external-tickets-error')).toBeTruthy();
  });
});
