import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DRPlanEditor from './DRPlanEditor';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const deviceOptionsPayload = {
  data: [
    { id: 'd-99', hostname: 'zzz-dr-device', displayName: null, osType: 'linux', status: 'online', siteId: null, siteName: null },
  ],
  page: { nextCursor: null, returned: 1, total: 1, hasMore: false, observedAt: '' },
};

describe('DRPlanEditor device options', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(makeJsonResponse(deviceOptionsPayload));
  });

  it('lets each recovery group search authorized server options', async () => {
    render(<DRPlanEditor open planId={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findByText('zzz-dr-device')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => /^\/devices(?:\?|$)/.test(String(url)))).toBe(false);
  });
});

describe('DRPlanEditor step type', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('refuses to save a group without a step type', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse(deviceOptionsPayload));
    render(<DRPlanEditor open planId={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Plan name'), { target: { value: 'Plan A' } });
    fireEvent.change(screen.getByPlaceholderText('Core services'), { target: { value: 'Tier 1' } });
    const deviceRow = await screen.findByText('zzz-dr-device');
    fireEvent.click(deviceRow.closest('label')!.querySelector('input')!);

    const save = screen.getByText('Save plan').closest('button')!;
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);

    expect(await screen.findByText('Choose a step type for each recovery group.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url, init]) => String(url) === '/dr/plans' && (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
  });

  it('serialises BARE_METAL_REBUILD options into restoreConfig on save', async () => {
    const onSaved = vi.fn();
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url.startsWith('/devices/options')) return makeJsonResponse(deviceOptionsPayload);
      if (url === '/dr/plans' && method === 'POST') return makeJsonResponse({ data: { id: 'plan-1' } });
      if (url === '/dr/plans/plan-1/groups' && method === 'POST') return makeJsonResponse({ data: { id: 'group-1' } });
      return makeJsonResponse({}, false, 404);
    });

    render(<DRPlanEditor open planId={null} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('Plan name'), { target: { value: 'Plan A' } });
    fireEvent.change(screen.getByPlaceholderText('Core services'), { target: { value: 'Tier 1' } });
    fireEvent.change(screen.getByTestId('dr-group-step-type'), { target: { value: 'BARE_METAL_REBUILD' } });

    const deviceRows = await screen.findAllByText('zzz-dr-device');
    // First picker is the group device selection (multi), second the Linux rebuild host (single).
    fireEvent.click(deviceRows[0]!.closest('label')!.querySelector('input')!);
    fireEvent.click(deviceRows[1]!.closest('label')!.querySelector('input')!);
    fireEvent.change(screen.getByTestId('dr-group-rebuild-output-dir'), { target: { value: '/srv/rebuild' } });
    fireEvent.change(screen.getByTestId('dr-group-rebuild-wait-timeout'), { target: { value: '90' } });

    const save = screen.getByText('Save plan').closest('button')!;
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const groupCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === '/dr/plans/plan-1/groups' && (init as RequestInit | undefined)?.method === 'POST'
    );
    expect(groupCall).toBeDefined();
    const body = JSON.parse(String((groupCall![1] as RequestInit).body));
    expect(body.devices).toEqual(['d-99']);
    expect(body.restoreConfig).toEqual({
      commandType: 'BARE_METAL_REBUILD',
      snapshotSelection: 'latest_restorable',
      rebuildHostDeviceId: 'd-99',
      outputDir: '/srv/rebuild',
      waitTimeoutMinutes: 90,
    });
  });

  it('reads restoreConfig back into the form when editing and re-sends it unchanged', async () => {
    const onSaved = vi.fn();
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url.startsWith('/devices/options')) return makeJsonResponse(deviceOptionsPayload);
      if (url === '/dr/plans/plan-1' && method === 'GET') {
        return makeJsonResponse({
          data: {
            id: 'plan-1',
            name: 'Plan A',
            description: null,
            status: 'draft',
            rpoTargetMinutes: 60,
            rtoTargetMinutes: 240,
            groups: [
              {
                id: 'group-1',
                name: 'Tier 1',
                sequence: 0,
                dependsOnGroupId: null,
                devices: ['d-99'],
                estimatedDurationMinutes: 30,
                restoreConfig: { commandType: 'MSSQL_RESTORE', payload: { databaseName: 'erp' } },
              },
            ],
          },
        });
      }
      if (url === '/dr/plans/plan-1' && method === 'PATCH') return makeJsonResponse({ data: { id: 'plan-1' } });
      if (url === '/dr/plans/plan-1/groups/group-1' && method === 'PATCH') return makeJsonResponse({ data: { id: 'group-1' } });
      return makeJsonResponse({}, false, 404);
    });

    render(<DRPlanEditor open planId="plan-1" onClose={vi.fn()} onSaved={onSaved} />);
    const select = (await screen.findByTestId('dr-group-step-type')) as HTMLSelectElement;
    expect(select.value).toBe('MSSQL_RESTORE');

    const save = screen.getByText('Save plan').closest('button')!;
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const groupCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === '/dr/plans/plan-1/groups/group-1' && (init as RequestInit | undefined)?.method === 'PATCH'
    );
    const body = JSON.parse(String((groupCall![1] as RequestInit).body));
    expect(body.restoreConfig).toEqual({ commandType: 'MSSQL_RESTORE', payload: { databaseName: 'erp' } });
  });
});
