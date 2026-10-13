import '@/lib/i18n';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ScriptExecutionModal, { type Device } from './ScriptExecutionModal';
import type { Script } from './ScriptList';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError } from '../../lib/runAction';
import type { ScriptExecuteResult } from '../../lib/scriptExecute';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);

const script: Script = {
  id: 'sc-1',
  name: 'Rotate token',
  language: 'powershell',
  category: 'Maintenance',
  osTypes: ['windows'],
  createdAt: '2026-08-13T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
};

const devices: Device[] = [
  { id: 'd-1', hostname: 'ws-01', os: 'windows', status: 'online', siteId: 's-1', siteName: 'HQ' },
];

const groups = [
  { id: 'g-1', name: 'Front desk', type: 'static', filterFieldsUsed: [], deviceCount: 2, siteId: null },
  { id: 'g-2', name: 'Servers', type: 'dynamic', filterFieldsUsed: ['osType'], deviceCount: 2, siteId: null },
];

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function member(id: string, status = 'online') {
  return { deviceId: id, hostname: `host-${id}`, status, osType: 'windows' };
}

function installFetch(membersByGroup: Record<string, unknown[]>) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/device-groups?') || url === '/device-groups') return respond({ data: groups });
    const match = url.match(/^\/device-groups\/([^/]+)\/devices/);
    if (match) {
      const rows = membersByGroup[match[1]!] ?? [];
      return respond({ data: rows, total: rows.length });
    }
    return respond({}, 404);
  });
}

const admitted = (warnings?: string[]): ScriptExecuteResult => ({
  requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  status: 'queued',
  targets: [{ requestedDeviceId: 'd-1', admission: 'admitted', executionId: 'e-1', commandId: 'c-1', batchId: 'b-1' }],
  ...(warnings ? { warnings } : {}),
});

function renderModal(onExecute = vi.fn().mockResolvedValue(admitted())) {
  render(
    <ScriptExecutionModal script={script} devices={devices} isOpen onClose={vi.fn()} onExecute={onExecute} />,
  );
  return onExecute;
}

async function chooseGroups() {
  fireEvent.click(screen.getByTestId('run-target-mode-groups'));
  return screen.findByTestId('group-checkbox-g-1');
}

describe('ScriptExecutionModal device-group targets (#8599)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installFetch({ 'g-1': [member('d-1'), member('d-2')], 'g-2': [member('d-2'), member('d-3', 'offline')] });
  });

  it('offers a device-group mode and keeps the device picker as the default', () => {
    renderModal();
    expect(screen.getByTestId('run-target-mode-devices').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('run-target-mode-groups').getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByTestId('group-checkbox-g-1')).toBeNull();
  });

  it('sends a groups target (and no device ids) after a confirm that states the group count', async () => {
    const onExecute = renderModal();
    fireEvent.click(await chooseGroups());
    fireEvent.click(screen.getByTestId('group-checkbox-g-2'));
    await waitFor(() => expect(screen.getByTestId('group-summary').textContent).toContain('3'));

    fireEvent.click(screen.getByText('Execute'));
    const confirm = await screen.findByTestId('group-confirm-text');
    expect(confirm.textContent).toContain('2 device group(s)');
    // d-2 sits in both groups: 3 unique devices, never 4.
    expect(confirm.textContent).toContain('3 unique device(s)');

    fireEvent.click(screen.getByText('Confirm Execute'));
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    expect(onExecute).toHaveBeenCalledWith(
      'sc-1',
      { type: 'groups', groupIds: ['g-1', 'g-2'] },
      expect.anything(),
      'system',
    );
  });

  it('blocks execute when no group is selected', async () => {
    renderModal();
    await chooseGroups();
    expect((screen.getByText('Execute').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables submit and names the count when the groups exceed the 500-device cap', async () => {
    const big = Array.from({ length: 501 }, (_, i) => member(`b-${i}`));
    installFetch({ 'g-1': big });
    const onExecute = renderModal();
    fireEvent.click(await chooseGroups());

    const over = await screen.findByTestId('group-over-cap');
    expect(over.textContent).toContain('501');
    expect(over.textContent).toContain('500');
    expect((screen.getByText('Execute').closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect(onExecute).not.toHaveBeenCalled();
  });

  it('renders a server TOO_MANY_TARGETS rejection as a readable sentence with the count', async () => {
    const onExecute = vi.fn().mockRejectedValue(
      new ActionError('too many', 400, 'TOO_MANY_TARGETS', {
        count: 612,
        perGroupCounts: [{ id: 'g-1', memberCount: 612 }],
      }),
    );
    renderModal(onExecute);
    fireEvent.click(await chooseGroups());
    await waitFor(() => expect(screen.getByTestId('group-summary')).toBeTruthy());
    fireEvent.click(screen.getByText('Execute'));
    fireEvent.click(await screen.findByText('Confirm Execute'));

    const alert = await screen.findByTestId('script-execute-error');
    expect(alert.textContent).toContain('612');
    expect(alert.textContent).toContain('500');
    expect(alert.textContent).toContain('Front desk (612)');
  });

  it('renders GROUP_NOT_FOUND and NO_TARGETS rejections', async () => {
    const onExecute = vi.fn().mockRejectedValueOnce(new ActionError('x', 404, 'GROUP_NOT_FOUND', { groupIds: ['g-1'] }));
    renderModal(onExecute);
    fireEvent.click(await chooseGroups());
    await waitFor(() => expect(screen.getByTestId('group-summary')).toBeTruthy());
    fireEvent.click(screen.getByText('Execute'));
    fireEvent.click(await screen.findByText('Confirm Execute'));
    const alert = await screen.findByTestId('script-execute-error');
    expect(alert.textContent).toMatch(/no longer exist|not accessible|aren't accessible/i);
  });

  it('shows server warnings from a successful group run (e.g. a refused group)', async () => {
    const onExecute = vi.fn().mockResolvedValue(admitted(['Device group g-9 was excluded from this execution target']));
    renderModal(onExecute);
    fireEvent.click(await chooseGroups());
    await waitFor(() => expect(screen.getByTestId('group-summary')).toBeTruthy());
    fireEvent.click(screen.getByText('Execute'));
    fireEvent.click(await screen.findByText('Confirm Execute'));

    const warnings = await screen.findByTestId('script-execute-warnings');
    expect(warnings.textContent).toContain('Device group g-9 was excluded');
  });

  it('labels admitted targets by hostname when the run came from groups', async () => {
    const onExecute = vi.fn().mockResolvedValue({
      ...admitted(),
      targets: [{ requestedDeviceId: 'd-2', admission: 'admitted', executionId: 'e-1' }],
    });
    renderModal(onExecute);
    fireEvent.click(await chooseGroups());
    await waitFor(() => expect(screen.getByTestId('group-summary')).toBeTruthy());
    fireEvent.click(screen.getByText('Execute'));
    fireEvent.click(await screen.findByText('Confirm Execute'));
    expect(await screen.findByText('host-d-2')).toBeTruthy();
  });

  it('still sends a plain device-id array in device mode', async () => {
    const onExecute = renderModal();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('Execute'));
    fireEvent.click(await screen.findByText('Confirm Execute'));
    await waitFor(() => expect(onExecute).toHaveBeenCalledWith('sc-1', ['d-1'], expect.anything(), 'system'));
  });
});
