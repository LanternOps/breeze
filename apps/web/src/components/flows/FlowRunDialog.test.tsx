/**
 * Tool Catalog W4 (#5219) B2 — manual run dialog.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ startFlowRun: vi.fn() }));
vi.mock('./api', () => api);
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('../shared/Toast', () => toast);
const nav = vi.hoisted(() => ({ navigateTo: vi.fn() }));
vi.mock('@/lib/navigation', () => nav);
const orgState = vi.hoisted(() => ({
  value: {
    currentOrgId: null as string | null,
    organizations: [
      { id: '11111111-1111-4111-8111-111111111111', name: 'Acme', status: 'active' },
      { id: '22222222-2222-4222-8222-222222222222', name: 'Beta', status: 'active' },
      { id: '33333333-3333-4333-8333-333333333333', name: 'Gone', status: 'suspended' },
    ],
  },
}));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (sel?: (s: unknown) => unknown) => (sel ? sel(orgState.value) : orgState.value),
}));

import { ActionError } from '@/lib/runAction';
import { FlowRunDialog } from './FlowRunDialog';

const NO_INPUTS = { version: 1, name: 'n', trigger: { type: 'manual' }, inputs: [], steps: [] };

function flow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'f1',
    ownerScope: 'organization',
    orgId: 'org-1',
    definition: {
      version: 1,
      name: 'n',
      trigger: { type: 'manual' },
      inputs: [
        { name: 'hostname', type: 'string', required: true },
        { name: 'days', type: 'number', required: false },
      ],
      steps: [],
    },
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  orgState.value.currentOrgId = null;
});

describe('FlowRunDialog', () => {
  it('validates a required input before submitting', async () => {
    const user = userEvent.setup();
    render(<FlowRunDialog open flow={flow()} onClose={vi.fn()} />);
    await user.click(screen.getByTestId('flow-run-submit'));
    expect(screen.getByTestId('flow-run-error-hostname')).toBeTruthy();
    expect(api.startFlowRun).not.toHaveBeenCalled();
  });

  it('submits coerced inputs and navigates to the run page', async () => {
    const user = userEvent.setup();
    api.startFlowRun.mockResolvedValue({ runId: 'r1', duplicate: false });
    render(<FlowRunDialog open flow={flow()} onClose={vi.fn()} />);
    await user.type(screen.getByTestId('flow-run-input-hostname'), 'srv1');
    await user.type(screen.getByTestId('flow-run-input-days'), '7');
    await user.click(screen.getByTestId('flow-run-submit'));
    expect(api.startFlowRun).toHaveBeenCalledWith('f1', { inputs: { hostname: 'srv1', days: 7 } });
    expect(nav.navigateTo).toHaveBeenCalledWith('/flows/runs/r1');
  });

  it('requires an organization for a partner-wide flow', async () => {
    const user = userEvent.setup();
    api.startFlowRun.mockResolvedValue({ runId: 'r2', duplicate: false });
    render(<FlowRunDialog open flow={flow({ ownerScope: 'partner', orgId: null, definition: NO_INPUTS })} onClose={vi.fn()} />);
    await user.click(screen.getByTestId('flow-run-submit'));
    expect(screen.getByTestId('flow-run-error-org')).toBeTruthy();
    expect(api.startFlowRun).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByTestId('flow-run-org'), '22222222-2222-4222-8222-222222222222');
    await user.click(screen.getByTestId('flow-run-submit'));
    expect(api.startFlowRun).toHaveBeenCalledWith('f1', { orgId: '22222222-2222-4222-8222-222222222222', inputs: {} });
  });

  it('renders queue-full and inputs_invalid inline', async () => {
    const user = userEvent.setup();
    api.startFlowRun.mockRejectedValueOnce(new ActionError('x', 429, 'flow_queue_full', { error: 'flow_queue_full' }));
    render(<FlowRunDialog open flow={flow({ definition: NO_INPUTS })} onClose={vi.fn()} />);
    await user.click(screen.getByTestId('flow-run-submit'));
    expect(await screen.findByTestId('flow-run-queue-full')).toBeTruthy();
    api.startFlowRun.mockRejectedValueOnce(
      new ActionError('x', 422, undefined, { error: 'inputs_invalid', issues: [{ name: 'days', message: 'bad days' }] }),
    );
    await user.click(screen.getByTestId('flow-run-submit'));
    expect((await screen.findByTestId('flow-run-inputs-invalid')).textContent).toContain('bad days');
  });

  it.each([
    [403, 'delegation_scope_restricted', 'delegation_scope_restricted', 'sites'],
    [403, 'interactive_user_required', 'interactive_user_required', 'signed-in'],
    [403, 'org_forbidden', 'org_forbidden', 'organization'],
    [422, 'org_required', 'org_required', 'Choose the organization'],
    [409, 'not_manual', 'not_manual', 'manually'],
    [404, 'flow_not_found', 'flow_not_found', 'not found'],
  ])('renders %s %s inline as a localized message', async (status, errorCode, suffix, fragment) => {
    const user = userEvent.setup();
    api.startFlowRun.mockRejectedValueOnce(new ActionError('x', status as number, undefined, { error: errorCode }));
    render(<FlowRunDialog open flow={flow({ definition: NO_INPUTS })} onClose={vi.fn()} />);
    await user.click(screen.getByTestId('flow-run-submit'));
    const el = await screen.findByTestId(`flow-run-error-code-${suffix}`);
    expect(el.textContent?.toLowerCase()).toContain((fragment as string).toLowerCase());
    expect(el.textContent).not.toContain(errorCode as string);
  });

  it('renders the standard MFA-required message for a 403 MFA_REQUIRED', async () => {
    const user = userEvent.setup();
    api.startFlowRun.mockRejectedValueOnce(
      new ActionError('Multi-factor authentication is required', 403, 'MFA_REQUIRED', { error: 'MFA required', code: 'MFA_REQUIRED' }),
    );
    render(<FlowRunDialog open flow={flow({ definition: NO_INPUTS })} onClose={vi.fn()} />);
    await user.click(screen.getByTestId('flow-run-submit'));
    const el = await screen.findByTestId('flow-run-error-code-MFA_REQUIRED');
    expect(el.textContent).toBe('Multi-factor authentication is required');
  });

  it('clears a previous code error on the next attempt', async () => {
    const user = userEvent.setup();
    api.startFlowRun.mockRejectedValueOnce(new ActionError('x', 403, undefined, { error: 'org_forbidden' }));
    api.startFlowRun.mockResolvedValueOnce({ runId: 'r9', duplicate: false });
    render(<FlowRunDialog open flow={flow({ definition: NO_INPUTS })} onClose={vi.fn()} />);
    await user.click(screen.getByTestId('flow-run-submit'));
    await screen.findByTestId('flow-run-error-code-org_forbidden');
    await user.click(screen.getByTestId('flow-run-submit'));
    expect(screen.queryByTestId('flow-run-error-code-org_forbidden')).toBeNull();
  });

  it('does not preselect a current org that is not selectable (a hidden org cannot be submitted)', async () => {
    const user = userEvent.setup();
    orgState.value.currentOrgId = '33333333-3333-4333-8333-333333333333';
    render(<FlowRunDialog open flow={flow({ ownerScope: 'partner', orgId: null, definition: NO_INPUTS })} onClose={vi.fn()} />);
    expect((screen.getByTestId('flow-run-org') as HTMLSelectElement).value).toBe('');
    await user.click(screen.getByTestId('flow-run-submit'));
    expect(screen.getByTestId('flow-run-error-org')).toBeTruthy();
    expect(api.startFlowRun).not.toHaveBeenCalled();
  });

  it('preselects the current org when it is selectable', async () => {
    const user = userEvent.setup();
    orgState.value.currentOrgId = '22222222-2222-4222-8222-222222222222';
    api.startFlowRun.mockResolvedValue({ runId: 'r3', duplicate: false });
    render(<FlowRunDialog open flow={flow({ ownerScope: 'partner', orgId: null, definition: NO_INPUTS })} onClose={vi.fn()} />);
    await user.click(screen.getByTestId('flow-run-submit'));
    expect(api.startFlowRun).toHaveBeenCalledWith('f1', { orgId: '22222222-2222-4222-8222-222222222222', inputs: {} });
  });

  it.each([
    ['permissions shape', { error: 'permission_missing', permissions: ['scripts.execute', 'devices.write'] }, ['scripts.execute', 'devices.write']],
    ['missing shape', { error: 'permission_missing', missing: [{ permission: 'alerts.write' }, 'tickets.write'] }, ['alerts.write', 'tickets.write']],
  ])('renders permission_missing (%s) inline', async (_n, body, expected) => {
    const user = userEvent.setup();
    api.startFlowRun.mockRejectedValueOnce(new ActionError('x', 403, undefined, body));
    render(<FlowRunDialog open flow={flow({ definition: NO_INPUTS })} onClose={vi.fn()} />);
    await user.click(screen.getByTestId('flow-run-submit'));
    const el = await screen.findByTestId('flow-run-permission-missing');
    for (const perm of expected as string[]) expect(el.textContent).toContain(perm);
  });

  it('renders not_enabled inline and stays open', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    api.startFlowRun.mockRejectedValueOnce(new ActionError('x', 409, undefined, { error: 'not_enabled' }));
    render(<FlowRunDialog open flow={flow({ definition: NO_INPUTS })} onClose={onClose} />);
    await user.click(screen.getByTestId('flow-run-submit'));
    expect((await screen.findByTestId('flow-run-not-enabled')).textContent).toMatch(/not enabled/i);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('an unknown error code shows no raw token inline and keeps the dialog open', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    api.startFlowRun.mockRejectedValueOnce(new ActionError('x', 500, undefined, { error: 'totally_unknown' }));
    render(<FlowRunDialog open flow={flow({ definition: NO_INPUTS })} onClose={onClose} />);
    await user.click(screen.getByTestId('flow-run-submit'));
    await vi.waitFor(() => expect((screen.getByTestId('flow-run-submit') as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText(/totally_unknown/)).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(nav.navigateTo).not.toHaveBeenCalled();
  });

  it('a non-ActionError failure toasts errors.runFailed and the dialog stays open', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    api.startFlowRun.mockRejectedValueOnce(new Error('network down'));
    render(<FlowRunDialog open flow={flow({ definition: NO_INPUTS })} onClose={onClose} />);
    await user.click(screen.getByTestId('flow-run-submit'));
    await vi.waitFor(() => expect(toast.showToast).toHaveBeenCalledWith({ type: 'error', message: 'Could not start the run.' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('flow-run-dialog')).toBeTruthy();
  });

  it('double-submit guard: two clicks while pending make one call and the button is disabled', async () => {
    const user = userEvent.setup();
    let resolve: (v: unknown) => void = () => {};
    api.startFlowRun.mockImplementation(() => new Promise((r) => { resolve = r; }));
    render(<FlowRunDialog open flow={flow({ definition: NO_INPUTS })} onClose={vi.fn()} />);
    const btn = screen.getByTestId('flow-run-submit') as HTMLButtonElement;
    await user.click(btn);
    await user.click(btn);
    expect(api.startFlowRun).toHaveBeenCalledTimes(1);
    expect(btn.disabled).toBe(true);
    resolve({ runId: 'r5', duplicate: false });
    await vi.waitFor(() => expect(nav.navigateTo).toHaveBeenCalledWith('/flows/runs/r5'));
  });
});
