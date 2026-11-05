import '@/lib/i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { fetchMock, toastMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), toastMock: vi.fn() }));

vi.mock('../../stores/auth', () => ({ fetchWithAuth: fetchMock }));
vi.mock('../shared/Toast', async () => {
  const actual = await vi.importActual<typeof import('../shared/Toast')>('../shared/Toast');
  return { ...actual, showToast: toastMock };
});

import RunVendorUpdatesDialog from './RunVendorUpdatesDialog';
import type { OemDispatchRefusal } from '@breeze/shared';

// A new refusal in the API fails the typecheck here until it has its own copy. A 404
// and a 403 are not answered inline, so those two are not the dialog's to word.
const REFUSAL_REASONS: Record<Exclude<OemDispatchRefusal, 'device_not_found' | 'trust_denied'>, RegExp> = {
  flag_off: /not turned on/i,
  lane_closed: /not available yet/i,
  kill_switch: /paused/i,
  agent_too_old: /too old/i,
  not_applicable: /do not apply/i,
  not_supported: /does not support this model/i,
  ephemeral: /Quick Support/,
  parked: /Assign this device/,
  offline: /not online/i,
  run_in_flight: /already in progress/i,
  no_open_categories: /reboot when finished/i,
  decommissioned: /decommissioned/i,
  cancelled_at_claim: /cancelled/i,
};

const DEVICE = { id: 'device-1', hostname: 'LAPTOP-07' };

const respond = (status: number, body: unknown): Response =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

function renderDialog() {
  const onClose = vi.fn();
  const onCompleted = vi.fn();
  render(<RunVendorUpdatesDialog open device={DEVICE} lane="dell" onClose={onClose} onCompleted={onCompleted} />);
  return { onClose, onCompleted };
}

const confirm = () => screen.getByTestId('run-vendor-updates-confirm');
const whenFinished = () => screen.getByTestId('run-vendor-updates-reboot-when-finished');
const leaveToMe = () => screen.getByTestId('run-vendor-updates-reboot-leave-to-me');

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue(respond(202, { commandId: 'c-1', categories: ['driver'], skippedCategories: [] }));
});

describe('RunVendorUpdatesDialog', () => {
  it('names the device and the vendor', () => {
    renderDialog();
    const dialog = screen.getByTestId('run-vendor-updates-dialog');
    expect(dialog).toHaveTextContent('LAPTOP-07');
    expect(dialog).toHaveTextContent('Dell');
  });

  it('dialog requires choosing reboot when finished or leave reboot to me, no default', async () => {
    renderDialog();
    expect(whenFinished()).not.toBeChecked();
    expect(leaveToMe()).not.toBeChecked();
    expect(confirm()).toBeDisabled();
    await userEvent.click(confirm());
    expect(fetchMock).not.toHaveBeenCalled();

    await userEvent.click(whenFinished());
    expect(confirm()).toBeEnabled();
  });

  it('leave reboot to me names the skipped BIOS and firmware', async () => {
    renderDialog();
    expect(screen.queryByTestId('run-vendor-updates-skipped-note')).toBeNull();
    await userEvent.click(leaveToMe());
    const note = screen.getByTestId('run-vendor-updates-skipped-note');
    expect(note).toHaveTextContent(/BIOS/);
    expect(note).toHaveTextContent(/firmware/i);

    await userEvent.click(whenFinished());
    expect(screen.queryByTestId('run-vendor-updates-skipped-note')).toBeNull();
  });

  it.each([
    ['when_finished', whenFinished],
    ['leave_to_me', leaveToMe],
  ])('posts the choice %s', async (reboot, choice) => {
    const { onClose, onCompleted } = renderDialog();
    await userEvent.click(choice());
    await userEvent.click(confirm());
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/devices/device-1/oem-updates/run');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ reboot });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says on success what it skipped', async () => {
    fetchMock.mockResolvedValue(respond(202, { commandId: 'c-1', categories: ['driver'], skippedCategories: ['bios', 'firmware'] }));
    renderDialog();
    await userEvent.click(leaveToMe());
    await userEvent.click(confirm());
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    const toast = toastMock.mock.calls[0]![0];
    expect(toast.type).toBe('success');
    expect(toast.message).toMatch(/LAPTOP-07/);
    expect(toast.message).toMatch(/BIOS/);
  });

  it('a plain success does not mention a skip', async () => {
    renderDialog();
    await userEvent.click(whenFinished());
    await userEvent.click(confirm());
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    expect(toastMock.mock.calls[0]![0].message).not.toMatch(/BIOS/);
  });

  it.each(Object.entries(REFUSAL_REASONS))('runAction used, 409 refusal shows its reason: %s', async (code, reason) => {
    fetchMock.mockResolvedValue(respond(409, { error: 'server prose', code }));
    const { onClose, onCompleted } = renderDialog();
    await userEvent.click(whenFinished());
    await userEvent.click(confirm());
    const error = await screen.findByTestId('run-vendor-updates-error');
    expect(error).toHaveTextContent(reason);
    expect(error).not.toHaveTextContent('server prose');
    // Inline, so it stays beside the choice, and not a second time as a toast.
    expect(toastMock).not.toHaveBeenCalled();
    expect(onCompleted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('agent_too_old names the version the server asked for', async () => {
    fetchMock.mockResolvedValue(respond(409, { error: 'x', code: 'agent_too_old', minAgentVersion: '9.9.9' }));
    renderDialog();
    await userEvent.click(whenFinished());
    await userEvent.click(confirm());
    expect(await screen.findByTestId('run-vendor-updates-error')).toHaveTextContent('9.9.9');
  });

  it('an unknown refusal code still shows the server reason', async () => {
    fetchMock.mockResolvedValue(respond(409, { error: 'Something new from the server', code: 'brand_new' }));
    renderDialog();
    await userEvent.click(whenFinished());
    await userEvent.click(confirm());
    expect(await screen.findByTestId('run-vendor-updates-error')).toHaveTextContent('Something new from the server');
  });

  it('a 403 is toasted by runAction and the dialog stays open', async () => {
    fetchMock.mockResolvedValue(respond(403, { error: 'MFA required', code: 'MFA_REQUIRED' }));
    const { onClose, onCompleted } = renderDialog();
    await userEvent.click(whenFinished());
    await userEvent.click(confirm());
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    expect(toastMock.mock.calls[0]![0].type).toBe('error');
    expect(onCompleted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a network failure is toasted and the choice can be retried', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'));
    renderDialog();
    await userEvent.click(whenFinished());
    await userEvent.click(confirm());
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    await waitFor(() => expect(confirm()).toBeEnabled());
  });

  it('a double click sends one run', async () => {
    let release: (value: Response) => void = () => undefined;
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => { release = resolve; }));
    renderDialog();
    await userEvent.click(whenFinished());
    await userEvent.click(confirm());
    expect(confirm()).toBeDisabled();
    await userEvent.click(confirm());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release(respond(202, { commandId: 'c-1', categories: ['driver'], skippedCategories: [] }));
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
  });

  it('a new opening forgets the last choice', async () => {
    const { rerender } = render(
      <RunVendorUpdatesDialog open device={DEVICE} lane="dell" onClose={vi.fn()} onCompleted={vi.fn()} />,
    );
    await userEvent.click(whenFinished());
    rerender(<RunVendorUpdatesDialog open={false} device={DEVICE} lane="dell" onClose={vi.fn()} onCompleted={vi.fn()} />);
    rerender(<RunVendorUpdatesDialog open device={DEVICE} lane="dell" onClose={vi.fn()} onCompleted={vi.fn()} />);
    expect(whenFinished()).not.toBeChecked();
    expect(confirm()).toBeDisabled();
  });
});
