import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '../../../stores/auth';
import StorageHealthSection from './StorageHealthSection';
import { component, view } from './hardwareHealth.fixtures';
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
beforeEach(() => vi.mocked(fetchWithAuth).mockReset());
describe('StorageHealthSection', () => {
  it.each(['ok', 'critical'] as const)('shows the %s server rollup', async health => {
    vi.mocked(fetchWithAuth).mockResolvedValue(response(view({ health })));
    render(<StorageHealthSection deviceId="device-a" />);
    expect(await screen.findByTestId('hardware-rollup-pill')).toHaveTextContent(health === 'ok' ? 'Healthy' : 'Critical');
    expect(fetchWithAuth).toHaveBeenCalledWith('/devices/device-a/hardware-health', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getByTestId('hardware-controller-card')).toHaveTextContent('PERC H730P Mini');
    expect(screen.getByTestId('hardware-sources-footer')).toBeInTheDocument();
  });
  it('distinguishes no tooling from no report', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(response(view({ components: [], tiersRun: ['none'],
      sources: [{ source: 'storcli', status: 'unavailable' }] })));
    render(<StorageHealthSection deviceId="device-a" />);
    expect(await screen.findByTestId('hardware-empty-state')).toHaveTextContent('No RAID or disk-health tooling detected — probed: storcli');
    expect(screen.getByRole('link', { name: 'Installation guidance' })).toBeInTheDocument();
  });
  it('shows a named policy disablement while keeping recorded components', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(response(view({
      policy: { enabled: false, source: 'policy', policyName: 'Servers' },
    })));
    render(<StorageHealthSection deviceId="device-a" />);
    expect(await screen.findByTestId('hardware-empty-state')).toHaveTextContent('disabled by policy Servers');
    expect(screen.getByTestId('hardware-controller-card')).toBeInTheDocument();
  });
  it('treats a disabled collection tier the same as a disabled policy', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(response(view({
      tiersRun: ['disabled'], policy: null,
    })));
    render(<StorageHealthSection deviceId="device-a" />);
    expect(await screen.findByTestId('hardware-empty-state')).toHaveTextContent('disabled by policy —');
    expect(screen.getByTestId('hardware-controller-card')).toBeInTheDocument();
  });
  it('shows no-tooling when a RAID sweep ran but every probed source is unavailable', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(response(view({ components: [], tiersRun: ['raid'],
      sources: [{ source: 'storcli', status: 'unavailable' }, { source: 'megacli', status: 'unavailable' }] })));
    render(<StorageHealthSection deviceId="device-a" />);
    expect(await screen.findByTestId('hardware-empty-state')).toHaveTextContent('No RAID or disk-health tooling detected — probed: storcli, megacli');
  });
  it('uses fresh=false as well as stale and collapses VD-backed OS disks', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(response(view({ components: [component(),
      component({ componentType: 'physical_disk', componentKey: 'winpd:1', source: 'windows_physical_disk',
        name: 'OS disk', state: 'online', fresh: false, stale: false,
        alertExempt: true, attributes: { backedByVd: true } }),
    ] })));
    render(<StorageHealthSection deviceId="device-a" />);
    await screen.findByTestId('hardware-os-disks');
    expect(screen.getByTestId('hardware-backed-disks')).not.toHaveAttribute('open');
    fireEvent.click(screen.getByTestId('hardware-backed-toggle'));
    expect(screen.getByTestId('hardware-disk-winpd:1')).toHaveClass('opacity-60');
    expect(screen.getByText(/Not seen since/)).toBeVisible();
  });
  it('handles only the contracted 404 as an absent report', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(response({ error: 'no_hardware_health' }, 404));
    render(<StorageHealthSection deviceId="device-a" />);
    expect(await screen.findByTestId('hardware-empty-state')).toHaveTextContent('No hardware health report received yet.');
  });
  it.each([403, 404, 500])('surfaces HTTP %s and allows retry', async status => {
    vi.mocked(fetchWithAuth).mockResolvedValueOnce(response({ error: 'denied' }, status))
      .mockResolvedValueOnce(response(view()));
    render(<StorageHealthSection deviceId="device-a" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load hardware health.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('hardware-rollup-pill')).toBeInTheDocument();
  });
  it('does not treat failing empty collection as no installed tools', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(response(view({ components: [],
      sources: [{ source: 'storcli', status: 'failed', error: 'timeout' }] })));
    render(<StorageHealthSection deviceId="device-a" />);
    expect(await screen.findByTestId('hardware-empty-state')).toHaveTextContent('No storage components reported.');
    expect(screen.queryByText(/No RAID or disk-health tooling detected/)).toBeNull();
  });
  it('renders one newest BMC card from the existing hardware-health response', async () => {
    const bmc = component({ componentType: 'bmc', componentKey: 'bmc:racadm', source: 'racadm', name: 'iDRAC',
      firmware: '7.10', lastSeenAt: '2026-09-23T12:00:00.000Z', attributes: { vendor: 'Dell', ip: '192.0.2.10', mac: '02:00:00:00:00:10',
        bmcLink: { status: 'already_linked', assetId: '44444444-4444-4444-8444-444444444444' } } });
    const old = component({ ...bmc, componentKey: 'bmc:ipmi', source: 'ipmi', lastSeenAt: '2026-09-22T12:00:00.000Z', firmware: 'old' });
    vi.mocked(fetchWithAuth).mockResolvedValue(response(view({ components: [component(), old, bmc] })));
    render(<StorageHealthSection deviceId="device-a" />);
    expect(await screen.findByTestId('hardware-management-controller-card')).toHaveTextContent('7.10');
    expect(screen.getAllByTestId('hardware-management-controller-card')).toHaveLength(1);
    expect(screen.getByTestId('hardware-controller-card')).toBeInTheDocument();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });
  it('shows BMC-only inventory without presenting a storage empty-state contradiction', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(response(view({ components: [component({ componentType: 'bmc', componentKey: 'bmc:ipmi', source: 'ipmi', name: 'BMC' })] })));
    render(<StorageHealthSection deviceId="device-a" />);
    expect(await screen.findByTestId('hardware-management-controller-card')).toBeInTheDocument();
    expect(screen.queryByTestId('hardware-empty-state')).not.toBeInTheDocument();
  });
  it('does not render a management card when no BMC component exists', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(response(view()));
    render(<StorageHealthSection deviceId="device-a" />);
    await screen.findByTestId('hardware-controller-card');
    expect(screen.queryByTestId('hardware-management-controller-card')).not.toBeInTheDocument();
  });
  it('ignores a late response for the previous device and aborts on unmount', async () => {
    let finish!: (value: Response) => void;
    vi.mocked(fetchWithAuth).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(response(view({ health: 'critical' })));
    const result = render(<StorageHealthSection deviceId="device-a" />);
    result.rerender(<StorageHealthSection deviceId="device-b" />);
    await screen.findByTestId('hardware-rollup-pill');
    await act(async () => finish(response(view({ health: 'ok' }))));
    expect(screen.getByTestId('hardware-rollup-pill')).toHaveTextContent('Critical');
    result.unmount();
    await waitFor(() => expect(vi.mocked(fetchWithAuth).mock.calls[1][1]?.signal?.aborted).toBe(true));
  });
});
