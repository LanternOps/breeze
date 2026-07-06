import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEdrReadiness } from './useEdrReadiness';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function HuntressProbe() {
  const r = useEdrReadiness(['huntress']).huntress;
  return (
    <div>
      <span data-testid="status">{r.status}</span>
      <span data-testid="orgs">{r.mappedOrgCount ?? -1}</span>
      <span data-testid="gap">{r.firstGap?.key ?? 'none'}</span>
    </div>
  );
}

function S1Probe({ versions }: { versions: number }) {
  const r = useEdrReadiness(['sentinelone'], { s1VersionCount: versions }).sentinelone;
  return (
    <div>
      <span data-testid="status">{r.status}</span>
      <span data-testid="gap">{r.firstGap?.key ?? 'none'}</span>
      <span data-testid="checks">{r.checks.map((c) => c.key).join(',')}</span>
    </div>
  );
}

describe('useEdrReadiness (huntress)', () => {
  beforeEach(() => fetchMock.mockReset());

  it('reports ready when connected, account key set, and orgs mapped', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { isActive: true, hasAccountKey: true, lastSyncOrgs: 3 } }),
    );
    render(<HuntressProbe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('orgs')).toHaveTextContent('3');
    expect(screen.getByTestId('gap')).toHaveTextContent('none');
  });

  it('reports incomplete with the account-key gap first', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { isActive: true, hasAccountKey: false, lastSyncOrgs: 3 } }),
    );
    render(<HuntressProbe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('incomplete'));
    expect(screen.getByTestId('gap')).toHaveTextContent('accountKey');
  });

  it('reports incomplete/disconnected when data is null', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: null }));
    render(<HuntressProbe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('incomplete'));
    expect(screen.getByTestId('gap')).toHaveTextContent('connected');
  });

  it('reports unknown when the fetch fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false));
    render(<HuntressProbe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unknown'));
  });
});

describe('useEdrReadiness (sentinelone)', () => {
  beforeEach(() => fetchMock.mockReset());

  it('is ready when connected and the installer is uploaded (no site-token check available)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { isActive: true } })); // /s1/integration
    render(<S1Probe versions={1} />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    // Only the two provable checks — no invented site-token check.
    expect(screen.getByTestId('checks')).toHaveTextContent('connected,installerUploaded');
  });

  it('flags the installer-upload gap when no version is uploaded', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { isActive: true } }));
    render(<S1Probe versions={0} />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('incomplete'));
    expect(screen.getByTestId('gap')).toHaveTextContent('installerUploaded');
  });
});
