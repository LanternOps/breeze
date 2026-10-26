/** Tool Catalog W4 (#5219) review fixes — run timeline body cache + pending state. */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ getFlowRunStep: vi.fn() }));
vi.mock('./api', () => api);
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import { FlowRunTimeline } from './FlowRunTimeline';

const definition = {
  version: 1, name: 'n', trigger: { type: 'manual' }, inputs: [],
  steps: [
    { id: 'list', tool: 'query_devices', input: {}, approval: 'default', onFailure: 'stop', timeoutSec: 60 },
    { id: 'final', tool: 'manage_tickets', input: {}, approval: 'default', onFailure: 'stop', timeoutSec: 60 },
  ],
} as never;

const row = (over: Record<string, unknown> = {}) => ({
  id: 'row-list', stepId: 'list', itemIndex: null, attempt: 1, tool: 'query_devices', toolSource: 'core', tier: 1,
  status: 'running', outputTruncated: false, bodiesPruned: false, errorCode: null, error: null,
  startedAt: '2026-10-20T02:00:00.000Z', finishedAt: null, durationMs: null,
  approvalMode: 'none', actionIntentId: null, approvedByUserId: null, aiUsage: null, ...over,
}) as never;

const body = (output: unknown) => ({ ...(row() as object), renderedInput: {}, output });

beforeEach(() => {
  api.getFlowRunStep.mockReset();
});

describe('FlowRunTimeline', () => {
  it('re-fetches an expanded step body when its status changes', async () => {
    api.getFlowRunStep.mockResolvedValueOnce(body(null)).mockResolvedValueOnce(body({ count: 7 }));
    const { rerender } = render(<FlowRunTimeline runId="r1" definition={definition} steps={[row()]} />);
    await userEvent.setup().click(screen.getByTestId('flow-run-step-toggle-row-list'));
    await waitFor(() => expect(screen.getByTestId('flow-run-step-body-row-list').textContent).toContain('null'));
    rerender(
      <FlowRunTimeline runId="r1" definition={definition} steps={[row({ status: 'completed', finishedAt: '2026-10-20T02:00:02.000Z', durationMs: 2000 })]} />,
    );
    await waitFor(() => expect(screen.getByTestId('flow-run-step-body-row-list').textContent).toContain('"count": 7'));
    expect(api.getFlowRunStep).toHaveBeenCalledTimes(2);
  });

  it('does not re-fetch when the row is unchanged on a re-render', async () => {
    api.getFlowRunStep.mockResolvedValue(body(null));
    const { rerender } = render(<FlowRunTimeline runId="r1" definition={definition} steps={[row()]} />);
    await userEvent.setup().click(screen.getByTestId('flow-run-step-toggle-row-list'));
    await screen.findByTestId('flow-run-step-body-row-list');
    rerender(<FlowRunTimeline runId="r1" definition={definition} steps={[row()]} />);
    expect(api.getFlowRunStep).toHaveBeenCalledTimes(1);
  });

  it('a failed load does not cache: the next expand retries', async () => {
    api.getFlowRunStep.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(body({ ok: 1 }));
    render(<FlowRunTimeline runId="r1" definition={definition} steps={[row({ status: 'completed' })]} />);
    const user = userEvent.setup();
    const toggle = screen.getByTestId('flow-run-step-toggle-row-list');
    await user.click(toggle);
    await screen.findByTestId('flow-run-step-error-row-list');
    await user.click(toggle); // collapse
    await user.click(toggle); // expand again -> retry
    await screen.findByTestId('flow-run-step-body-row-list');
    expect(api.getFlowRunStep).toHaveBeenCalledTimes(2);
  });

  it('an unreached step in an active run says Pending; in a finished run, Not reached', () => {
    const { rerender } = render(<FlowRunTimeline runId="r1" definition={definition} steps={[row()]} runActive />);
    expect(screen.getByTestId('flow-run-step-final').textContent).toContain('Pending');
    expect(screen.getByTestId('flow-run-step-final').textContent).not.toContain('Not reached');
    rerender(<FlowRunTimeline runId="r1" definition={definition} steps={[row({ status: 'completed' })]} runActive={false} />);
    expect(screen.getByTestId('flow-run-step-final').textContent).toContain('Not reached');
  });
});
