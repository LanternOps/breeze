import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
vi.mock('@/lib/permissions', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../layout/usePageItemName', () => ({ usePageItemName: () => undefined }));
vi.mock('../devices/networkIsolation/ReleaseDialog', () => ({ default: () => <div data-testid="shared-release-dialog" /> }));
import IncidentDetailPage from './IncidentDetailPage';
const episode = { id: 'episode-1', deviceId: 'device-1', incidentId: 'incident-1', state: 'applied', expiresAt: '2026-11-05T12:00:00Z' };
beforeEach(() => fetchWithAuth.mockReset());
describe('IncidentDetailPage isolation', () => {
  it('shows only this incident’s device episodes and can release with a closed incident and flag off', async () => {
    fetchWithAuth.mockImplementation(async (url: string) => ({ ok: true, status: 200, json: async () => url.startsWith('/incidents/') ? {
      incident: { id: 'incident-1', title: 'Incident', severity: 'p1', status: 'closed', affectedDevices: ['device-1'], detectedAt: '2026-11-02T00:00:00Z' }, timeline: [], actions: [], evidence: [],
    } : url === '/devices/device-1' ? { status: 'offline', hostname: 'control.example.test' } : { episodes: [episode, { ...episode, id: 'other', incidentId: 'incident-2', state: 'verified' }], startEligibility: { allowed: false, reason: 'feature_disabled' } } }));
    render(<IncidentDetailPage incidentId="incident-1" />);
    expect(await screen.findByText('Verifying isolation')).toBeInTheDocument();
    expect(screen.getAllByTestId('isolation-badge')).toHaveLength(1);
    expect(fetchWithAuth).toHaveBeenCalledWith('/devices/device-1/network-isolation');
    const release = screen.getByTestId('incident-isolation-release');
    expect(release).toBeEnabled();
    expect(await screen.findByText('Release (queued until the device reconnects)')).toBeEnabled();
    fireEvent.click(release);
    expect(screen.getByTestId('shared-release-dialog')).toBeInTheDocument();
  });
  it('retains release when device metadata is unavailable', async () => {
    fetchWithAuth.mockImplementation(async (url: string) => ({ ok: url !== '/devices/device-1', status: url === '/devices/device-1' ? 403 : 200, json: async () => url.startsWith('/incidents/') ? {
      incident: { id: 'incident-1', title: 'Incident', severity: 'p1', status: 'closed', affectedDevices: ['device-1'], detectedAt: '2026-11-02T00:00:00Z' },
    } : { episodes: [episode], startEligibility: { allowed: false, reason: 'trust_restricted' } } }));
    render(<IncidentDetailPage incidentId="incident-1" />);
    expect(await screen.findByTestId('incident-isolation-release')).toBeEnabled();
  });
});
