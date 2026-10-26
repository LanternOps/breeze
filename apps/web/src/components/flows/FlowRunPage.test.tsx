/** Tool Catalog W4 (#5219) B3 — run timeline page. */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ getFlowRun: vi.fn(), getFlowRunStep: vi.fn(), cancelFlowRun: vi.fn() }));
vi.mock('./api', () => api);
const gate = vi.hoisted(() => ({ value: { enabled: true, loaded: true } }));
vi.mock('../../stores/featuresStore', () => ({ useFlowsGate: () => gate.value }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (sel?: (s: unknown) => unknown) => {
    const st = { organizations: [{ id: 'org-1', name: 'Acme Corp' }], currentOrgId: null };
    return sel ? sel(st) : st;
  },
}));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const perms = vi.hoisted(() => ({ write: true }));
vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: (r: string, a: string) => r === 'automations' && a === 'write' && perms.write }),
}));

import { ActionError } from '@/lib/runAction';
import FlowRunPage from './FlowRunPage';

const step = (over: Record<string, unknown>) => ({
  id: 'row', stepId: 'list', itemIndex: null, attempt: 1, tool: 'query_devices', toolSource: 'core', tier: 1,
  status: 'completed', outputTruncated: false, bodiesPruned: false, errorCode: null, error: null,
  startedAt: '2026-10-20T02:00:00.000Z', finishedAt: '2026-10-20T02:00:02.000Z', durationMs: 2000,
  approvalMode: 'none', actionIntentId: null, approvedByUserId: null, aiUsage: null, ...over,
});

function runDetail(over: Record<string, unknown> = {}) {
  return {
    id: 'run-1', flowId: 'f1', flowName: 'Nightly offline report', orgId: 'org-1', definitionVersion: 3,
    triggerKind: 'manual', triggeredVia: 'ui', status: 'running', errorCode: null, currentStepId: 'each',
    createdAt: '2026-10-20T02:00:00.000Z', startedAt: '2026-10-20T02:00:00.000Z', finishedAt: null,
    triggerPayload: null, inputs: {}, error: null, preApprovalsHonored: false, chainDepth: 0, publicationSeq: 4,
    wakeAt: null, bodiesPrunedAt: null, aiTokensUsed: 0, parentAgentRunId: null,
    definition: {
      version: 1, name: 'Nightly offline report', trigger: { type: 'manual' }, inputs: [],
      steps: [
        { id: 'list', tool: 'query_devices', input: {}, approval: 'default', onFailure: 'stop', timeoutSec: 60 },
        { id: 'each', tool: 'manage_tags', input: {}, forEach: { items: 'steps.list.items', as: 'item', maxItems: 100, concurrency: 1 }, approval: 'default', onFailure: 'stop', timeoutSec: 60 },
        { id: 'final', tool: 'manage_tickets', input: {}, approval: 'default', onFailure: 'stop', timeoutSec: 60 },
      ],
    },
    steps: [
      step({ id: 'row-list', stepId: 'list' }),
      step({ id: 'row-i0', stepId: 'each', itemIndex: 0 }),
      step({ id: 'row-i1', stepId: 'each', itemIndex: 1 }),
      step({ id: 'row-i2', stepId: 'each', itemIndex: 2, status: 'running', finishedAt: null, durationMs: null }),
    ],
    ...over,
  };
}

describe('FlowRunPage', () => {
  beforeEach(() => {
    api.getFlowRun.mockReset();
    api.getFlowRunStep.mockReset();
    api.cancelFlowRun.mockReset();
    perms.write = true;
    api.getFlowRun.mockResolvedValue(runDetail());
  });

  it('header links the flow and shows status, version and org', async () => {
    render(<FlowRunPage runId="run-1" />);
    const link = await screen.findByTestId('flow-run-flow-link');
    expect(link.getAttribute('href')).toBe('/flows/f1');
    expect(link.textContent).toBe('Nightly offline report');
    expect(screen.getByTestId('flow-run-status').textContent).toBe('Running');
    expect(screen.getByTestId('flow-run-org').textContent).toContain('Acme Corp');
  });

  it('timeline greys an unreached step and nests three for-each items', async () => {
    render(<FlowRunPage runId="run-1" />);
    const unreached = await screen.findByTestId('flow-run-step-final');
    expect(unreached.getAttribute('data-reached')).toBe('false');
    expect(screen.getByTestId('flow-run-step-list').getAttribute('data-reached')).toBe('true');
    const group = screen.getByTestId('flow-run-step-each');
    expect(group.querySelectorAll('[data-testid^="flow-run-item-"]').length).toBe(3);
  });

  it('awaiting-approval banner links to /approvals', async () => {
    api.getFlowRun.mockResolvedValue(runDetail({ status: 'awaiting_approval' }));
    render(<FlowRunPage runId="run-1" />);
    const link = await screen.findByTestId('flow-run-approvals-link');
    expect(link.getAttribute('href')).toBe('/approvals');
  });

  it('waiting shows the wake time; queued says Queued; unknown_outcome explains', async () => {
    api.getFlowRun.mockResolvedValue(runDetail({ status: 'waiting', wakeAt: '2026-10-20T03:00:00.000Z' }));
    const { unmount } = render(<FlowRunPage runId="run-1" />);
    expect((await screen.findByTestId('flow-run-wake')).textContent).toMatch(/Waiting until/);
    unmount();
    api.getFlowRun.mockResolvedValue(runDetail({ status: 'queued', steps: [] }));
    const second = render(<FlowRunPage runId="run-1" />);
    expect((await screen.findByTestId('flow-run-queued')).textContent).toMatch(/Queued/);
    second.unmount();
    api.getFlowRun.mockResolvedValue(runDetail({
      status: 'failed', errorCode: 'unknown_outcome', finishedAt: '2026-10-20T02:05:00.000Z',
      steps: [step({ id: 'row-list', stepId: 'list', status: 'unknown_outcome', errorCode: 'unknown_outcome' })],
    }));
    render(<FlowRunPage runId="run-1" />);
    expect((await screen.findByTestId('flow-run-unknown-outcome')).textContent).toMatch(/may have run/);
  });

  it('Cancel calls cancelFlowRun then refetches', async () => {
    api.cancelFlowRun.mockResolvedValue({ status: 'cancelled' });
    render(<FlowRunPage runId="run-1" />);
    const btn = await screen.findByTestId('flow-run-cancel');
    expect(api.getFlowRun).toHaveBeenCalledTimes(1);
    await userEvent.setup().click(btn);
    expect(api.cancelFlowRun).toHaveBeenCalledWith('run-1');
    await waitFor(() => expect(api.getFlowRun).toHaveBeenCalledTimes(2));
  });

  it('no Cancel for a terminal run', async () => {
    api.getFlowRun.mockResolvedValue(runDetail({ status: 'completed', finishedAt: '2026-10-20T02:05:00.000Z' }));
    render(<FlowRunPage runId="run-1" />);
    await screen.findByTestId('flow-run-status');
    expect(screen.queryByTestId('flow-run-cancel')).toBeNull();
  });

  it('expanding a step fetches its body once', async () => {
    api.getFlowRunStep.mockResolvedValue(step({ id: 'row-list', renderedInput: { a: 1 }, output: { count: 7 }, outputTruncated: true }));
    render(<FlowRunPage runId="run-1" />);
    const toggle = await screen.findByTestId('flow-run-step-toggle-row-list');
    const user = userEvent.setup();
    await user.click(toggle);
    const body = await screen.findByTestId('flow-run-step-body-row-list');
    expect(body.textContent).toContain('"count": 7');
    expect(screen.getByTestId('flow-run-step-truncated-row-list')).toBeTruthy();
    await user.click(toggle); // collapse
    await user.click(toggle); // re-expand
    expect(api.getFlowRunStep).toHaveBeenCalledTimes(1);
    expect(api.getFlowRunStep).toHaveBeenCalledWith('run-1', 'row-list');
  });

  it('says details are not available (not "retention") when a reader\'s view is redacted', async () => {
    api.getFlowRun.mockResolvedValue(
      runDetail({ inputs: null, triggerPayload: null, bodiesPrunedAt: null, steps: [step({ id: 'row-list', stepId: 'list', bodiesPruned: true })] }),
    );
    render(<FlowRunPage runId="run-1" />);
    await userEvent.setup().click(await screen.findByTestId('flow-run-step-toggle-row-list'));
    const note = await screen.findByTestId('flow-run-step-pruned-row-list');
    expect(note.textContent).toBe("Step details aren't available with your access.");
    expect(note.textContent).not.toMatch(/retention/i);
    expect(api.getFlowRunStep).not.toHaveBeenCalled();
  });

  it('says retention removed the details when the run has bodiesPrunedAt', async () => {
    api.getFlowRun.mockResolvedValue(
      runDetail({ bodiesPrunedAt: '2026-10-21T00:00:00.000Z', steps: [step({ id: 'row-list', stepId: 'list', bodiesPruned: true })] }),
    );
    render(<FlowRunPage runId="run-1" />);
    await userEvent.setup().click(await screen.findByTestId('flow-run-step-toggle-row-list'));
    expect((await screen.findByTestId('flow-run-step-pruned-row-list')).textContent).toMatch(/retention/i);
  });

  it('hides Cancel without automations.write', async () => {
    perms.write = false;
    render(<FlowRunPage runId="run-1" />);
    await screen.findByTestId('flow-run-status');
    expect(screen.queryByTestId('flow-run-cancel')).toBeNull();
  });

  it('a 409 already_terminal on cancel refetches the run', async () => {
    api.cancelFlowRun.mockRejectedValue(new ActionError('x', 409, undefined, { error: 'already_terminal' }));
    render(<FlowRunPage runId="run-1" />);
    const btn = await screen.findByTestId('flow-run-cancel');
    expect(api.getFlowRun).toHaveBeenCalledTimes(1);
    await userEvent.setup().click(btn);
    await waitFor(() => expect(api.getFlowRun).toHaveBeenCalledTimes(2));
  });

  it('shows the not-found state when the run 404s', async () => {
    api.getFlowRun.mockRejectedValue(new ActionError('missing', 404));
    render(<FlowRunPage runId="run-1" />);
    expect(await screen.findByTestId('flow-run-not-found')).toBeTruthy();
    expect(screen.queryByTestId('flow-run-error')).toBeNull();
  });

  it('an unreached step in an active run reads Pending', async () => {
    render(<FlowRunPage runId="run-1" />);
    expect((await screen.findByTestId('flow-run-step-final')).textContent).toContain('Pending');
  });
});
