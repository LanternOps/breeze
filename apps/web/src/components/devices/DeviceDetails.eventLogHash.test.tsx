/**
 * Wave F (#9791) — `#eventlog[/<source>]&from=&to=` selects the Event log tab
 * and hands the decoded filter to DeviceLogsTab (pattern: #4886 scripts).
 */
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceDetails, { tabFromHash } from './DeviceDetails';
import { deviceEventLogHash } from '@/lib/deviceEventLogLink';
import type { Device } from './DeviceList';

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: fetchWithAuthMock };
});

const useExtensionSlotDescriptorsMock = vi.hoisted(() => vi.fn());
vi.mock('../extensions/ExtensionSlotHost', () => ({
  useExtensionSlotDescriptors: (...a: unknown[]) => useExtensionSlotDescriptorsMock(...a),
  default: () => <div data-testid="extension-slot-host-stub" />,
}));

vi.mock('./DeviceScriptHistory', () => ({
  default: ({ highlightExecutionId }: { highlightExecutionId?: string }) => (
    <div data-testid="device-script-history-stub" data-highlight={highlightExecutionId ?? ''} />
  ),
}));

vi.mock('./DeviceLogsTab', () => ({
  default: ({ linkedFilter }: { linkedFilter?: { source?: string; from: string; to: string } }) => (
    <div
      data-testid="device-logs-tab-stub"
      data-source={linkedFilter?.source ?? ''}
      data-from={linkedFilter?.from ?? ''}
      data-to={linkedFilter?.to ?? ''}
      data-has-filter={linkedFilter ? 'yes' : 'no'}
    />
  ),
}));

const device: Device = {
  id: 'device-1',
  hostname: 'edge-01',
  os: 'windows',
  osVersion: '11',
  status: 'online',
  cpuPercent: 12,
  ramPercent: 34,
  uptimeSeconds: 3600,
  lastSeen: '2026-02-09T10:00:00.000Z',
  orgId: 'org-1',
  orgName: 'Org One',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '1.0.0',
  pendingReboot: false,
  displayName: 'Edge 01',
} as Device;

beforeEach(() => {
  window.location.hash = '';
  useExtensionSlotDescriptorsMock.mockReturnValue([]);
  fetchWithAuthMock.mockResolvedValue(
    new Response(JSON.stringify({}), { status: 404 }) as unknown as Response
  );
});


const from = '2026-09-24T00:00:00.000Z';
const to = '2026-10-24T12:30:00.000Z';
const q = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

describe('DeviceDetails #eventlog sub-hash (#9791 F1)', () => {
  it('selects the tab and passes source + window', async () => {
    window.location.hash = `#eventlog/Service%20Control%20Manager&${q}`;
    render(<DeviceDetails device={device} />);
    const stub = await screen.findByTestId('device-logs-tab-stub');
    expect(stub.dataset.source).toBe('Service Control Manager');
    expect(stub.dataset.from).toBe(from);
    expect(stub.dataset.to).toBe(to);
  });

  it('selects the tab for a window-only link with no source', async () => {
    window.location.hash = `#eventlog&${q}`;
    render(<DeviceDetails device={device} />);
    const stub = await screen.findByTestId('device-logs-tab-stub');
    expect(stub.dataset.source).toBe('');
    expect(stub.dataset.from).toBe(from);
  });

  it('passes no filter for a bare #eventlog or an unparseable window', async () => {
    window.location.hash = '#eventlog';
    const { unmount } = render(<DeviceDetails device={device} />);
    expect((await screen.findByTestId('device-logs-tab-stub')).dataset.hasFilter).toBe('no');
    unmount();
    window.location.hash = '#eventlog/disk&from=nope&to=nope';
    render(<DeviceDetails device={device} />);
    expect((await screen.findByTestId('device-logs-tab-stub')).dataset.hasFilter).toBe('no');
  });

  it('still resolves #scripts/<id> and #anomalies/<id> as before', async () => {
    window.location.hash = '#scripts/execution-42';
    const { unmount } = render(<DeviceDetails device={device} />);
    expect((await screen.findByTestId('device-script-history-stub')).dataset.highlight).toBe('execution-42');
    unmount();
    window.location.hash = '#anomalies/abc';
    render(<DeviceDetails device={device} />);
    expect(screen.queryByTestId('device-logs-tab-stub')).not.toBeInTheDocument();
    expect(screen.queryByTestId('device-script-history-stub')).not.toBeInTheDocument();
  });
});

describe('tabFromHash tolerates &k=v after the tab segment (#9791 F1)', () => {
  it.each([
    ['eventlog&from=a', 'eventlog'],
    ['eventlog/disk&from=a&to=b', 'eventlog'],
    ['scripts/abc&x=1', 'scripts'],
    ['scripts/abc', 'scripts'],
    ['anomalies/abc', 'anomalies'],
    ['ext:foo-bar:tab', 'ext:foo-bar:tab'],
    ['bogus&x=1', undefined],
    ['', undefined],
  ])('%s -> %s', (hash, expected) => {
    expect(tabFromHash(hash)).toBe(expected);
  });
});

describe('DeviceDetails #eventlog live navigation (#9791 F1)', () => {
  it('reads what the encoder writes, and picks up a hashchange while mounted', async () => {
    window.location.hash = '#overview';
    render(<DeviceDetails device={device} />);
    expect(screen.queryByTestId('device-logs-tab-stub')).not.toBeInTheDocument();

    await act(async () => {
      window.location.hash = `#${deviceEventLogHash({ source: 'Service Control Manager', from, to })}`;
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    const stub = await screen.findByTestId('device-logs-tab-stub');
    expect(stub.dataset.source).toBe('Service Control Manager');
    expect(stub.dataset.from).toBe(from);
  });

  it('leaving the tab clears the linked filter', async () => {
    window.location.hash = `#${deviceEventLogHash({ source: 'disk', from, to })}`;
    render(<DeviceDetails device={device} />);
    await screen.findByTestId('device-logs-tab-stub');

    // Switch away through the tab bar, then back via the plain tab hash.
    await act(async () => {
      window.location.hash = '#overview';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.queryByTestId('device-logs-tab-stub')).not.toBeInTheDocument();
    await act(async () => {
      window.location.hash = '#eventlog';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect((await screen.findByTestId('device-logs-tab-stub')).dataset.hasFilter).toBe('no');
  });
});
