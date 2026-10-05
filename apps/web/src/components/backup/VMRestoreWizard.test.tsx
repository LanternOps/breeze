import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import VMRestoreWizard from './VMRestoreWizard';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

// runAction routes every outcome through the Toast singleton.
vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const showToastMock = vi.mocked(showToast);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('VMRestoreWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/snapshots') {
        return makeJsonResponse({
          data: [
            {
              id: 'snapshot-1',
              label: 'Nightly Snapshot',
              createdAt: '2026-03-28T10:00:00Z',
              sizeBytes: 2147483648,
            },
          ],
        });
      }
      if (url.startsWith('/devices/options?')) {
        const params = new URL(url, 'http://localhost').searchParams;
        const data = params.get('osType') === 'linux'
          ? [{ id: 'linux-host-1', hostname: 'rebuild-01', displayName: null, osType: 'linux', status: 'online', siteId: null, siteName: null }]
          : [{ id: 'device-1', hostname: 'hyperv-01', displayName: null, osType: 'windows', status: 'online', siteId: null, siteName: null }];
        return makeJsonResponse({
          data,
          page: { nextCursor: null, returned: 1, total: 1, hasMore: false, observedAt: '2026-08-24T00:00:00.000Z' },
        });
      }
      if (url === '/backup/restore/as-vm/estimate/snapshot-1') {
        return makeJsonResponse({
          data: {
            memoryMb: 12288,
            cpuCount: 6,
            diskSizeGb: 180,
          },
        });
      }
      if (url === '/backup/restore/as-vm' || url === '/backup/restore/instant-boot') {
        return makeJsonResponse({
          data: {
            id: 'restore-1',
            status: 'pending',
          },
        });
      }
      return makeJsonResponse({});
    });
  });

  it('renders the first step for snapshot selection', async () => {
    render(<VMRestoreWizard />);

    await screen.findByText('Select backup snapshot');
    expect(screen.getByText('Nightly Snapshot')).toBeTruthy();
    expect(screen.getByText('1. Snapshot')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/devices/options?'))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => /^\/devices(?:\?|$)/.test(String(url)))).toBe(false);
  });

  it('names the device on each snapshot card', async () => {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === '/backup/snapshots') {
        return makeJsonResponse({
          data: [
            { id: 'snapshot-1', label: 'Nightly', deviceName: 'Mac Mini', createdAt: '2026-03-28T10:00:00Z' },
            { id: 'snapshot-2', label: 'Nightly', deviceName: 'SRV01', createdAt: '2026-03-28T11:00:00Z' },
          ],
        });
      }
      return base(input, init);
    });

    render(<VMRestoreWizard />);

    expect(await screen.findByRole('button', { name: /Nightly.*Mac Mini/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Nightly.*SRV01/i })).toBeTruthy();
  });

  it('shows CPU, memory and disk chips from the hardware profile the snapshot list sends', async () => {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === '/backup/snapshots') {
        return makeJsonResponse({
          data: [
            {
              id: 'snapshot-1',
              label: 'Whole machine',
              createdAt: '2026-03-28T10:00:00Z',
              // GET /backup/snapshots shape (stored systemstate.HardwareProfile names)
              hardwareProfile: {
                cpuCores: 8,
                totalMemoryMB: 16384,
                disks: [{ sizeBytes: 256 * 1024 ** 3 }, { sizeBytes: 256 * 1024 ** 3 }],
              },
            },
          ],
        });
      }
      return base(input, init);
    });

    render(<VMRestoreWizard />);

    const card = await screen.findByRole('button', { name: /Whole machine/i });
    expect(card.textContent).toContain('8 CPU');
    expect(card.textContent).toContain('16 GB');
    expect(card.textContent).toContain('512 GB');
  });

  it('renders alpha banner', async () => {
    render(<VMRestoreWizard />);

    await screen.findByText('VM Restore Wizard');
    expect(
      screen.getByText(/Restoring backups as Hyper-V VMs and Instant Boot are in early access/i)
    ).toBeTruthy();
  });

  it('prefills VM specs from the estimate and submits the nested VM restore payload', async () => {
    render(<VMRestoreWizard />);

    fireEvent.click(await screen.findByRole('button', { name: /Nightly Snapshot/i }));
    fireEvent.click(screen.getByRole('button', { name: /3\. Target Host/i }));
    fireEvent.click(await screen.findByRole('radio'));
    fireEvent.click(screen.getByRole('button', { name: /4\. VM Specs/i }));

    await waitFor(() => {
      expect(screen.getByDisplayValue('12288')).toBeTruthy();
      expect(screen.getByDisplayValue('6')).toBeTruthy();
      expect(screen.getByDisplayValue('180')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /5\. VM Name/i }));
    fireEvent.change(screen.getByLabelText(/VM Name/i), { target: { value: 'Recovered VM' } });
    fireEvent.change(screen.getByLabelText(/Virtual Switch/i), { target: { value: 'Prod Switch' } });

    fireEvent.click(screen.getByRole('button', { name: /6\. Review/i }));
    fireEvent.click(screen.getByRole('button', { name: /Start Full Restore/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/backup/restore/as-vm',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          snapshotId: 'snapshot-1',
          targetDeviceId: 'device-1',
          vmName: 'Recovered VM',
          hypervisor: 'hyperv',
          vmSpecs: {
            memoryMb: 12288,
            cpuCount: 6,
            diskSizeGb: 180,
          },
          switchName: 'Prod Switch',
        }),
      })
    ));
  });

  it('blocks Continue on the VM Name step until a name is typed, and says why (#7213)', async () => {
    render(<VMRestoreWizard />);
    fireEvent.click(await screen.findByRole('button', { name: /Nightly Snapshot/i }));
    fireEvent.click(screen.getByRole('button', { name: /5\. VM Name/i }));

    const cont = screen.getByRole('button', { name: /^Continue/i }) as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
    expect(screen.getByText(/Enter a VM name to continue/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/VM Name/i), { target: { value: 'Recovered VM' } });
    expect((screen.getByRole('button', { name: /^Continue/i }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/Enter a VM name to continue/i)).toBeNull();
  });

  it('asks for the mode before the VM name, and the rebuild engine has no VM Name or Target Host step', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/snapshots') {
        return makeJsonResponse({
          data: [{ id: 'snapshot-win', label: 'Windows Server Snapshot', layoutManifestKey: 'k', layoutPlatform: 'windows', bareMetalRestorable: true }],
        });
      }
      if (url.startsWith('/devices/options?')) {
        return makeJsonResponse({ data: [], page: { nextCursor: null, returned: 0, total: 0, hasMore: false, observedAt: '2026-08-24T00:00:00.000Z' } });
      }
      return makeJsonResponse({});
    });

    render(<VMRestoreWizard />);
    fireEvent.click(await screen.findByRole('button', { name: /Windows Server Snapshot/i }));

    // Mode is chosen right after the snapshot, before any name is asked for.
    fireEvent.click(screen.getByRole('button', { name: /^Continue/i }));
    expect(screen.getByText('Restore mode')).toBeTruthy();
    expect(screen.getByRole('button', { name: '2. Mode' })).toBeTruthy();

    fireEvent.click(screen.getByTestId('vm-restore-engine-rebuild'));
    const pills = screen.getAllByRole('button', { name: /^\d\. / }).map((b) => b.textContent);
    expect(pills).toEqual(['1. Snapshot', '2. Mode', '3. VM Specs', '4. Review']);

    // Continue is never gated on a VM name the rebuild engine does not take.
    const cont = screen.getByRole('button', { name: /^Continue/i }) as HTMLButtonElement;
    expect(cont.disabled).toBe(false);
    fireEvent.click(cont);
    fireEvent.click(screen.getByRole('button', { name: /^Continue/i }));
    expect(screen.getByRole('button', { name: /Start Rebuild/i })).toBeTruthy();
    expect(screen.queryByText(/Enter a VM name/i)).toBeNull();
  });

  it('explains why Start is disabled when the VM name is empty (#7213)', async () => {
    render(<VMRestoreWizard />);
    fireEvent.click(await screen.findByRole('button', { name: /Nightly Snapshot/i }));
    fireEvent.click(screen.getByRole('button', { name: /6\. Review/i }));

    const start = screen.getByRole('button', { name: /Start Full Restore/i }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(screen.getByText(/Enter a VM name on the VM Name step/i)).toBeTruthy();
  });

  it('sends the nested VM spec payload for instant boot', async () => {
    render(<VMRestoreWizard />);

    fireEvent.click(await screen.findByRole('button', { name: /Nightly Snapshot/i }));
    fireEvent.click(screen.getByRole('button', { name: /3\. Target Host/i }));
    fireEvent.click(await screen.findByRole('radio'));
    fireEvent.click(screen.getByRole('button', { name: /5\. VM Name/i }));
    fireEvent.change(screen.getByLabelText(/VM Name/i), { target: { value: 'Instant VM' } });
    fireEvent.click(screen.getByRole('button', { name: /2\. Mode/i }));
    fireEvent.click(screen.getByRole('button', { name: /Instant Boot/i }));
    fireEvent.click(screen.getByRole('button', { name: /6\. Review/i }));
    fireEvent.click(screen.getByRole('button', { name: /Start Instant Boot/i }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url === '/backup/restore/instant-boot')).toBe(true);
    });

    const instantBootCall = fetchMock.mock.calls.find(([url]) => url === '/backup/restore/instant-boot');
    expect(instantBootCall).toBeTruthy();
    const [, options] = instantBootCall ?? [];
    const body = JSON.parse(String((options as { body?: string } | undefined)?.body ?? '{}'));
    expect(body).toMatchObject({
      snapshotId: 'snapshot-1',
      targetDeviceId: 'device-1',
      vmName: 'Instant VM',
    });
    expect(body.vmSpecs).toEqual(
      expect.objectContaining({
        memoryMb: expect.any(Number),
        cpuCount: expect.any(Number),
        diskSizeGb: expect.any(Number),
      })
    );
  });

  it('asks for confirmation before an instant boot of a backup without an integrity attestation, then resubmits', async () => {
    const base = fetchMock.getMockImplementation()!;
    let posts = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === '/backup/restore/instant-boot') {
        posts += 1;
        if (posts === 1) {
          return makeJsonResponse({
            error: 'Confirm the restore.',
            code: 'STEP_UP_REQUIRED',
            stepUp: {
              operation: 'backup_unattested_restore',
              method: 'confirm',
              reason: 'producer_only_other_target',
              resource: { snapshotId: 'snapshot-1', targetDeviceId: 'device-1', commandType: 'vm_instant_boot' },
            },
          }, false, 403);
        }
      }
      return base(input, init);
    });

    render(<VMRestoreWizard />);
    fireEvent.click(await screen.findByRole('button', { name: /Nightly Snapshot/i }));
    fireEvent.click(screen.getByRole('button', { name: /3\. Target Host/i }));
    fireEvent.click(await screen.findByRole('radio'));
    fireEvent.click(screen.getByRole('button', { name: /5\. VM Name/i }));
    fireEvent.change(screen.getByLabelText(/VM Name/i), { target: { value: 'Instant VM' } });
    fireEvent.click(screen.getByRole('button', { name: /2\. Mode/i }));
    fireEvent.click(screen.getByRole('button', { name: /Instant Boot/i }));
    fireEvent.click(screen.getByRole('button', { name: /6\. Review/i }));
    fireEvent.click(screen.getByRole('button', { name: /Start Instant Boot/i }));

    const prompt = await screen.findByTestId('unattested-restore-stepup');
    expect(prompt.textContent).toMatch(/only the original device can check/i);
    expect(showToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));

    fireEvent.click(screen.getByTestId('unattested-restore-stepup-confirm'));
    await waitFor(() => expect(posts).toBe(2));
    const bodies = fetchMock.mock.calls
      .filter(([url]) => url === '/backup/restore/instant-boot')
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(bodies[0]).not.toHaveProperty('confirmUnattestedRestore');
    expect(bodies[1]).toMatchObject({ snapshotId: 'snapshot-1', vmName: 'Instant VM', confirmUnattestedRestore: true });
    await waitFor(() => expect(screen.queryByTestId('unattested-restore-stepup')).toBeNull());
  });

  it('does not offer the rebuild engine for a snapshot without a layout manifest', async () => {
    render(<VMRestoreWizard />);

    fireEvent.click(await screen.findByRole('button', { name: /Nightly Snapshot/i }));
    fireEvent.click(screen.getByRole('button', { name: /2\. Mode/i }));

    expect(screen.getByRole('button', { name: /Instant Boot/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Rebuild engine/i })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('osType=linux'))).toBe(false);
  });

  it('offers the rebuild engine for a whole-machine snapshot and submits engine: rebuild without an identity', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/snapshots') {
        return makeJsonResponse({
          data: [
            { id: 'snapshot-linux', label: 'Linux Server Snapshot', createdAt: '2026-03-28T10:00:00Z', sizeBytes: 1024, layoutManifestKey: 'backups/snap-ext-1/layout.json', layoutPlatform: 'linux', bareMetalRestorable: true },
          ],
        });
      }
      if (url.startsWith('/devices/options?')) {
        const params = new URL(url, 'http://localhost').searchParams;
        const data = params.get('osType') === 'linux'
          ? [{ id: 'linux-host-1', hostname: 'rebuild-01', displayName: null, osType: 'linux', status: 'online', siteId: null, siteName: null }]
          : [{ id: 'device-1', hostname: 'hyperv-01', displayName: null, osType: 'windows', status: 'online', siteId: null, siteName: null }];
        return makeJsonResponse({ data, page: { nextCursor: null, returned: 1, total: 1, hasMore: false, observedAt: '2026-08-24T00:00:00.000Z' } });
      }
      if (url === '/backup/restore/as-vm') {
        return makeJsonResponse({ jobId: 'job-1', recoveryId: 'rec-1', commandId: 'cmd-1', status: 'queued' }, true, 202);
      }
      return makeJsonResponse({});
    });

    render(<VMRestoreWizard />);

    fireEvent.click(await screen.findByRole('button', { name: /Linux Server Snapshot/i }));
    fireEvent.click(screen.getByRole('button', { name: /2\. Mode/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Rebuild engine/i }));

    // Linux host picker + output path appear inline
    expect(screen.getByTestId('vm-restore-rebuild-host-picker')).toHaveAttribute('data-os-filter', 'linux');
    fireEvent.click(await screen.findByRole('radio', { name: /rebuild-01/i }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('osType=linux'))).toBe(true);
    // Hyper-V VM creation is a Windows-host feature; never offered for Linux.
    expect(screen.queryByTestId('vm-restore-hyperv-options')).toBeNull();
    fireEvent.change(screen.getByLabelText(/Output path/i), { target: { value: '/srv/rebuild/dev-1.vhdx' } });

    fireEvent.click(screen.getByRole('button', { name: /4\. Review/i }));
    expect(screen.getByText(/Attach the VHDX to a Hyper-V VM manually/i)).toBeTruthy();
    expect(screen.getByText('/srv/rebuild/dev-1.vhdx')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Start Rebuild/i }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url === '/backup/restore/as-vm')).toBe(true);
    });
    const call = fetchMock.mock.calls.find(([url]) => url === '/backup/restore/as-vm');
    const body = JSON.parse(String((call?.[1] as { body?: string } | undefined)?.body ?? '{}'));
    expect(body).toEqual({
      engine: 'rebuild',
      snapshotId: 'snapshot-linux',
      rebuildHostDeviceId: 'linux-host-1',
      outputPath: '/srv/rebuild/dev-1.vhdx',
    });
    expect(body).not.toHaveProperty('identity');
    expect(body).not.toHaveProperty('targetDeviceId');

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
  });

  it('surfaces a failed rebuild submission through runAction', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/snapshots') {
        return makeJsonResponse({ data: [{ id: 'snapshot-linux', label: 'Linux Server Snapshot', layoutManifestKey: 'k', layoutPlatform: 'linux', bareMetalRestorable: true }] });
      }
      if (url.startsWith('/devices/options?')) {
        const params = new URL(url, 'http://localhost').searchParams;
        const data = params.get('osType') === 'linux'
          ? [{ id: 'linux-host-1', hostname: 'rebuild-01', displayName: null, osType: 'linux', status: 'online', siteId: null, siteName: null }]
          : [];
        return makeJsonResponse({ data, page: { nextCursor: null, returned: data.length, total: data.length, hasMore: false, observedAt: '2026-08-24T00:00:00.000Z' } });
      }
      if (url === '/backup/restore/as-vm') {
        // The verdict can flip between the list load and the submit.
        return makeJsonResponse({ error: 'snapshot_not_bare_metal_restorable', details: {} }, false, 409);
      }
      return makeJsonResponse({});
    });

    render(<VMRestoreWizard />);
    fireEvent.click(await screen.findByRole('button', { name: /Linux Server Snapshot/i }));
    fireEvent.click(screen.getByRole('button', { name: /2\. Mode/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Rebuild engine/i }));
    fireEvent.click(await screen.findByRole('radio', { name: /rebuild-01/i }));
    fireEvent.change(screen.getByLabelText(/Output path/i), { target: { value: '/srv/rebuild/dev-1.vhdx' } });
    fireEvent.click(screen.getByRole('button', { name: /4\. Review/i }));
    fireEvent.click(screen.getByRole('button', { name: /Start Rebuild/i }));

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    // Readable copy in the toast and the banner, never the raw machine code.
    const toast = showToastMock.mock.calls.find(([arg]) => arg.type === 'error')?.[0];
    expect(toast?.message).toMatch(/can't be rebuilt/i);
    expect(toast?.message).not.toContain('snapshot_not_bare_metal_restorable');
    expect(await screen.findByText(/can't be rebuilt/i)).toBeTruthy();
    expect(screen.queryByText(/snapshot_not_bare_metal_restorable/)).toBeNull();
  });

  it('does not offer the rebuild engine for a layout-bearing snapshot that is not bare-metal restorable', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/snapshots') {
        return makeJsonResponse({
          data: [
            { id: 'snapshot-unverified', label: 'Unverified Snapshot', layoutManifestKey: 'k', layoutPlatform: 'windows', bareMetalRestorable: null },
            { id: 'snapshot-refused', label: 'Refused Snapshot', layoutManifestKey: 'k2', layoutPlatform: 'windows', bareMetalRestorable: false },
          ],
        });
      }
      return makeJsonResponse({});
    });

    render(<VMRestoreWizard />);
    fireEvent.click(await screen.findByRole('button', { name: /Unverified Snapshot/i }));
    fireEvent.click(screen.getByRole('button', { name: /2\. Mode/i }));
    expect(screen.getByRole('button', { name: /Instant Boot/i })).toBeTruthy();
    expect(screen.queryByTestId('vm-restore-engine-rebuild')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /1\. Snapshot/i }));
    fireEvent.click(screen.getByRole('button', { name: /Refused Snapshot/i }));
    fireEvent.click(screen.getByRole('button', { name: /2\. Mode/i }));
    expect(screen.queryByTestId('vm-restore-engine-rebuild')).toBeNull();
  });
});

// W06d (Task 22): the rebuild host must run the snapshot's platform, so the
// picker filters by the snapshot's layoutPlatform; a Windows host adds the
// optional Hyper-V VM block and takes drive-letter VHDX paths.
describe('VMRestoreWizard — platform-matched rebuild host', () => {
  const pageOf = (data: unknown[]) => ({
    data,
    page: { nextCursor: null, returned: data.length, total: data.length, hasMore: false, observedAt: '2026-08-24T00:00:00.000Z' },
  });
  const windowsHost = { id: 'windows-host-1', hostname: 'hv-rebuild-01', displayName: null, osType: 'windows', status: 'online', siteId: null, siteName: null };
  const linuxHost = { id: 'linux-host-1', hostname: 'rebuild-01', displayName: null, osType: 'linux', status: 'online', siteId: null, siteName: null };

  function mockWithSnapshots(snapshots: unknown[]) {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/snapshots') return makeJsonResponse({ data: snapshots });
      if (url.startsWith('/devices/options?')) {
        const params = new URL(url, 'http://localhost').searchParams;
        const os = params.get('osType');
        return makeJsonResponse(pageOf(os === 'linux' ? [linuxHost] : os === 'windows' ? [windowsHost] : []));
      }
      if (url.startsWith('/backup/restore/as-vm/estimate/')) {
        return makeJsonResponse({ data: { memoryMb: 8192, cpuCount: 4, diskSizeGb: 120 } });
      }
      if (url === '/backup/restore/as-vm') {
        return makeJsonResponse({ jobId: 'job-1', recoveryId: 'rec-1', commandId: 'cmd-1', status: 'queued' }, true, 202);
      }
      return makeJsonResponse({});
    });
  }

  const windowsSnapshot = { id: 'snapshot-win', label: 'Windows Server Snapshot', layoutManifestKey: 'backups/snap-win/layout.json', layoutPlatform: 'windows', bareMetalRestorable: true };
  const linuxSnapshot = { id: 'snapshot-linux', label: 'Linux Server Snapshot', layoutManifestKey: 'backups/snap-lin/layout.json', layoutPlatform: 'linux', bareMetalRestorable: true };

  async function openRebuildFor(label: RegExp) {
    render(<VMRestoreWizard />);
    fireEvent.click(await screen.findByRole('button', { name: label }));
    fireEvent.click(screen.getByRole('button', { name: /2\. Mode/i }));
    fireEvent.click(await screen.findByTestId('vm-restore-engine-rebuild'));
  }

  function bodyOfRestoreCall() {
    const call = fetchMock.mock.calls.find(([url]) => url === '/backup/restore/as-vm');
    return JSON.parse(String((call?.[1] as { body?: string } | undefined)?.body ?? '{}'));
  }

  it('filters the rebuild host picker to the Windows snapshot\'s platform', async () => {
    mockWithSnapshots([windowsSnapshot]);
    await openRebuildFor(/Windows Server Snapshot/i);

    expect(screen.getByTestId('vm-restore-rebuild-host-picker')).toHaveAttribute('data-os-filter', 'windows');
    expect(await screen.findByRole('radio', { name: /hv-rebuild-01/i })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /^rebuild-01/i })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('osType=linux'))).toBe(false);
  });

  it('does not offer the rebuild engine when the layout records no platform (the API would refuse it)', async () => {
    mockWithSnapshots([{ id: 'snapshot-old', label: 'Old Snapshot', layoutManifestKey: 'backups/snap-old/layout.json', bareMetalRestorable: true }]);
    render(<VMRestoreWizard />);
    fireEvent.click(await screen.findByRole('button', { name: /Old Snapshot/i }));
    fireEvent.click(screen.getByRole('button', { name: /2\. Mode/i }));

    expect(screen.getByRole('button', { name: /Instant Boot/i })).toBeTruthy();
    expect(screen.queryByTestId('vm-restore-engine-rebuild')).toBeNull();
  });

  it('accepts a drive-letter VHDX path on a Windows host and refuses a POSIX one', async () => {
    mockWithSnapshots([windowsSnapshot]);
    await openRebuildFor(/Windows Server Snapshot/i);
    fireEvent.click(await screen.findByRole('radio', { name: /hv-rebuild-01/i }));

    const output = screen.getByTestId('vm-restore-rebuild-output-path') as HTMLInputElement;
    expect(output.placeholder).toMatch(/^C:\\/);

    fireEvent.change(output, { target: { value: '/srv/rebuild/x.vhdx' } });
    expect(screen.getByTestId('vm-restore-rebuild-output-path-invalid')).toBeInTheDocument();

    fireEvent.change(output, { target: { value: '\\\\server\\share\\x.vhdx' } });
    expect(screen.getByTestId('vm-restore-rebuild-output-path-invalid')).toBeInTheDocument();

    fireEvent.change(output, { target: { value: 'C:\\Rebuild\\srv-01.vhdx' } });
    expect(screen.queryByTestId('vm-restore-rebuild-output-path-invalid')).toBeNull();
  });

  it('shows the optional Hyper-V fields for a Windows host and sends hyperv with the VM specs', async () => {
    mockWithSnapshots([windowsSnapshot]);
    await openRebuildFor(/Windows Server Snapshot/i);
    fireEvent.click(await screen.findByRole('radio', { name: /hv-rebuild-01/i }));

    expect(screen.getByTestId('vm-restore-hyperv-options')).toBeInTheDocument();
    // No switch named → the hint warns there will be no network adapter.
    fireEvent.change(screen.getByTestId('vm-restore-hyperv-vm-name'), { target: { value: 'srv-01-restored' } });
    expect(screen.getByTestId('vm-restore-hyperv-no-nic-hint')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('vm-restore-hyperv-switch'), { target: { value: 'Isolated' } });
    expect(screen.queryByTestId('vm-restore-hyperv-no-nic-hint')).toBeNull();
    fireEvent.change(screen.getByTestId('vm-restore-rebuild-output-path'), { target: { value: 'C:\\Rebuild\\srv-01.vhdx' } });

    fireEvent.click(screen.getByRole('button', { name: /4\. Review/i }));
    // A VM will be created, so the manual-attach note gives way to the VM note.
    expect(screen.getByTestId('vm-restore-rebuild-hyperv-note')).toHaveTextContent('srv-01-restored');
    expect(screen.queryByText(/Attach the VHDX to a Hyper-V VM manually/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Start Rebuild/i }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/backup/restore/as-vm')).toBe(true));

    expect(bodyOfRestoreCall()).toEqual({
      engine: 'rebuild',
      snapshotId: 'snapshot-win',
      rebuildHostDeviceId: 'windows-host-1',
      outputPath: 'C:\\Rebuild\\srv-01.vhdx',
      hyperv: { vmName: 'srv-01-restored', switchName: 'Isolated', memoryMb: 8192, cpuCount: 4 },
    });
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
  });

  it('never sends an odd hyperv.memoryMb (Hyper-V needs a multiple of 2 MB; the API refuses it)', async () => {
    mockWithSnapshots([windowsSnapshot]);
    render(<VMRestoreWizard />);
    fireEvent.click(await screen.findByRole('button', { name: /Windows Server Snapshot/i }));
    fireEvent.click(screen.getByRole('button', { name: /4\. VM Specs/i }));
    // Wait for the estimate to pre-fill (8192) before overriding it.
    await waitFor(() => expect((screen.getByLabelText(/Memory/i) as HTMLInputElement).value).toBe('8192'));
    fireEvent.change(screen.getByLabelText(/Memory/i), { target: { value: '4097' } });
    fireEvent.click(screen.getByRole('button', { name: /2\. Mode/i }));
    fireEvent.click(await screen.findByTestId('vm-restore-engine-rebuild'));
    fireEvent.click(await screen.findByRole('radio', { name: /hv-rebuild-01/i }));
    fireEvent.change(screen.getByTestId('vm-restore-hyperv-vm-name'), { target: { value: 'srv-01-restored' } });
    fireEvent.change(screen.getByTestId('vm-restore-rebuild-output-path'), { target: { value: 'C:\\Rebuild\\srv-01.vhdx' } });
    fireEvent.click(screen.getByRole('button', { name: /4\. Review/i }));
    fireEvent.click(screen.getByRole('button', { name: /Start Rebuild/i }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/backup/restore/as-vm')).toBe(true));

    expect(bodyOfRestoreCall().hyperv).toEqual({ vmName: 'srv-01-restored', memoryMb: 4096, cpuCount: 4 });
  });

  it('omits hyperv when no VM name is given and keeps the manual-attach note', async () => {
    mockWithSnapshots([windowsSnapshot]);
    await openRebuildFor(/Windows Server Snapshot/i);
    fireEvent.click(await screen.findByRole('radio', { name: /hv-rebuild-01/i }));
    fireEvent.change(screen.getByTestId('vm-restore-hyperv-switch'), { target: { value: 'Isolated' } });
    fireEvent.change(screen.getByTestId('vm-restore-rebuild-output-path'), { target: { value: 'C:\\Rebuild\\srv-01.vhdx' } });

    fireEvent.click(screen.getByRole('button', { name: /4\. Review/i }));
    expect(screen.getByText(/Attach the VHDX to a Hyper-V VM manually/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Start Rebuild/i }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/backup/restore/as-vm')).toBe(true));

    const body = bodyOfRestoreCall();
    expect(body).not.toHaveProperty('hyperv');
    expect(body.rebuildHostDeviceId).toBe('windows-host-1');
  });

  it.each([
    {
      name: 'uses the API reasons for a refusal without its own copy',
      body: { error: 'snapshot_storage_identity_unknown', details: { reasons: ['The snapshot storage location could not be identified.'] } },
      expected: 'The snapshot storage location could not be identified.',
    },
    {
      name: 'explains a recovery already in progress',
      body: { error: 'recovery_in_progress', details: { recoveryId: 'rec-9', status: 'running' } },
      expected: /already in progress/i,
    },
    {
      name: 'explains a snapshot that no longer exists',
      body: { error: 'snapshot_not_found' },
      expected: /snapshot no longer exists/i,
    },
    {
      name: 'explains a rebuild host that no longer exists',
      body: { error: 'rebuild_host_not_found' },
      expected: /rebuild host no longer exists/i,
    },
  ])('rebuild refusal copy: $name', async ({ body, expected }) => {
    mockWithSnapshots([windowsSnapshot]);
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === '/backup/restore/as-vm') return makeJsonResponse(body, false, 409);
      return base(input, init);
    });
    await openRebuildFor(/Windows Server Snapshot/i);
    fireEvent.click(await screen.findByRole('radio', { name: /hv-rebuild-01/i }));
    fireEvent.change(screen.getByTestId('vm-restore-rebuild-output-path'), { target: { value: 'C:\\Rebuild\\srv-01.vhdx' } });
    fireEvent.click(screen.getByRole('button', { name: /4\. Review/i }));
    fireEvent.click(screen.getByRole('button', { name: /Start Rebuild/i }));

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    const toast = showToastMock.mock.calls.find(([arg]) => arg.type === 'error')?.[0];
    if (typeof expected === 'string') expect(toast?.message).toBe(expected);
    else expect(toast?.message).toMatch(expected);
    expect(toast?.message).not.toContain(body.error);
  });

  it('clears the picked rebuild host when the snapshot platform changes', async () => {
    mockWithSnapshots([linuxSnapshot, windowsSnapshot]);
    await openRebuildFor(/Linux Server Snapshot/i);
    fireEvent.click(await screen.findByRole('radio', { name: /rebuild-01/i }));

    fireEvent.click(screen.getByRole('button', { name: /1\. Snapshot/i }));
    fireEvent.click(screen.getByRole('button', { name: /Windows Server Snapshot/i }));
    fireEvent.click(screen.getByRole('button', { name: /2\. Mode/i }));

    expect(screen.getByTestId('vm-restore-rebuild-host-picker')).toHaveAttribute('data-os-filter', 'windows');
    const radio = (await screen.findByRole('radio', { name: /hv-rebuild-01/i })) as HTMLInputElement;
    expect(radio.checked).toBe(false);
    expect(screen.queryByRole('radio', { name: /^rebuild-01/i })).toBeNull();
  });
});
