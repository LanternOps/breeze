import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { remediateFindingMock, fetchWithAuthMock, handleActionErrorMock } = vi.hoisted(() => ({
  remediateFindingMock: vi.fn(),
  fetchWithAuthMock: vi.fn(),
  handleActionErrorMock: vi.fn(),
}));

vi.mock('@/services/fleetFindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/fleetFindings')>();
  return { ...actual, remediateFinding: remediateFindingMock };
});

// ScriptPickerModal (reused verbatim from the device bulk run-script flow)
// fetches `/scripts?includeSystem=true` through the auth store.
vi.mock('@/stores/auth', () => ({ fetchWithAuth: fetchWithAuthMock }));

vi.mock('@/lib/runAction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runAction')>();
  return { ...actual, handleActionError: handleActionErrorMock };
});

import FixPickerModal from './FixPickerModal';
import { ActionError } from '@/lib/runAction';
import type { FleetFindingDetail } from '@/services/fleetFindings';

const FINDING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddda1';
const DEVICE_B = 'dddddddd-dddd-4ddd-8ddd-ddddddddddb2';
const DEVICE_C = 'dddddddd-dddd-4ddd-8ddd-ddddddddddc3';
const RUN_ID = 'rrrrrrrr-rrrr-4rrr-8rrr-rrrrrrrrrrrr';
const SCRIPT_ID = '55555555-5555-4555-8555-555555555555';

// Defaults to 'windows' so every pre-existing test (whose scripts all declare
// osTypes: ['windows']) keeps seeing every member as OS-compatible — only
// tests that explicitly pass 'macos'/'linux' exercise the new exclusion path.
function member(id: string, hostname: string, osType: 'windows' | 'macos' | 'linux' = 'windows') {
  return {
    deviceId: id,
    hostname,
    displayName: null,
    siteId: '33333333-3333-4333-8333-333333333333',
    osType,
    sourceKind: 'reliability_score',
    memberEvidence: {},
    firstSeenAt: '2026-08-01T10:00:00.000Z',
    lastSeenAt: '2026-08-07T10:00:00.000Z',
  };
}

function detail(overrides: Partial<FleetFindingDetail> = {}): FleetFindingDetail {
  return {
    id: FINDING_ID,
    orgId: '11111111-1111-4111-8111-111111111111',
    orgName: 'Acme Corp',
    kind: 'reliability_offenders',
    semanticKey: 'crash_loop',
    status: 'open',
    severity: 'error',
    title: 'Repeat crashers in the fleet',
    summary: null,
    evidence: {},
    deviceCount: 2,
    revision: 2,
    firstSeenAt: '2026-08-01T10:00:00.000Z',
    lastSeenAt: '2026-08-07T10:00:00.000Z',
    acknowledgedAt: null,
    acknowledgedBy: null,
    dismissedAt: null,
    dismissedBy: null,
    dismissNotes: null,
    resolvedAt: null,
    resolutionReason: null,
    members: [member(DEVICE_A, 'WS-ACME-01'), member(DEVICE_B, 'WS-ACME-02')],
    runs: [],
    ...overrides,
  };
}

function scriptsResponse(parameters: unknown[] = []) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: [
        {
          id: SCRIPT_ID,
          name: 'Clear temp files',
          description: 'Removes stale temp files',
          language: 'powershell',
          category: 'Maintenance',
          osTypes: ['windows'],
          parameters,
        },
      ],
    }),
  } as unknown as Response;
}

function renderPicker(props: Partial<React.ComponentProps<typeof FixPickerModal>> = {}) {
  const onClose = vi.fn();
  const onRunStarted = vi.fn();
  render(
    <FixPickerModal
      finding={detail()}
      onClose={onClose}
      onRunStarted={onRunStarted}
      {...props}
    />
  );
  return { onClose, onRunStarted };
}

/** Step 1 -> step 2. */
function goToTargets() {
  fireEvent.click(screen.getByTestId('fix-picker-next'));
}

beforeEach(() => {
  fetchWithAuthMock.mockResolvedValue(scriptsResponse());
  remediateFindingMock.mockResolvedValue({ runId: RUN_ID, targetCount: 2, skipped: [] });
});

describe('FixPickerModal — step 1 action validation', () => {
  it('blocks advancing when "run a script" is chosen but no script is selected', () => {
    renderPicker();

    fireEvent.click(screen.getByTestId('fix-picker-action-script'));

    expect((screen.getByTestId('fix-picker-next') as HTMLButtonElement).disabled).toBe(true);
  });

  it('blocks advancing when restart_service has no service name', () => {
    renderPicker();

    fireEvent.click(screen.getByTestId('fix-picker-action-restart_service'));
    expect((screen.getByTestId('fix-picker-next') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId('fix-picker-service-name'), {
      target: { value: '   ' },
    });
    expect((screen.getByTestId('fix-picker-next') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId('fix-picker-service-name'), {
      target: { value: 'Spooler' },
    });
    expect((screen.getByTestId('fix-picker-next') as HTMLButtonElement).disabled).toBe(false);
  });

  it('lets reboot advance immediately and warns that devices restart at once', () => {
    renderPicker();

    fireEvent.click(screen.getByTestId('fix-picker-action-reboot'));

    expect(screen.getByTestId('fix-picker-reboot-warning')).toBeTruthy();
    expect((screen.getByTestId('fix-picker-next') as HTMLButtonElement).disabled).toBe(false);
  });

  it('never offers a clear_temp_files preset (cut in Task 7 — no command primitive)', () => {
    renderPicker();

    expect(screen.queryByTestId('fix-picker-action-clear_temp_files')).toBeNull();
  });

  it('selects a script through the shared ScriptPickerModal and unblocks the step', async () => {
    renderPicker();

    fireEvent.click(screen.getByTestId('fix-picker-action-script'));
    fireEvent.click(screen.getByTestId('fix-picker-choose-script'));

    await waitFor(() => expect(screen.getByText('Clear temp files')).toBeTruthy());
    fireEvent.click(screen.getByText('Clear temp files'));

    await waitFor(() =>
      expect(screen.getByTestId('fix-picker-selected-script').textContent).toContain(
        'Clear temp files'
      )
    );
    expect((screen.getByTestId('fix-picker-next') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('FixPickerModal — step 2 target review', () => {
  it('selects every member by default and disables confirm when none remain', () => {
    renderPicker();
    fireEvent.click(screen.getByTestId('fix-picker-action-reboot'));
    goToTargets();

    expect((screen.getByTestId(`fix-picker-target-${DEVICE_A}`) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId(`fix-picker-target-${DEVICE_B}`) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('fix-picker-next') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId(`fix-picker-target-${DEVICE_A}`));
    fireEvent.click(screen.getByTestId(`fix-picker-target-${DEVICE_B}`));

    expect((screen.getByTestId('fix-picker-next') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('FixPickerModal — OS compatibility (scripts)', () => {
  // A macOS device in a finding whose "Clear temp files" script (from
  // scriptsResponse()) declares osTypes: ['windows'] — the exact repro from
  // the live-stack bug report (an OS-incompatible script dispatched to
  // e2e-macos.local with no warning).
  function findingWithMacDevice() {
    return detail({
      deviceCount: 3,
      members: [
        member(DEVICE_A, 'WS-ACME-01', 'windows'),
        member(DEVICE_B, 'WS-ACME-02', 'windows'),
        member(DEVICE_C, 'e2e-macos.local', 'macos'),
      ],
    });
  }

  async function chooseWindowsOnlyScript() {
    fireEvent.click(screen.getByTestId('fix-picker-action-script'));
    fireEvent.click(screen.getByTestId('fix-picker-choose-script'));
    await waitFor(() => expect(screen.getByText('Clear temp files')).toBeTruthy());
    fireEvent.click(screen.getByText('Clear temp files'));
    await waitFor(() => expect(screen.getByTestId('fix-picker-selected-script')).toBeTruthy());
  }

  it('excludes the OS-incompatible device from the default target selection and marks it non-selectable', async () => {
    renderPicker({ finding: findingWithMacDevice() });

    await chooseWindowsOnlyScript();
    goToTargets();

    expect((screen.getByTestId(`fix-picker-target-${DEVICE_A}`) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId(`fix-picker-target-${DEVICE_B}`) as HTMLInputElement).checked).toBe(true);
    const macTarget = screen.getByTestId(`fix-picker-target-${DEVICE_C}`) as HTMLInputElement;
    expect(macTarget.checked).toBe(false);
    expect(macTarget.disabled).toBe(true);
    expect(screen.getByTestId(`fix-picker-target-incompatible-${DEVICE_C}`).textContent).toContain('Windows');
  });

  it('restores an OS-pruned device when the fix kind can reach it again', async () => {
    // Picking a Windows-only script prunes the macOS device; switching back to
    // reboot (no OS constraint) used to leave it enabled-but-unchecked with no
    // hint it had ever been selected, so the operator dispatched to fewer
    // devices than they believed. Only system-pruned devices come back.
    renderPicker({ finding: findingWithMacDevice() });

    await chooseWindowsOnlyScript();
    goToTargets();
    expect((screen.getByTestId(`fix-picker-target-${DEVICE_C}`) as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByTestId('fix-picker-back'));
    fireEvent.click(screen.getByTestId('fix-picker-action-reboot'));
    goToTargets();

    const macTarget = screen.getByTestId(`fix-picker-target-${DEVICE_C}`) as HTMLInputElement;
    expect(macTarget.disabled).toBe(false);
    expect(macTarget.checked).toBe(true);
  });

  it('does not re-add a device the operator deselected by hand', async () => {
    renderPicker({ finding: findingWithMacDevice() });

    await chooseWindowsOnlyScript();
    goToTargets();
    // DEVICE_A is compatible — unchecking it is a manual choice, not a prune.
    fireEvent.click(screen.getByTestId(`fix-picker-target-${DEVICE_A}`));
    expect((screen.getByTestId(`fix-picker-target-${DEVICE_A}`) as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByTestId('fix-picker-back'));
    fireEvent.click(screen.getByTestId('fix-picker-action-reboot'));
    goToTargets();

    expect((screen.getByTestId(`fix-picker-target-${DEVICE_A}`) as HTMLInputElement).checked).toBe(false);
  });

  it('does not let a click re-check the disabled incompatible device', async () => {
    renderPicker({ finding: findingWithMacDevice() });

    await chooseWindowsOnlyScript();
    goToTargets();

    fireEvent.click(screen.getByTestId(`fix-picker-target-${DEVICE_C}`));

    expect((screen.getByTestId(`fix-picker-target-${DEVICE_C}`) as HTMLInputElement).checked).toBe(false);
  });

  it('excludes the OS-incompatible device from "Select all"', async () => {
    renderPicker({ finding: findingWithMacDevice() });

    await chooseWindowsOnlyScript();
    goToTargets();
    // Deselect a compatible device first so "select all" has to do
    // something, then confirm it brings back only the compatible ones.
    fireEvent.click(screen.getByTestId(`fix-picker-target-${DEVICE_A}`));
    fireEvent.click(screen.getByTestId('fix-picker-select-all'));

    expect((screen.getByTestId(`fix-picker-target-${DEVICE_A}`) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId(`fix-picker-target-${DEVICE_B}`) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId(`fix-picker-target-${DEVICE_C}`) as HTMLInputElement).checked).toBe(false);
  });

  it('never sends the OS-incompatible device in the remediate request', async () => {
    renderPicker({ finding: findingWithMacDevice() });

    await chooseWindowsOnlyScript();
    goToTargets();
    fireEvent.click(screen.getByTestId('fix-picker-next'));
    fireEvent.click(screen.getByTestId('fix-picker-confirm'));

    await waitFor(() => expect(remediateFindingMock).toHaveBeenCalledTimes(1));
    expect(remediateFindingMock.mock.calls[0][1].deviceIds).toEqual([DEVICE_A, DEVICE_B]);
  });

  it('shows an incompatibility notice naming the excluded count and required OS', async () => {
    renderPicker({ finding: findingWithMacDevice() });

    await chooseWindowsOnlyScript();
    goToTargets();

    const notice = screen.getByTestId('fix-picker-os-incompatible-notice');
    expect(notice.textContent).toContain('1');
    expect(notice.textContent).toContain('Windows');
  });

  it('does not restrict targets for non-script fix kinds (reboot has no OS constraint)', () => {
    renderPicker({ finding: findingWithMacDevice() });

    fireEvent.click(screen.getByTestId('fix-picker-action-reboot'));
    goToTargets();

    expect((screen.getByTestId(`fix-picker-target-${DEVICE_C}`) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId(`fix-picker-target-${DEVICE_C}`) as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByTestId('fix-picker-os-incompatible-notice')).toBeNull();
  });
});

describe('FixPickerModal — step 3 confirm + dispatch', () => {
  function advanceToConfirm(action: 'reboot' | 'restart_service' = 'reboot') {
    fireEvent.click(screen.getByTestId(`fix-picker-action-${action}`));
    if (action === 'restart_service') {
      fireEvent.change(screen.getByTestId('fix-picker-service-name'), {
        target: { value: 'Spooler' },
      });
    }
    goToTargets();
    fireEvent.click(screen.getByTestId('fix-picker-next'));
  }

  it('posts every member when the full set is selected', async () => {
    renderPicker();
    advanceToConfirm();

    fireEvent.click(screen.getByTestId('fix-picker-confirm'));

    await waitFor(() => expect(remediateFindingMock).toHaveBeenCalledTimes(1));
    expect(remediateFindingMock).toHaveBeenCalledWith(FINDING_ID, {
      actionKind: 'command',
      commandType: 'reboot',
      parameters: {},
      deviceIds: [DEVICE_A, DEVICE_B],
    });
  });

  it('posts the script path as actionKind "script" with scriptId + parameters and NO commandType', async () => {
    // The script branch was the one dispatch shape with no coverage here, and
    // it is the one the API now rejects outright if it carries a commandType
    // (the remediate schema is a discriminatedUnion of `.strict()` branches).
    fetchWithAuthMock.mockResolvedValue(
      scriptsResponse([{ name: 'olderThanDays', type: 'number', required: true, defaultValue: 7 }])
    );
    renderPicker();

    fireEvent.click(screen.getByTestId('fix-picker-action-script'));
    fireEvent.click(screen.getByTestId('fix-picker-choose-script'));
    await waitFor(() => expect(screen.getByText('Clear temp files')).toBeTruthy());
    fireEvent.click(screen.getByText('Clear temp files'));
    // A parameterised script routes through ScriptPickerModal's parameter
    // form, so selection completes on its confirm button, not the row click.
    await waitFor(() => expect(screen.getByText('Run Script')).toBeTruthy());
    fireEvent.click(screen.getByText('Run Script'));
    await waitFor(() => expect(screen.getByTestId('fix-picker-selected-script')).toBeTruthy());

    goToTargets();
    fireEvent.click(screen.getByTestId('fix-picker-next'));
    fireEvent.click(screen.getByTestId('fix-picker-confirm'));

    await waitFor(() => expect(remediateFindingMock).toHaveBeenCalledTimes(1));
    const [findingId, payload] = remediateFindingMock.mock.calls[0];
    expect(findingId).toBe(FINDING_ID);
    expect(Object.keys(payload).sort()).toEqual(['actionKind', 'deviceIds', 'parameters', 'scriptId']);
    expect(payload.actionKind).toBe('script');
    expect(payload.scriptId).toBe(SCRIPT_ID);
    expect(payload.deviceIds).toEqual([DEVICE_A, DEVICE_B]);
    expect(payload.parameters).toBeTypeOf('object');
    expect(payload).not.toHaveProperty('commandType');
  });

  it('sends the service name under the agent payload key `name`', async () => {
    renderPicker();
    advanceToConfirm('restart_service');

    fireEvent.click(screen.getByTestId('fix-picker-confirm'));

    await waitFor(() => expect(remediateFindingMock).toHaveBeenCalledTimes(1));
    expect(remediateFindingMock.mock.calls[0][1].parameters).toEqual({ name: 'Spooler' });
  });

  it('renders the per-device skipped list before handing off to progress', async () => {
    remediateFindingMock.mockResolvedValue({
      runId: RUN_ID,
      targetCount: 2,
      skipped: [{ deviceId: DEVICE_B, reason: 'decommissioned' }],
    });
    const { onRunStarted } = renderPicker();
    advanceToConfirm();

    fireEvent.click(screen.getByTestId('fix-picker-confirm'));

    await waitFor(() => expect(screen.getByTestId('fix-picker-skipped')).toBeTruthy());
    const row = screen.getByTestId(`fix-picker-skipped-${DEVICE_B}`);
    expect(row.textContent).toContain('WS-ACME-02');
    // Scope to the reason span, not the whole row — 'removed' isn't a unique
    // token across the row the way 'decommissioned' was.
    const reason = screen.getByTestId(`fix-picker-skipped-reason-${DEVICE_B}`);
    expect(reason.textContent?.toLowerCase()).toContain('removed');
    // Handoff is explicit — the skipped list must be readable first.
    expect(onRunStarted).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('fix-picker-view-progress'));
    expect(onRunStarted).toHaveBeenCalledWith(RUN_ID);
  });

  it('hands off immediately when nothing was skipped', async () => {
    const { onRunStarted } = renderPicker();
    advanceToConfirm();

    fireEvent.click(screen.getByTestId('fix-picker-confirm'));

    await waitFor(() => expect(onRunStarted).toHaveBeenCalledWith(RUN_ID));
  });

  it('disables the confirm button and shows a spinner while the request is in flight, and ignores a second click', async () => {
    // The dispatch endpoint measured 8-18s against a live stack — a deferred
    // promise stands in for that window so the test can assert the busy
    // state WHILE the request is pending, not just before/after.
    let resolveRequest: (value: { runId: string; targetCount: number; skipped: never[] }) => void = () => {};
    remediateFindingMock.mockReturnValue(
      new Promise((resolve) => { resolveRequest = resolve; })
    );
    const { onRunStarted } = renderPicker();
    advanceToConfirm();

    const confirmButton = screen.getByTestId('fix-picker-confirm') as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(false);

    fireEvent.click(confirmButton);

    expect(confirmButton.disabled).toBe(true);
    expect(confirmButton.querySelector('.animate-spin')).toBeTruthy();

    // A click on a disabled button must not fire a second dispatch.
    fireEvent.click(confirmButton);
    expect(remediateFindingMock).toHaveBeenCalledTimes(1);

    resolveRequest({ runId: RUN_ID, targetCount: 2, skipped: [] });
    await waitFor(() => expect(onRunStarted).toHaveBeenCalledWith(RUN_ID));
  });

  it('lands on the progress view when dispatch enqueue failed (502 carries a runId)', async () => {
    remediateFindingMock.mockRejectedValue(
      new ActionError('Failed to enqueue remediation dispatch', 502, undefined, {
        error: 'Failed to enqueue remediation dispatch',
        runId: RUN_ID,
      })
    );
    const { onRunStarted } = renderPicker();
    advanceToConfirm();

    fireEvent.click(screen.getByTestId('fix-picker-confirm'));

    // The run EXISTS and is marked failed — treating this as "nothing happened"
    // would hide a real, failed run from the operator.
    await waitFor(() => expect(onRunStarted).toHaveBeenCalledWith(RUN_ID));
  });

  it('keeps the modal open and surfaces a runId-less failure', async () => {
    remediateFindingMock.mockRejectedValue(new ActionError('Access denied', 403, undefined, {
      error: 'Access denied',
    }));
    const { onRunStarted, onClose } = renderPicker();
    advanceToConfirm();

    fireEvent.click(screen.getByTestId('fix-picker-confirm'));

    await waitFor(() => expect(handleActionErrorMock).toHaveBeenCalled());
    expect(onRunStarted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByTestId('fix-picker-confirm') as HTMLButtonElement).disabled).toBe(false);
  });
});
