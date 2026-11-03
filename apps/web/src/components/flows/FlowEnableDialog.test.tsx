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

function flow(triggerType: 'schedule' | 'event' = 'schedule') {
  return {
    id: 'f1',
    definitionVersion: 4,
    status: 'draft',
    definition: {
      version: 1,
      name: 'n',
      trigger:
        triggerType === 'event'
          ? { type: 'event', event: 'alert.triggered', filter: {} }
          : { type: 'schedule', cron: '0 2 * * *', timezone: 'UTC' },
      inputs: [],
      steps: [],
    },
    preApprovalEligibility: {
      run_a: { eligible: true },
      run_b: { eligible: true },
      wipe: { eligible: false, reason: 'four_eyes' },
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
  ],
} as never;

function setup(f = flow()) {
  const onEnabled = vi.fn();
  const onClose = vi.fn();
  const onStale = vi.fn();
  render(<FlowEnableDialog open flow={f} validation={validation} onClose={onClose} onEnabled={onEnabled} onStale={onStale} />);
  return { onEnabled, onClose, onStale };
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
});
