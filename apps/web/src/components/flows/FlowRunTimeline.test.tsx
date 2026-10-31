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

  it('overlapping items render as one group', () => {
    const fe = {
      version: 1, name: 'n', trigger: { type: 'manual' }, inputs: [],
      steps: [{ id: 'each', tool: 'manage_tags', input: {}, forEach: { items: 'x', as: 'item', maxItems: 10, concurrency: 3 }, approval: 'default', onFailure: 'stop', timeoutSec: 60 }],
    } as never;
    const item = (n: number, start: string, end: string) =>
      row({ id: `i${n}`, stepId: 'each', itemIndex: n, status: 'completed', startedAt: start, finishedAt: end, durationMs: 1000 });
    render(
      <FlowRunTimeline
        runId="r1"
        definition={fe}
        steps={[
          item(0, '2026-10-20T02:00:00.000Z', '2026-10-20T02:00:05.000Z'),
          item(1, '2026-10-20T02:00:01.000Z', '2026-10-20T02:00:06.000Z'),
          item(2, '2026-10-20T02:00:10.000Z', '2026-10-20T02:00:11.000Z'),
        ]}
      />,
    );
    const groups = screen.getAllByTestId('flow-run-parallel-group');
    expect(groups).toHaveLength(1);
    expect(groups[0].textContent).toContain('2 items ran in parallel');
    expect(groups[0].querySelectorAll('[data-testid^="flow-run-item-"]')).toHaveLength(2);
    expect(screen.getByTestId('flow-run-item-i2')).toBeTruthy();
  });

  it('retry attempts of one item are not parallel items: the group counts distinct items and rows sort by (item, attempt)', () => {
    const fe = {
      version: 1, name: 'n', trigger: { type: 'manual' }, inputs: [],
      steps: [{ id: 'each', tool: 'manage_tags', input: {}, forEach: { items: 'x', as: 'item', maxItems: 10, concurrency: 3 }, approval: 'default', onFailure: 'stop', timeoutSec: 60 }],
    } as never;
    const att = (id: string, n: number, attempt: number, start: string, end: string) =>
      row({ id, stepId: 'each', itemIndex: n, attempt, status: 'completed', startedAt: start, finishedAt: end, durationMs: 1000 });
    render(
      <FlowRunTimeline
        runId="r1"
        definition={fe}
        steps={[
          att('i1a1', 1, 1, '2026-10-20T02:00:01.000Z', '2026-10-20T02:00:06.000Z'),
          att('i0a2', 0, 2, '2026-10-20T02:00:03.000Z', '2026-10-20T02:00:05.000Z'),
          att('i0a1', 0, 1, '2026-10-20T02:00:00.000Z', '2026-10-20T02:00:02.000Z'),
        ]}
      />,
    );
    const groups = screen.getAllByTestId('flow-run-parallel-group');
    expect(groups).toHaveLength(1);
    expect(groups[0].textContent).toContain('2 items ran in parallel');
    const ids = [...groups[0].querySelectorAll('[data-testid^="flow-run-item-"]')].map((n) => n.getAttribute('data-testid'));
    expect(ids).toEqual(['flow-run-item-i0a1', 'flow-run-item-i0a2', 'flow-run-item-i1a1']);
  });

  it('two attempts of a single item render as plain rows, not a parallel group', () => {
    const fe = {
      version: 1, name: 'n', trigger: { type: 'manual' }, inputs: [],
      steps: [{ id: 'each', tool: 'manage_tags', input: {}, forEach: { items: 'x', as: 'item', maxItems: 10, concurrency: 3 }, approval: 'default', onFailure: 'stop', timeoutSec: 60 }],
    } as never;
    const att = (id: string, attempt: number, start: string, end: string) =>
      row({ id, stepId: 'each', itemIndex: 0, attempt, status: 'completed', startedAt: start, finishedAt: end, durationMs: 1000 });
    render(
      <FlowRunTimeline
        runId="r1"
        definition={fe}
        steps={[att('a1', 1, '2026-10-20T02:00:00.000Z', '2026-10-20T02:00:02.000Z'), att('a2', 2, '2026-10-20T02:00:01.000Z', '2026-10-20T02:00:03.000Z')]}
      />,
    );
    expect(screen.queryByTestId('flow-run-parallel-group')).toBeNull();
    expect(screen.getByTestId('flow-run-item-a1')).toBeTruthy();
    expect(screen.getByTestId('flow-run-item-a2')).toBeTruthy();
  });

  it('a row with aiUsage shows tokens and dollars', () => {
    render(
      <FlowRunTimeline runId="r1" definition={definition}
        steps={[row({ status: 'completed', aiUsage: { inputTokens: 120, outputTokens: 30, costCents: 3 } })]} />,
    );
    const el = screen.getByTestId('flow-run-step-aiusage-row-list');
    expect(el.textContent).toContain('120');
    expect(el.textContent).toContain('30');
    expect(el.textContent).toContain('$0.03');
  });

  it('an expanded http_request row shows the HTTP status from its loaded output', async () => {
    const http = {
      version: 1, name: 'n', trigger: { type: 'manual' }, inputs: [],
      steps: [{ id: 'call', tool: 'http_request', input: {}, approval: 'default', onFailure: 'stop', timeoutSec: 60 }],
    } as never;
    const r = row({ id: 'row-call', stepId: 'call', tool: 'http_request', status: 'completed' });
    api.getFlowRunStep.mockResolvedValue({ ...(r as object), renderedInput: {}, output: { status: 503, headers: {}, body: '' } });
    render(<FlowRunTimeline runId="r1" definition={http} steps={[r]} />);
    expect(screen.queryByTestId('flow-run-step-httpstatus-row-call')).toBeNull();
    await userEvent.setup().click(screen.getByTestId('flow-run-step-toggle-row-call'));
    const el = await screen.findByTestId('flow-run-step-httpstatus-row-call');
    expect(el.textContent).toContain('HTTP 503');
  });
});
