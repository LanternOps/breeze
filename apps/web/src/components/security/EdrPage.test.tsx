import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, it, expect, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('./S1ThreatList', () => ({ default: () => <div data-testid="s1-list" /> }));
vi.mock('./HuntressIncidentList', () => ({ default: () => <div data-testid="huntress-list" /> }));
vi.mock('./OtherEdrDetectionList', () => ({ default: () => <div data-testid="other-edr-list" /> }));

import EdrPage from './EdrPage';

const coverage = { orgsWithEdr: 1, partial: false, notes: [] };
const provider = (key: string, label: string) => ({
  provider: key, label, endpoints: 1, linkedEndpoints: 1, unhealthyEndpoints: 0, openDetections: 0, lastDetectionSyncAt: null,
});

function statusResponse(providers: unknown[]) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: { providers, coverage } }) } as Response;
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  window.location.hash = '';
});

describe('EdrPage', () => {
  it('defaults to the SentinelOne tab and switches to Huntress', async () => {
    fetchWithAuth.mockResolvedValue(statusResponse([]));
    render(<EdrPage />);
    expect(screen.getByTestId('s1-list')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('edr-tab-huntress'));
    expect(screen.getByTestId('huntress-list')).toBeInTheDocument();
    expect(window.location.hash).toBe('#huntress');
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
  });

  it('hides the Other EDR tab when there are zero providers', async () => {
    fetchWithAuth.mockResolvedValue(statusResponse([]));
    render(<EdrPage />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('edr-tab-other-edr')).not.toBeInTheDocument();
  });

  it('hides the Other EDR tab when the status call fails', async () => {
    fetchWithAuth.mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error', json: async () => ({}) } as Response);
    render(<EdrPage />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('edr-tab-other-edr')).not.toBeInTheDocument();
  });

  it('labels the tab with the provider label when exactly one provider exists', async () => {
    fetchWithAuth.mockResolvedValue(statusResponse([provider('bitdefender', 'Bitdefender GravityZone')]));
    render(<EdrPage />);
    expect(await screen.findByTestId('edr-tab-other-edr')).toHaveTextContent('Bitdefender GravityZone');
  });

  it('labels the tab "Other EDR" when two distinct providers exist', async () => {
    fetchWithAuth.mockResolvedValue(
      statusResponse([provider('bitdefender', 'Bitdefender GravityZone'), provider('acme', 'Acme EDR')]),
    );
    render(<EdrPage />);
    expect(await screen.findByTestId('edr-tab-other-edr')).toHaveTextContent('Other EDR');
  });

  it('keeps the provider label when one provider has several connections', async () => {
    fetchWithAuth.mockResolvedValue(
      statusResponse([provider('bitdefender', 'Bitdefender GravityZone'), provider('bitdefender', 'Bitdefender GravityZone')]),
    );
    render(<EdrPage />);
    expect(await screen.findByTestId('edr-tab-other-edr')).toHaveTextContent('Bitdefender GravityZone');
  });

  it('selects the Other EDR tab from #other-edr', async () => {
    window.location.hash = '#other-edr';
    fetchWithAuth.mockResolvedValue(statusResponse([provider('bitdefender', 'Bitdefender GravityZone')]));
    render(<EdrPage />);
    expect(await screen.findByTestId('other-edr-list')).toBeInTheDocument();
    expect(screen.queryByTestId('s1-list')).not.toBeInTheDocument();
  });

  it('falls back to SentinelOne when #other-edr is set but the tab is hidden', async () => {
    window.location.hash = '#other-edr';
    fetchWithAuth.mockResolvedValue(statusResponse([]));
    render(<EdrPage />);
    expect(await screen.findByTestId('s1-list')).toBeInTheDocument();
    expect(screen.queryByTestId('other-edr-list')).not.toBeInTheDocument();
  });
});
