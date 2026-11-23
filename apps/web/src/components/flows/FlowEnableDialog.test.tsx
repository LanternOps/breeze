/**
 * Tool Catalog W4 (#5219) B2 — enable dialog with per-step pre-approval.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ enableFlow: vi.fn() }));
vi.mock('./api', () => api);
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import { ActionError } from '@/lib/runAction';
import { FlowEnableDialog } from './FlowEnableDialog';

function flow(
  triggerType: 'schedule' | 'event' | 'webhook' = 'schedule',
  opts: { ownerScope?: 'organization' | 'partner'; eligibility?: Record<string, unknown> } = {},
) {
  return {
    id: 'f1',
    ownerScope: opts.ownerScope ?? 'organization',
    definitionVersion: 4,
    status: 'draft',
    definition: {
      version: 1,
      name: 'n',
      trigger:
        triggerType === 'event'
          ? { type: 'event', event: 'alert.triggered', filter: {} }
          : triggerType === 'webhook'
            ? { type: 'webhook', auth: 'hmac' }
            : { type: 'schedule', cron: '0 2 * * *', timezone: 'UTC' },
      inputs: [],
      steps: [],
    },
    preApprovalEligibility: opts.eligibility ?? {
      run_a: { eligible: true },
      run_b: { eligible: true },
      wipe: { eligible: false, reason: 'four_eyes' },
      fleet_a: { eligible: true },
      fleet_b: { eligible: true },
    },
    preApprovedStepIds: [],
  } as never;
}

const validation = {
  valid: true,
  effectiveTier: 3,
  issues: [],
  steps: [
    { id: 'read', tool: 'query_devices', source: 'core', tier: 1, approval: 'default' },
    { id: 'run_a', tool: 'run_script', source: 'core', tier: 3, approval: 'default' },
    { id: 'run_b', tool: 'run_script', source: 'core', tier: 3, approval: 'default' },
    { id: 'wipe', tool: 'x', source: 'core', tier: 3, approval: 'default' },
    { id: 'fleet_a', tool: 'run_script_on_targets', source: 'core', tier: 3, approval: 'default' },
    { id: 'fleet_b', tool: 'run_script_on_targets', source: 'core', tier: 3, approval: 'default' },
  ],
} as never;

function setup(f = flow()) {
  const onEnabled = vi.fn();
  const onClose = vi.fn();
  const onStale = vi.fn();
  const view = render(<FlowEnableDialog open flow={f} validation={validation} onClose={onClose} onEnabled={onEnabled} onStale={onStale} />);
  const rerender = (next: ReturnType<typeof flow>) =>
    view.rerender(<FlowEnableDialog open flow={next} validation={validation} onClose={onClose} onEnabled={onEnabled} onStale={onStale} />);
  return { onEnabled, onClose, onStale, rerender };
}

function confirmButton() {
  return screen.getByTestId('flow-enable-confirm') as HTMLButtonElement;
}

function lastEnableBody(): Record<string, unknown> {
  const calls = api.enableFlow.mock.calls;
  return calls[calls.length - 1][1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('FlowEnableDialog', () => {
  it('lists only tier-3 steps', () => {
    setup();
    expect(screen.queryByTestId('flow-enable-step-read')).toBeNull();
    expect(screen.getByTestId('flow-enable-step-run_a')).toBeTruthy();
  });

  it('submits only the eligible steps that were checked', async () => {
    const user = userEvent.setup();
    api.enableFlow.mockResolvedValue({ ok: true });
    const { onEnabled } = setup();
    await user.click(screen.getByTestId('flow-enable-preapprove-run_b'));
    await user.click(screen.getByTestId('flow-enable-confirm'));
    expect(api.enableFlow).toHaveBeenCalledWith('f1', { expectedVersion: 4, preApprovedStepIds: ['run_b'] });
    expect(onEnabled).toHaveBeenCalled();
  });

  it('shows a disabled checkbox with the localized reason for a four-eyes step', () => {
    setup();
    const box = screen.getByTestId('flow-enable-preapprove-wipe') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(screen.getByTestId('flow-enable-notEligible-wipe').textContent).toMatch(/second person/i);
  });

  it('renders a 422 permission_missing list inline and stays open', async () => {
    const user = userEvent.setup();
    api.enableFlow.mockRejectedValue(
      new ActionError('x', 422, undefined, {
        error: 'permission_missing',
        missing: [{ stepId: 'run_a', permission: 'scripts.execute' }],
      }),
    );
    const { onEnabled } = setup();
    await user.click(screen.getByTestId('flow-enable-confirm'));
    const list = await screen.findByTestId('flow-enable-missing');
    expect(within(list).getByText(/scripts\.execute/)).toBeTruthy();
    expect(onEnabled).not.toHaveBeenCalled();
  });

  it('renders validation issues and version_conflict', async () => {
    const user = userEvent.setup();
    api.enableFlow.mockRejectedValueOnce(
      new ActionError('x', 422, undefined, {
        error: 'invalid',
        validation: { valid: false, issues: [{ code: 'tool_not_found', severity: 'error', message: 'ghost missing' }] },
      }),
    );
    setup();
    await user.click(screen.getByTestId('flow-enable-confirm'));
    expect((await screen.findByTestId('flow-enable-validation')).textContent).toContain('ghost missing');

    api.enableFlow.mockRejectedValueOnce(new ActionError('x', 409, 'version_conflict', { error: 'version_conflict' }));
    await user.click(screen.getByTestId('flow-enable-confirm'));
    expect(await screen.findByTestId('flow-enable-error-version_conflict')).toBeTruthy();
  });

  it('shows the event scope notice only for event flows', () => {
    setup(flow('event'));
    expect(screen.getByTestId('flow-enable-event-scope')).toBeTruthy();
  });

  it('renders the standard MFA-required message for a 403 MFA_REQUIRED', async () => {
    const user = userEvent.setup();
    api.enableFlow.mockRejectedValueOnce(
      new ActionError('Multi-factor authentication is required', 403, 'MFA_REQUIRED', { error: 'MFA required', code: 'MFA_REQUIRED' }),
    );
    setup();
    await user.click(screen.getByTestId('flow-enable-confirm'));
    const el = await screen.findByTestId('flow-enable-error-MFA_REQUIRED');
    expect(el.textContent).toBe('Multi-factor authentication is required');
  });

  it('renders a localized message for flow_not_found', async () => {
    const user = userEvent.setup();
    api.enableFlow.mockRejectedValueOnce(new ActionError('x', 404, undefined, { error: 'flow_not_found' }));
    setup();
    await user.click(screen.getByTestId('flow-enable-confirm'));
    expect((await screen.findByTestId('flow-enable-error-flow_not_found')).textContent).toContain('not found');
  });

  it.each([
    [409, 'version_conflict', /changed since you opened/i],
    [409, 'already_enabled', /already enabled/i],
    [422, 'event_dispatch_not_durable', /not durable/i],
    [422, 'foreach_concurrency_not_available', /in parallel/i],
    [403, 'delegation_scope_restricted', /limited to some sites/i],
    [403, 'partner_wide_forbidden', /all organizations/i],
    [403, 'interactive_session_required', /signed-in browser session/i],
    [409, 'slug_unavailable', /already uses this identifier/i],
    [422, 'webhook_secret_missing', /webhook secret/i],
    [422, 'ai_budget_unavailable', /AI budget/i],
  ])('renders %s %s as localized text, never the raw code', async (status, code, pattern) => {
    const user = userEvent.setup();
    api.enableFlow.mockRejectedValueOnce(new ActionError('x', status, undefined, { error: code }));
    setup();
    await user.click(screen.getByTestId('flow-enable-confirm'));
    const el = await screen.findByTestId(`flow-enable-error-${code}`);
    expect(el.textContent).toMatch(pattern);
    expect(el.textContent).not.toContain(code);
  });

  it('pre_approval_not_eligible names the step and the localized reason', async () => {
    const user = userEvent.setup();
    api.enableFlow.mockRejectedValueOnce(
      new ActionError('x', 422, undefined, { error: 'pre_approval_not_eligible', stepId: 'wipe', reason: 'four_eyes' }),
    );
    setup();
    await user.click(screen.getByTestId('flow-enable-confirm'));
    const el = await screen.findByTestId('flow-enable-error-pre_approval_not_eligible');
    expect(el.textContent).toContain('wipe');
    expect(el.textContent).toMatch(/second person/i);
    expect(el.textContent).not.toContain('four_eyes');
  });

  it('an unknown error code falls back to the generic message without the raw code', async () => {
    const user = userEvent.setup();
    api.enableFlow.mockRejectedValueOnce(new ActionError('x', 500, undefined, { error: 'mystery_code' }));
    setup();
    await user.click(screen.getByTestId('flow-enable-confirm'));
    const el = await screen.findByTestId('flow-enable-error-generic');
    expect(el.textContent).toBe('Could not enable the flow.');
    expect(screen.getByTestId('flow-enable-error').textContent).not.toContain('mystery_code');
  });

  it('permission_missing lists both the step id and the permission', async () => {
    const user = userEvent.setup();
    api.enableFlow.mockRejectedValue(
      new ActionError('x', 422, undefined, {
        error: 'permission_missing',
        missing: [{ stepId: 'run_a', permission: 'scripts.execute' }, { stepId: 'run_b', permission: 'devices.write' }],
      }),
    );
    setup();
    await user.click(screen.getByTestId('flow-enable-confirm'));
    const list = await screen.findByTestId('flow-enable-missing');
    for (const text of ['run_a', 'scripts.execute', 'run_b', 'devices.write']) {
      expect(within(list).getByText(text)).toBeTruthy();
    }
  });

  it('a 409 asks the caller to reload the flow; a 422 does not', async () => {
    const user = userEvent.setup();
    api.enableFlow.mockRejectedValueOnce(new ActionError('x', 422, undefined, { error: 'invalid', validation: { issues: [] } }));
    const { onStale } = setup();
    await user.click(screen.getByTestId('flow-enable-confirm'));
    await screen.findByTestId('flow-enable-validation');
    expect(onStale).not.toHaveBeenCalled();
    api.enableFlow.mockRejectedValueOnce(new ActionError('x', 409, 'version_conflict', { error: 'version_conflict' }));
    await user.click(screen.getByTestId('flow-enable-confirm'));
    await screen.findByTestId('flow-enable-error-version_conflict');
    expect(onStale).toHaveBeenCalledTimes(1);
  });
  describe('fleet pre-approval (W01c)', () => {
    it('pre-approving a fleet step requires maxTargets 1–500', async () => {
      const user = userEvent.setup();
      api.enableFlow.mockResolvedValue({ ok: true });
      setup();
      // Unticked: no field, Confirm active.
      expect(screen.queryByTestId('flow-enable-maxtargets-fleet_a')).toBeNull();
      expect(confirmButton().disabled).toBe(false);

      await user.click(screen.getByTestId('flow-enable-preapprove-fleet_a'));
      const input = screen.getByTestId('flow-enable-maxtargets-fleet_a') as HTMLInputElement;
      expect(confirmButton().disabled).toBe(true);
      expect(screen.getByTestId('flow-enable-maxtargets-invalid-fleet_a')).toBeTruthy();

      for (const bad of ['0', '501', '2.5']) {
        await user.clear(input);
        await user.type(input, bad);
        expect(confirmButton().disabled).toBe(true);
      }
      // A disabled Confirm sends nothing.
      await user.click(confirmButton());
      expect(api.enableFlow).not.toHaveBeenCalled();

      for (const good of ['1', '500']) {
        await user.clear(input);
        await user.type(input, good);
        expect(confirmButton().disabled).toBe(false);
      }
    });

    it('enable sends fleetMaxTargets for ticked fleet steps only', async () => {
      const user = userEvent.setup();
      api.enableFlow.mockResolvedValue({ ok: true });
      setup();
      await user.click(screen.getByTestId('flow-enable-preapprove-run_b'));
      await user.click(screen.getByTestId('flow-enable-preapprove-fleet_a'));
      await user.type(screen.getByTestId('flow-enable-maxtargets-fleet_a'), '25');
      // fleet_b: ticked, given a value, then unticked — it must not be sent.
      await user.click(screen.getByTestId('flow-enable-preapprove-fleet_b'));
      await user.type(screen.getByTestId('flow-enable-maxtargets-fleet_b'), '7');
      await user.click(screen.getByTestId('flow-enable-preapprove-fleet_b'));
      expect(screen.queryByTestId('flow-enable-maxtargets-fleet_b')).toBeNull();

      await user.click(confirmButton());
      expect(api.enableFlow).toHaveBeenCalledTimes(1);
      expect(api.enableFlow).toHaveBeenCalledWith('f1', {
        expectedVersion: 4,
        preApprovedStepIds: ['run_b', 'fleet_a'],
        fleetMaxTargets: { fleet_a: 25 },
      });
    });

    it('each ticked fleet step needs its own valid value and is sent with it', async () => {
      const user = userEvent.setup();
      api.enableFlow.mockResolvedValue({ ok: true });
      setup();
      await user.click(screen.getByTestId('flow-enable-preapprove-fleet_a'));
      await user.type(screen.getByTestId('flow-enable-maxtargets-fleet_a'), '25');
      await user.click(screen.getByTestId('flow-enable-preapprove-fleet_b'));
      // fleet_a is valid, fleet_b is blank: Confirm stays disabled.
      expect(confirmButton().disabled).toBe(true);
      const b = screen.getByTestId('flow-enable-maxtargets-fleet_b');
      await user.type(b, '0');
      expect(confirmButton().disabled).toBe(true);
      await user.clear(b);
      await user.type(b, '40');
      expect(confirmButton().disabled).toBe(false);
      await user.click(confirmButton());
      expect(api.enableFlow).toHaveBeenCalledWith('f1', {
        expectedVersion: 4,
        preApprovedStepIds: ['fleet_a', 'fleet_b'],
        fleetMaxTargets: { fleet_a: 25, fleet_b: 40 },
      });
    });

    it('a flow that reloads as webhook-triggered drops earlier ticks', async () => {
      const user = userEvent.setup();
      api.enableFlow.mockResolvedValue({ ok: true });
      const { rerender } = setup();
      await user.click(screen.getByTestId('flow-enable-preapprove-run_a'));
      await user.click(screen.getByTestId('flow-enable-preapprove-fleet_a'));
      await user.type(screen.getByTestId('flow-enable-maxtargets-fleet_a'), '25');
      rerender(flow('webhook'));
      expect(screen.getByTestId('flow-enable-webhook-no-preapproval')).toBeTruthy();
      expect(confirmButton().disabled).toBe(false);
      await user.click(confirmButton());
      expect(api.enableFlow).toHaveBeenCalledWith('f1', { expectedVersion: 4, preApprovedStepIds: [] });
      expect('fleetMaxTargets' in lastEnableBody()).toBe(false);
    });

    it('a non-fleet tier-3 step needs no maxTargets', async () => {
      const user = userEvent.setup();
      api.enableFlow.mockResolvedValue({ ok: true });
      setup();
      await user.click(screen.getByTestId('flow-enable-preapprove-run_a'));
      expect(screen.queryByTestId('flow-enable-maxtargets-run_a')).toBeNull();
      expect(confirmButton().disabled).toBe(false);
      await user.click(confirmButton());
      const body = lastEnableBody();
      expect(body.preApprovedStepIds).toEqual(['run_a']);
      expect('fleetMaxTargets' in body).toBe(false);
    });

    it('a fleet step that is not eligible offers no field and does not block Confirm', async () => {
      const user = userEvent.setup();
      api.enableFlow.mockResolvedValue({ ok: true });
      const eligibleAll = { run_a: { eligible: true }, fleet_a: { eligible: true } };
      const { rerender } = setup(flow('schedule', { eligibility: eligibleAll }));
      await user.click(screen.getByTestId('flow-enable-preapprove-fleet_a'));
      expect(confirmButton().disabled).toBe(true);
      // The flow reloads and the step is no longer eligible: the stale tick no
      // longer gates Confirm and is never sent.
      rerender(flow('schedule', { eligibility: { run_a: { eligible: true }, fleet_a: { eligible: false, reason: 'run_as_elevated' } } }));
      expect((screen.getByTestId('flow-enable-preapprove-fleet_a') as HTMLInputElement).disabled).toBe(true);
      expect(screen.queryByTestId('flow-enable-maxtargets-fleet_a')).toBeNull();
      expect(confirmButton().disabled).toBe(false);
      await user.click(confirmButton());
      const body = lastEnableBody();
      expect(body.preApprovedStepIds).toEqual([]);
      expect('fleetMaxTargets' in body).toBe(false);
    });

    it('shows the per-org copy only for a partner-wide flow', async () => {
      const user = userEvent.setup();
      setup(flow('schedule', { ownerScope: 'partner' }));
      await user.click(screen.getByTestId('flow-enable-preapprove-fleet_a'));
      expect(screen.getByTestId('flow-enable-perorg-fleet_a')).toBeTruthy();
    });

    it('an org flow shows no per-org copy', async () => {
      const user = userEvent.setup();
      setup();
      await user.click(screen.getByTestId('flow-enable-preapprove-fleet_a'));
      expect(screen.queryByTestId('flow-enable-perorg-fleet_a')).toBeNull();
    });

    it('a webhook flow offers no pre-approval', async () => {
      const user = userEvent.setup();
      api.enableFlow.mockResolvedValue({ ok: true });
      setup(flow('webhook'));
      expect(screen.getByTestId('flow-enable-webhook-no-preapproval').textContent).toMatch(/always wait for approval/i);
      // The steps that will ask are still listed, but none can be ticked.
      expect(screen.getByTestId('flow-enable-step-fleet_a')).toBeTruthy();
      for (const id of ['run_a', 'run_b', 'wipe', 'fleet_a', 'fleet_b']) {
        expect(screen.queryByTestId(`flow-enable-preapprove-${id}`)).toBeNull();
      }
      expect(screen.queryByTestId('flow-enable-maxtargets-fleet_a')).toBeNull();
      await user.click(confirmButton());
      expect(api.enableFlow).toHaveBeenCalledWith('f1', { expectedVersion: 4, preApprovedStepIds: [] });
      expect('fleetMaxTargets' in lastEnableBody()).toBe(false);
    });

    it('a schedule flow shows no webhook notice', () => {
      setup();
      expect(screen.queryByTestId('flow-enable-webhook-no-preapproval')).toBeNull();
    });
  });
});
