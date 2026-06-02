import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchWithAuth } from '../../stores/auth';

// Stub the heavy deps so the test only exercises the Current-org / All-orgs
// toggle wiring on DevicesPage (state, hash sync, lockedOrgFilter prop).
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const useOrgStoreMock = vi.fn();
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => useOrgStoreMock() }));

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

vi.mock('../../hooks/useEventStream', () => ({
  useEventStream: () => ({
    subscribe: vi.fn(() => () => undefined),
    unsubscribe: vi.fn(),
    status: 'open' as const,
  }),
}));

// DeviceList rendering would pull in localStorage / FilterBuilder / charts.
// The toggle test only cares that the lockedOrgFilter prop is threaded
// through correctly, so render a thin probe in its place.
vi.mock('./DeviceList', () => ({
  __esModule: true,
  default: (props: { lockedOrgFilter: string | null; devices: Array<{ id: string }> }) => (
    <div
      data-testid="device-list-stub"
      data-locked-org={String(props.lockedOrgFilter)}
      data-device-count={props.devices.length}
    />
  ),
}));

vi.mock('./DeviceCard', () => ({
  __esModule: true,
  default: ({ device }: { device: { id: string; orgId: string } }) => (
    <div data-testid="device-card" data-org-id={device.orgId}>{device.id}</div>
  ),
}));

vi.mock('./ScriptPickerModal', () => ({ __esModule: true, default: () => null }));
vi.mock('./DeviceSettingsModal', () => ({ __esModule: true, default: () => null }));
vi.mock('./AddDeviceModal', () => ({ __esModule: true, default: () => null }));
vi.mock('./CreateGroupModal', () => ({ __esModule: true, default: () => null }));
vi.mock('../filters/DeviceFilterBar', () => ({
  __esModule: true,
  DeviceFilterBar: () => null,
  default: () => null,
}));
vi.mock('../shared/ProgressBar', () => ({ __esModule: true, default: () => null }));

import DevicesPage from './DevicesPage';

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

function jsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return ({
    ok,
    status,
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;
}

function mockApis(devices: Array<Record<string, unknown>>, orgs: Array<{ id: string; name: string }>) {
  fetchWithAuthMock.mockImplementation((url: string) => {
    if (url.startsWith('/devices?')) return Promise.resolve(jsonResponse({ data: devices }));
    if (url.startsWith('/orgs/sites')) return Promise.resolve(jsonResponse({ data: [] }));
    if (url.startsWith('/orgs')) return Promise.resolve(jsonResponse({ data: orgs }));
    if (url.startsWith('/device-groups')) return Promise.resolve(jsonResponse({ data: [] }));
    return Promise.resolve(jsonResponse({}));
  });
}

describe('DevicesPage — Current-org / All-orgs scope toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStoreMock.mockReturnValue({
      currentOrgId: 'org-a',
      organizations: [
        { id: 'org-a', name: 'Acme Inc' },
        { id: 'org-b', name: 'Beta LLC' },
      ],
    });
    window.history.replaceState(null, '', '/devices');
  });

  it('defaults to Current-org scope and threads currentOrgId down to DeviceList as lockedOrgFilter', async () => {
    mockApis(
      [
        { id: 'd1', orgId: 'org-a', hostname: 'pc-a-1', osType: 'windows', status: 'online' },
        { id: 'd2', orgId: 'org-b', hostname: 'pc-b-1', osType: 'windows', status: 'online' },
      ],
      [
        { id: 'org-a', name: 'Acme Inc' },
        { id: 'org-b', name: 'Beta LLC' },
      ]
    );

    render(<DevicesPage />);

    await waitFor(() => {
      expect(screen.getByTestId('device-list-stub')).toBeInTheDocument();
    });

    const currentBtn = screen.getByTestId('org-scope-current');
    const allBtn = screen.getByTestId('org-scope-all');
    expect(currentBtn).toHaveAttribute('aria-pressed', 'true');
    expect(allBtn).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('device-list-stub')).toHaveAttribute('data-locked-org', 'org-a');
  });

  it('switches to All-orgs, sets lockedOrgFilter to null, and writes #scope=all to the URL hash', async () => {
    mockApis(
      [{ id: 'd1', orgId: 'org-a', hostname: 'pc-a-1', osType: 'windows', status: 'online' }],
      [{ id: 'org-a', name: 'Acme Inc' }]
    );

    render(<DevicesPage />);

    await waitFor(() => {
      expect(screen.getByTestId('device-list-stub')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('org-scope-all'));

    await waitFor(() => {
      expect(screen.getByTestId('org-scope-all')).toHaveAttribute('aria-pressed', 'true');
    });
    expect(screen.getByTestId('org-scope-current')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('device-list-stub')).toHaveAttribute('data-locked-org', 'null');
    expect(window.location.hash).toBe('#scope=all');
  });

  it('clears the hash when toggling back from All-orgs to Current-org', async () => {
    window.history.replaceState(null, '', '/devices#scope=all');
    mockApis(
      [{ id: 'd1', orgId: 'org-a', hostname: 'pc-a', osType: 'windows', status: 'online' }],
      [{ id: 'org-a', name: 'Acme' }]
    );

    render(<DevicesPage />);

    await waitFor(() => {
      expect(screen.getByTestId('org-scope-all')).toHaveAttribute('aria-pressed', 'true');
    });

    fireEvent.click(screen.getByTestId('org-scope-current'));

    await waitFor(() => {
      expect(screen.getByTestId('org-scope-current')).toHaveAttribute('aria-pressed', 'true');
    });
    expect(window.location.hash).toBe('');
  });

  it('hydrates the toggle from #scope=all on initial mount (URL deep-link)', async () => {
    window.history.replaceState(null, '', '/devices#scope=all');
    mockApis(
      [{ id: 'd1', orgId: 'org-a', hostname: 'pc-a', osType: 'windows', status: 'online' }],
      [{ id: 'org-a', name: 'Acme' }]
    );

    render(<DevicesPage />);

    await waitFor(() => {
      expect(screen.getByTestId('device-list-stub')).toBeInTheDocument();
    });
    expect(screen.getByTestId('org-scope-all')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('device-list-stub')).toHaveAttribute('data-locked-org', 'null');
  });

  it('disables the Current-org button when no currentOrgId is set (forces All-orgs view)', async () => {
    useOrgStoreMock.mockReturnValue({
      currentOrgId: null,
      organizations: [{ id: 'org-a', name: 'Acme Inc' }],
    });
    mockApis(
      [{ id: 'd1', orgId: 'org-a', hostname: 'pc-a', osType: 'windows', status: 'online' }],
      [{ id: 'org-a', name: 'Acme Inc' }]
    );

    render(<DevicesPage />);

    await waitFor(() => {
      expect(screen.getByTestId('device-list-stub')).toBeInTheDocument();
    });
    expect(screen.getByTestId('org-scope-current')).toBeDisabled();
    // lockedOrgFilter is null when currentOrgId is null regardless of scope.
    expect(screen.getByTestId('device-list-stub')).toHaveAttribute('data-locked-org', 'null');
  });
});
