import '@/lib/i18n';
import { fireEvent, render, screen } from '@testing-library/react';
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
