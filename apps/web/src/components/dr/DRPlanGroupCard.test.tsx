import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DRPlanGroupCard, { DR_STEP_TYPES, type DRGroupForm } from './DRPlanGroupCard';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown): Response =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function makeGroup(overrides: Partial<DRGroupForm> = {}): DRGroupForm {
  return {
    localId: 'g-1',
    name: 'Tier 1',
    deviceIds: [],
    estimatedDurationMinutes: '',
    dependsOnGroupKey: null,
    stepType: '',
    rebuildHostDeviceId: null,
    outputDir: '/var/lib/breeze/rebuild/out',
    waitTimeoutMinutes: '240',
    ...overrides,
  };
}

function renderCard(group: DRGroupForm) {
  const onChange = vi.fn();
  render(
    <DRPlanGroupCard
      group={group}
      index={0}
      total={1}
      dependencyOptions={[]}
      onChange={onChange}
      onMove={vi.fn()}
      onRemove={vi.fn()}
      onCanSubmitChange={vi.fn()}
    />
  );
  return { onChange };
}

describe('DRPlanGroupCard step type', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      const linux = url.includes('osType=linux');
      return makeJsonResponse({
        data: linux
          ? [{ id: 'host-1', hostname: 'rebuild-host-01', displayName: null, osType: 'linux', status: 'online', siteId: null, siteName: null }]
          : [{ id: 'd-1', hostname: 'srv-01', displayName: null, osType: 'windows', status: 'online', siteId: null, siteName: null }],
        page: { nextCursor: null, returned: 1, total: 1, hasMore: false, observedAt: '' },
      });
    });
  });

  it('renders a step-type select with all six DR step types and an empty placeholder', () => {
    renderCard(makeGroup());
    const select = screen.getByTestId('dr-group-step-type') as HTMLSelectElement;
    expect(select.value).toBe('');
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).toEqual(['', ...DR_STEP_TYPES]);
    expect(DR_STEP_TYPES).toEqual([
      'VM_RESTORE_FROM_BACKUP',
      'VM_INSTANT_BOOT',
      'HYPERV_RESTORE',
      'MSSQL_RESTORE',
      'BMR_RECOVER',
      'BARE_METAL_REBUILD',
    ]);
  });

  it('defaults the select to the loaded group step type and hides rebuild fields for other types', () => {
    renderCard(makeGroup({ stepType: 'HYPERV_RESTORE' }));
    expect((screen.getByTestId('dr-group-step-type') as HTMLSelectElement).value).toBe('HYPERV_RESTORE');
    expect(screen.queryByTestId('dr-group-rebuild-options')).toBeNull();
  });

  it('propagates a step-type change through onChange', () => {
    const { onChange } = renderCard(makeGroup());
    fireEvent.change(screen.getByTestId('dr-group-step-type'), { target: { value: 'BARE_METAL_REBUILD' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const updater = onChange.mock.calls[0]![0] as (group: DRGroupForm) => DRGroupForm;
    expect(updater(makeGroup()).stepType).toBe('BARE_METAL_REBUILD');
  });

  it('reveals the Linux rebuild host picker, output dir and timeout for BARE_METAL_REBUILD', async () => {
    const { onChange } = renderCard(makeGroup({ stepType: 'BARE_METAL_REBUILD' }));
    expect(screen.getByTestId('dr-group-rebuild-options')).toBeInTheDocument();
    expect(await screen.findByText('rebuild-host-01')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('osType=linux'))).toBe(true);
    // W06d: the host OS selector offers Linux and Windows — never macOS.
    const hostOs = screen.getByTestId('dr-group-rebuild-host-os') as HTMLSelectElement;
    expect(hostOs.value).toBe('linux');
    expect(Array.from(hostOs.options).map((option) => option.value)).toEqual(['linux', 'windows']);

    const outputDir = screen.getByTestId('dr-group-rebuild-output-dir') as HTMLInputElement;
    expect(outputDir.value).toBe('/var/lib/breeze/rebuild/out');
    fireEvent.change(outputDir, { target: { value: '/srv/rebuild' } });
    const outputUpdater = onChange.mock.calls.at(-1)![0] as (group: DRGroupForm) => DRGroupForm;
    expect(outputUpdater(makeGroup()).outputDir).toBe('/srv/rebuild');

    const timeout = screen.getByTestId('dr-group-rebuild-wait-timeout') as HTMLInputElement;
    expect(timeout.value).toBe('240');
    fireEvent.change(timeout, { target: { value: '60' } });
    const timeoutUpdater = onChange.mock.calls.at(-1)![0] as (group: DRGroupForm) => DRGroupForm;
    expect(timeoutUpdater(makeGroup()).waitTimeoutMinutes).toBe('60');
  });
});

// W06d (Task 22): the rebuild engine is platform-matched, so a DR rehearsal
// can use a Windows rebuild host for Windows devices. The picker filters by
// one OS at a time (Linux or Windows, never macOS); the output-dir
// placeholder shows the picked OS's default.
describe('DRPlanGroupCard rebuild host platform (W06d)', () => {
  const page = (data: unknown[]) => ({
    data,
    page: { nextCursor: null, returned: data.length, total: data.length, hasMore: false, observedAt: '' },
  });
  const linuxHost = { id: 'host-1', hostname: 'rebuild-host-01', displayName: null, osType: 'linux', status: 'online', siteId: null, siteName: null };
  const windowsHost = { id: 'win-host-1', hostname: 'hv-rebuild-01', displayName: null, osType: 'windows', status: 'online', siteId: null, siteName: null };

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input) => {
      const params = new URL(String(input), 'http://localhost').searchParams;
      const os = params.get('osType');
      const included = (params.get('includeIds') ?? '').split(',').includes('win-host-1') ? [windowsHost] : [];
      if (os === 'linux') return makeJsonResponse(page([linuxHost, ...included]));
      if (os === 'windows') return makeJsonResponse(page([windowsHost]));
      return makeJsonResponse(page([{ id: 'd-1', hostname: 'srv-01', displayName: null, osType: 'windows', status: 'online', siteId: null, siteName: null }]));
    });
  });

  const hostFetchOsTypes = () =>
    fetchMock.mock.calls
      .map(([url]) => new URL(String(url), 'http://localhost').searchParams)
      .filter((params) => params.has('osType'))
      .map((params) => params.get('osType'));

  it('switches the host picker to Windows hosts and shows the Windows default output dir', async () => {
    const { onChange } = renderCard(makeGroup({ stepType: 'BARE_METAL_REBUILD', rebuildHostDeviceId: 'host-1', outputDir: '' }));
    await screen.findByText('rebuild-host-01');
    const outputDir = screen.getByTestId('dr-group-rebuild-output-dir') as HTMLInputElement;
    expect(outputDir.placeholder).toBe('/var/lib/breeze/rebuild/out');

    fireEvent.change(screen.getByTestId('dr-group-rebuild-host-os'), { target: { value: 'windows' } });

    expect(await screen.findByText('hv-rebuild-01')).toBeInTheDocument();
    expect(outputDir.placeholder).toBe('C:\\ProgramData\\Breeze\\rebuild\\out');
    // The previously picked Linux host no longer matches → cleared.
    const updater = onChange.mock.calls.at(-1)![0] as (group: DRGroupForm) => DRGroupForm;
    expect(updater(makeGroup({ rebuildHostDeviceId: 'host-1' })).rebuildHostDeviceId).toBeNull();

    expect(hostFetchOsTypes()).toContain('windows');
    expect(hostFetchOsTypes()).not.toContain('macos');
  });

  it('follows a saved Windows rebuild host to the Windows filter', async () => {
    renderCard(makeGroup({ stepType: 'BARE_METAL_REBUILD', rebuildHostDeviceId: 'win-host-1', outputDir: '' }));
    await waitFor(() =>
      expect((screen.getByTestId('dr-group-rebuild-host-os') as HTMLSelectElement).value).toBe('windows')
    );
    expect((screen.getByTestId('dr-group-rebuild-output-dir') as HTMLInputElement).placeholder).toBe(
      'C:\\ProgramData\\Breeze\\rebuild\\out'
    );
  });

  it('warns when the output dir does not fit the picked host OS', async () => {
    renderCard(makeGroup({ stepType: 'BARE_METAL_REBUILD', outputDir: '/srv/rebuild' }));
    await screen.findByText('rebuild-host-01');
    expect(screen.queryByTestId('dr-group-rebuild-output-dir-os-mismatch')).toBeNull();

    fireEvent.change(screen.getByTestId('dr-group-rebuild-host-os'), { target: { value: 'windows' } });
    expect(await screen.findByTestId('dr-group-rebuild-output-dir-os-mismatch')).toBeInTheDocument();
  });
});
