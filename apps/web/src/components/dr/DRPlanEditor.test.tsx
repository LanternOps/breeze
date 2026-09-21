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

// #6382: a save is a plan write followed by one write per group and cannot be
// rolled back from the browser. A group value the server rejects therefore used
// to commit the plan rename while telling the operator the save had failed, and
// the list behind the dialog kept the stale name until a manual reload.
describe('DRPlanEditor save atomicity (#6382)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  const editablePlanPayload = {
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
          restoreConfig: {
            commandType: 'BARE_METAL_REBUILD',
            snapshotSelection: 'latest_restorable',
            outputDir: '/srv/rebuild',
            waitTimeoutMinutes: 90,
          },
        },
      ],
    },
  };

  const renderEditor = async (onPartialSave = vi.fn()) => {
    render(
      <DRPlanEditor
        open
        planId="plan-1"
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onPartialSave={onPartialSave}
      />
    );
    const save = (await screen.findByText('Save plan')).closest('button')!;
    await waitFor(() => expect(save).not.toBeDisabled());
    return { save, onPartialSave };
  };

  it('refuses a relative rebuild output dir before issuing any write', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url.startsWith('/devices/options')) return makeJsonResponse(deviceOptionsPayload);
      if (url === '/dr/plans/plan-1' && method === 'GET') return makeJsonResponse(editablePlanPayload);
      return makeJsonResponse({}, false, 404);
    });

    const { save } = await renderEditor();
    fireEvent.change(screen.getByLabelText('Plan name'), { target: { value: 'Renamed plan' } });
    fireEvent.change(screen.getByTestId('dr-group-rebuild-output-dir'), {
      target: { value: 'relative/out' },
    });
    fireEvent.click(save);

    expect(
      await screen.findByText(/output directory must be an absolute path/i)
    ).toBeInTheDocument();
    // The rename must NOT have been committed.
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url) === '/dr/plans/plan-1' && (init as RequestInit | undefined)?.method === 'PATCH'
      )
    ).toBe(false);
  });

  it('scrolls the error banner into view and focuses it on validation failure (#6494)', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url.startsWith('/devices/options')) return makeJsonResponse(deviceOptionsPayload);
      if (url === '/dr/plans/plan-1' && method === 'GET') return makeJsonResponse(editablePlanPayload);
      return makeJsonResponse({}, false, 404);
    });

    // jsdom has no scrollIntoView implementation; stub it inline (not
    // through a separately-typed variable, which loses the prototype's own
    // call signature and fails astro check's ts(2322)).
    HTMLElement.prototype.scrollIntoView = vi.fn();

    const { save } = await renderEditor();
    fireEvent.change(screen.getByLabelText('Plan name'), { target: { value: 'Renamed plan' } });
    fireEvent.change(screen.getByTestId('dr-group-rebuild-output-dir'), {
      target: { value: 'relative/out' },
    });
    fireEvent.click(save);

    const banner = await screen.findByText(/output directory must be an absolute path/i);
    await waitFor(() =>
      expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
    );
    await waitFor(() => expect(banner).toHaveFocus());
  });

  it('refuses an over-long rebuild output dir before issuing any write', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url.startsWith('/devices/options')) return makeJsonResponse(deviceOptionsPayload);
      if (url === '/dr/plans/plan-1' && method === 'GET') return makeJsonResponse(editablePlanPayload);
      return makeJsonResponse({}, false, 404);
    });

    const { save } = await renderEditor();
    fireEvent.change(screen.getByTestId('dr-group-rebuild-output-dir'), {
      target: { value: `/srv/${'a'.repeat(1024)}` },
    });
    fireEvent.click(save);

    expect(
      await screen.findByText(/output directory must be an absolute path/i)
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url) === '/dr/plans/plan-1' && (init as RequestInit | undefined)?.method === 'PATCH'
      )
    ).toBe(false);
  });

  it('reports every failed group removal, not just the first', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url.startsWith('/devices/options')) return makeJsonResponse(deviceOptionsPayload);
      if (url === '/dr/plans/plan-1' && method === 'GET') {
        return makeJsonResponse({
          data: {
            ...editablePlanPayload.data,
            groups: [
              editablePlanPayload.data.groups[0]!,
              { ...editablePlanPayload.data.groups[0]!, id: 'group-2', name: 'Tier 2', sequence: 1 },
              { ...editablePlanPayload.data.groups[0]!, id: 'group-3', name: 'Tier 3', sequence: 2 },
            ],
          },
        });
      }
      if (url === '/dr/plans/plan-1' && method === 'PATCH') return makeJsonResponse({ data: { id: 'plan-1' } });
      if (/\/groups\/group-\d$/.test(url) && method === 'PATCH') return makeJsonResponse({ data: {} });
      if (/\/groups\/group-[23]$/.test(url) && method === 'DELETE') {
        return makeJsonResponse({ error: `cannot remove ${url.split('/').pop()}` }, false, 409);
      }
      return makeJsonResponse({}, false, 404);
    });

    const onPartialSave = vi.fn();
    const { save } = await renderEditor(onPartialSave);
    // Drop the last two groups so both removals are issued concurrently.
    const removeButtons = screen.getAllByRole('button', { name: /remove (recovery )?group/i });
    fireEvent.click(removeButtons[2]!);
    fireEvent.click(screen.getAllByRole('button', { name: /remove (recovery )?group/i })[1]!);
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);

    const banner = await screen.findByText(/cannot remove group-2/i);
    expect(banner.textContent).toMatch(/cannot remove group-3/i);
    await waitFor(() => expect(onPartialSave).toHaveBeenCalled());
  });

  it('reports a partially applied save and asks the caller to refetch', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url.startsWith('/devices/options')) return makeJsonResponse(deviceOptionsPayload);
      if (url === '/dr/plans/plan-1' && method === 'GET') return makeJsonResponse(editablePlanPayload);
      if (url === '/dr/plans/plan-1' && method === 'PATCH') return makeJsonResponse({ data: { id: 'plan-1' } });
      if (url === '/dr/plans/plan-1/groups/group-1' && method === 'PATCH') {
        return makeJsonResponse({ error: 'invalid group' }, false, 400);
      }
      return makeJsonResponse({}, false, 404);
    });

    const onPartialSave = vi.fn();
    const { save } = await renderEditor(onPartialSave);
    fireEvent.change(screen.getByLabelText('Plan name'), { target: { value: 'Renamed plan' } });
    fireEvent.click(save);

    expect(await screen.findByText(/Part of this plan was saved/i)).toBeInTheDocument();
    await waitFor(() => expect(onPartialSave).toHaveBeenCalled());
  });
});
