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
  render(<FlowEnableDialog open flow={f} validation={validation} onClose={onClose} onEnabled={onEnabled} />);
  return { onEnabled, onClose };
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
});
