import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '../../stores/auth';
import { useAiStore } from '../../stores/aiStore';
import { ActionError } from '../../lib/runAction';
import TopologyExplanationPanel from './TopologyExplanationPanel';
import { AI, aiExplanationFixture, aiGraphFixture, aiSelection, jsonResponse, sseResponse } from './topologyAiFixtures';
import { traceRunFixture } from './operationsFixtures';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const decideIntentApproval = vi.fn();
vi.mock('../../lib/intentApprovals', async (original) => ({
  ...await original<typeof import('../../lib/intentApprovals')>(),
  decideIntentApproval: (...args: unknown[]) => decideIntentApproval(...args),
}));

const RESET = {
  sessionId: null, sessionOrgId: null, hydratedSessionId: null, messages: [], isStreaming: false, isLoading: false, error: null, errorCode: null,
  pendingApproval: null, topologySiteId: null, topologySelection: null, topologyPhase: null, topologyRunId: null, pageContext: null,
};
beforeEach(() => { vi.mocked(fetchWithAuth).mockReset(); decideIntentApproval.mockReset(); useAiStore.setState(RESET as never); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const calls = () => vi.mocked(fetchWithAuth).mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url)}`);
const messagePosts = () => calls().filter((call) => call === `POST /ai/sessions/${AI.session}/messages`);

/** Session create answers, then the message stream answers with `events`. */
function serve(events: unknown[], options: { hold?: Promise<void>; create?: Response; send?: Response } = {}) {
  vi.mocked(fetchWithAuth).mockImplementation(async (input, init) => {
    const url = String(input), method = init?.method ?? 'GET';
    if (method === 'POST' && url === '/ai/sessions') return options.create ?? jsonResponse({ id: AI.session, orgId: 'org-1' });
    if (method === 'POST' && url === `/ai/sessions/${AI.session}/messages`) return options.send ?? sseResponse(events, options.hold);
    if (method === 'POST' && url.endsWith('/interrupt')) return jsonResponse({ interrupted: true });
    return jsonResponse({ error: 'unexpected' }, 500);
  });
}
const turn = (explanation: unknown, extra: unknown[] = []) => [
  { type: 'message_start', messageId: 'm1' }, { type: 'topology_progress', phase: 'analyzing' }, ...extra,
  { type: 'topology_explanation', explanation }, { type: 'done' },
];
/**
 * A turn blocked on a proposal: the server holds the turn open while the
 * approval wait runs, so no `done` arrives while the card is actionable.
 */
const proposalTurn = (explanation: unknown, extra: unknown[]) => [
  { type: 'message_start', messageId: 'm1' }, { type: 'topology_progress', phase: 'analyzing' },
  { type: 'topology_explanation', explanation }, ...extra,
];

function renderPanel(props: Partial<Parameters<typeof TopologyExplanationPanel>[0]> = {}) {
  const handlers = { onInvestigation: vi.fn(), onRun: vi.fn(), onEvidenceSelect: vi.fn() };
  const view = render(<TopologyExplanationPanel siteId={AI.site} selection={aiSelection()} graph={aiGraphFixture()} canApprove {...handlers} {...props} />);
  return { ...handlers, ...view };
}

describe('Explain this (M4 Task 5)', () => {
  it('calls the model only on Explain, over the one chat transport, and renders cited sections', async () => {
    serve(turn(aiExplanationFixture()));
    const { onEvidenceSelect, onInvestigation } = renderPanel();
    expect(fetchWithAuth).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('topology-explain'));
    await screen.findByTestId('topology-explanation');
    expect(calls()).toEqual(['POST /ai/sessions', `POST /ai/sessions/${AI.session}/messages`]);
    const created = JSON.parse(String(vi.mocked(fetchWithAuth).mock.calls[0]![1]!.body));
    // IDs only: no labels, no org, no device binding.
    expect(created.pageContext).toEqual({ type: 'topology', ...aiSelection() });
    expect(created).not.toHaveProperty('deviceId');
    expect(onInvestigation).toHaveBeenCalledWith(AI.session);

    const finding = within(screen.getByTestId('topology-explain-findings')).getByTestId('topology-explain-finding');
    // The alias maps to the name the viewer's own graph holds.
    expect(finding).toHaveTextContent('The uplink of Core switch reports failed checks.');
    // A hypothesis stays under "Possible causes"; an alias for a node outside the viewer's graph stays an alias.
    expect(within(screen.getByTestId('topology-explain-hypotheses')).getByTestId('topology-explain-hypothesis')).toHaveTextContent(`A loop behind ${AI.foreignAlias} may flood the link.`);
    expect(screen.getByTestId('topology-explain-missing-data')).toHaveTextContent('No LLDP from Core switch.');
    expect(screen.getByTestId('topology-explain-next-checks')).toHaveTextContent('Check the gateway from the switch.');

    fireEvent.click(screen.getByTestId('topology-evidence-citation-0'));
    expect(onEvidenceSelect).toHaveBeenCalledWith({ kind: 'relationship', id: AI.link });
    expect(messagePosts()).toHaveLength(1);
  });

  it('never renders raw content_delta or tool output arriving on a topology turn', async () => {
    serve(turn(aiExplanationFixture(), [{ type: 'content_delta', delta: 'RAW MODEL PROSE' }, { type: 'tool_result', toolUseId: 't', output: 'RAW TOOL OUTPUT', isError: false }]));
    renderPanel();
    fireEvent.click(screen.getByTestId('topology-explain'));
    await screen.findByTestId('topology-explanation');
    expect(document.body.textContent).not.toContain('RAW MODEL PROSE');
    expect(document.body.textContent).not.toContain('RAW TOOL OUTPUT');
  });

  it('shows the deterministic fallback for a malformed answer, never its body', async () => {
    serve(turn({ findings: 'FORGED BODY', schemaVersion: 1 }));
    renderPanel();
    fireEvent.click(screen.getByTestId('topology-explain'));
    expect(await screen.findByTestId('topology-explain-fallback')).toHaveTextContent('could not be validated');
    expect(document.body.textContent).not.toContain('FORGED BODY');
    expect(screen.getByTestId('topology-explain-fallback')).toHaveTextContent('diagnostics on this page still work');
  });

  it.each([
    ['AI disabled', { create: jsonResponse({ error: 'x', code: 'topology_ai_disabled' }, 403) }, 'turned off'],
    ['provider/limits unavailable', { send: jsonResponse({ error: 'x', code: 'topology_ai_limits_unavailable' }, 503) }, 'unavailable right now'],
    ['budget limit', { send: jsonResponse({ error: 'x', code: 'topology_ai_budget_exhausted' }, 429) }, 'limit was reached'],
    ['site moved (scope changed)', { send: jsonResponse({ error: 'x', code: 'investigation_scope_changed' }, 409) }, 'changed. Start a new explanation'],
    ['permission revoked', { send: jsonResponse({ error: 'x', code: 'topology_site_unavailable' }, 404) }, 'no longer have access'],
  ])('%s → honest fallback, deterministic tools untouched', async (_name, options, copy) => {
    serve([], options);
    renderPanel();
    fireEvent.click(screen.getByTestId('topology-explain'));
    const fallback = await screen.findByTestId('topology-explain-fallback');
    expect(fallback).toHaveTextContent(copy);
    expect(screen.queryByTestId('topology-explanation')).toBeNull();
    if ('create' in options) expect(messagePosts()).toHaveLength(0);
  });

  it('a provider failure mid-stream ends in the fallback with no partial text', async () => {
    serve([{ type: 'message_start', messageId: 'm1' }, { type: 'topology_progress', phase: 'analyzing' }, { type: 'error', message: 'The topology explanation could not be completed.' }, { type: 'done' }]);
    renderPanel();
    fireEvent.click(screen.getByTestId('topology-explain'));
    expect(await screen.findByTestId('topology-explain-fallback')).toHaveTextContent('unavailable right now');
  });

  it('says so when the evidence supports nothing, and marks partial / changed-evidence answers', async () => {
    serve(turn(aiExplanationFixture({ findings: [], missingData: [], nextChecks: [], citationIds: [], citations: [], hostAliases: undefined, status: 'evidence_changed', reasons: ['citation_unavailable'] })));
    renderPanel();
    fireEvent.click(screen.getByTestId('topology-explain'));
    expect(await screen.findByTestId('topology-explain-no-evidence')).toBeVisible();
    expect(screen.getByTestId('topology-explain-partial')).toHaveTextContent('no longer available');
  });

  it('marks a citation whose evidence left the viewer\'s graph as expired detail, not a link', async () => {
    const explanation = aiExplanationFixture({
      citations: [{ id: AI.link, resourceType: 'observation', resourceId: AI.foreignNode, observedAt: null, inspectorTarget: null },
        { id: AI.switch, resourceType: 'node', resourceId: AI.foreignNode, observedAt: null, inspectorTarget: { kind: 'node', id: AI.foreignNode } }],
    });
    serve(turn(explanation));
    renderPanel();
    fireEvent.click(screen.getByTestId('topology-explain'));
    const first = await screen.findByTestId('topology-evidence-citation-0');
    expect(first.tagName).not.toBe('BUTTON');
    expect(within(first).getByTestId('topology-evidence-citation-expired')).toBeVisible();
    expect(screen.getByTestId('topology-evidence-citation-1').tagName).not.toBe('BUTTON');
  });

  it('a changed selection cancels the running turn, and its delayed answer never lands on the new selection', async () => {
    let release!: () => void;
    serve(turn(aiExplanationFixture()), { hold: new Promise<void>((resolve) => { release = resolve; }) });
    const { rerender, onInvestigation } = renderPanel();
    fireEvent.click(screen.getByTestId('topology-explain'));
    await waitFor(() => expect(messagePosts()).toHaveLength(1));
    rerender(<TopologyExplanationPanel siteId={AI.site} selection={aiSelection({ subject: { kind: 'node', id: AI.switch } })} graph={aiGraphFixture()} canApprove
      onInvestigation={onInvestigation} onRun={vi.fn()} onEvidenceSelect={vi.fn()} />);
    await waitFor(() => expect(calls()).toContain(`POST /ai/sessions/${AI.session}/interrupt`));
    await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.queryByTestId('topology-explanation')).toBeNull();
    expect(onInvestigation).toHaveBeenLastCalledWith(undefined);
  });

  it('keeps a completed answer as explicitly historical after the map changes, with its proposal disabled', async () => {
    serve(proposalTurn(aiExplanationFixture(), [
      { type: 'approval_required', executionId: 'e1', toolName: 'diagnose_connectivity', description: 'Run gateway reachability check from Core switch', input: { recipe_id: 'gateway_basic', origin_device_id: AI.device, family: 'ipv4', context_key: 'default', proposal_expires_at: '2026-09-26T12:15:00.000Z' }, intentBacked: true, selfApprovalRequestId: 'ap-1', approvalScope: 'supervised' },
    ]));
    const { rerender } = renderPanel();
    fireEvent.click(screen.getByTestId('topology-explain'));
    await screen.findByTestId('topology-explanation');
    expect(screen.getByTestId('topology-proposal-approve')).toBeVisible();
    rerender(<TopologyExplanationPanel siteId={AI.site} selection={aiSelection({ graphRevision: '2' })} graph={aiGraphFixture()} canApprove
      onInvestigation={vi.fn()} onRun={vi.fn()} onEvidenceSelect={vi.fn()} />);
    expect(screen.getByTestId('topology-explain-historical')).toBeVisible();
    expect(screen.queryByTestId('topology-proposal-approve')).toBeNull();
    expect(screen.getByTestId('topology-proposal-disabled')).toHaveTextContent('earlier answer');
  });
});

describe('proposed diagnostic approval (M4-D3)', () => {
  const proposalEvent = {
    type: 'approval_required', executionId: 'e1', toolName: 'diagnose_connectivity',
    description: 'Run gateway reachability check from Core switch (context default, ipv4) to gateway 192.0.2.1 — 2 bounded steps, 60s max; approval expires 2026-09-26 12:15 UTC',
    input: { site_id: AI.site, recipe_id: 'gateway_basic', origin_device_id: AI.device, family: 'ipv4', context_key: 'default', proposal_expires_at: '2026-09-26T12:15:00.000Z' },
    intentBacked: true, selfApprovalRequestId: 'ap-1', approvalScope: 'supervised',
  };

  it('shows the pinned origin, recipe, destinations and limits, and approves with a fresh factor — nothing is dispatched by the panel', async () => {
    decideIntentApproval.mockResolvedValue('decided');
    serve(proposalTurn(aiExplanationFixture(), [{ type: 'topology_progress', phase: 'awaiting_approval' }, proposalEvent]));
    renderPanel();
    fireEvent.click(screen.getByTestId('topology-explain'));
    const card = await screen.findByTestId('topology-proposed-check');
    expect(within(card).getByTestId('topology-proposal-recipe')).toHaveTextContent('Reported gateway');
    expect(within(card).getByTestId('topology-proposal-origin')).toHaveTextContent('Core switch · default · ipv4');
    expect(card).toHaveTextContent('to gateway 192.0.2.1 — 2 bounded steps, 60s max');
    fireEvent.click(within(card).getByTestId('topology-proposal-approve'));
    await waitFor(() => expect(decideIntentApproval).toHaveBeenCalledWith('ap-1', 'approve', undefined, 'supervised', { freshFactor: true }));
    // The panel itself never POSTs a diagnostic run: release is the server's.
    expect(calls().filter((call) => call.includes('/diagnostic-runs'))).toEqual([]);
  });

  it('a read-only viewer sees the proposal but cannot approve it', async () => {
    serve(proposalTurn(aiExplanationFixture(), [proposalEvent]));
    renderPanel({ canApprove: false });
    fireEvent.click(screen.getByTestId('topology-explain'));
    expect(await screen.findByTestId('topology-proposal-disabled')).toHaveTextContent("can't run diagnostics");
    expect(screen.queryByTestId('topology-proposal-approve')).toBeNull();
  });

  it('an invalidated approval (content changed) is terminal: the card is withdrawn, never re-offered', async () => {
    decideIntentApproval.mockRejectedValue(new ActionError('changed', 409, undefined, { error: 'digest_mismatch' }));
    serve(proposalTurn(aiExplanationFixture(), [proposalEvent]));
    renderPanel();
    fireEvent.click(screen.getByTestId('topology-explain'));
    fireEvent.click(await screen.findByTestId('topology-proposal-approve'));
    await waitFor(() => expect(useAiStore.getState().pendingApproval).toBeNull());
    expect(screen.queryByTestId('topology-proposal-approve')).toBeNull();
    expect(decideIntentApproval).toHaveBeenCalledTimes(1);
  });

  it('a rejection sends deny with no ceremony', async () => {
    decideIntentApproval.mockResolvedValue('decided');
    serve(proposalTurn(aiExplanationFixture(), [proposalEvent]));
    renderPanel();
    fireEvent.click(screen.getByTestId('topology-explain'));
    fireEvent.click(await screen.findByTestId('topology-proposal-deny'));
    await waitFor(() => expect(decideIntentApproval).toHaveBeenCalledWith('ap-1', 'deny', undefined, 'supervised'));
  });

  it('follows an accepted run by id from queued to completed through the read route only', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const run = traceRunFixture();
    let reads = 0;
    serve(turn(aiExplanationFixture(), [{ type: 'topology_diagnostic_run', runId: AI.run, state: 'queued' }]));
    const base = vi.mocked(fetchWithAuth).getMockImplementation()!;
    vi.mocked(fetchWithAuth).mockImplementation(async (input, init) => {
      if (String(input) === `/topology/sites/${AI.site}/diagnostic-runs/${AI.run}`) {
        reads += 1;
        return jsonResponse({ ...run, id: AI.run, state: reads === 1 ? 'queued' : 'completed', finishedAt: reads === 1 ? null : run.finishedAt });
      }
      return base(input, init);
    });
    const { onRun } = renderPanel();
    fireEvent.click(screen.getByTestId('topology-explain'));
    expect(await screen.findByTestId('topology-ai-run-state')).toHaveTextContent('Queued');
    expect(onRun).toHaveBeenCalledWith(AI.run);
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    await waitFor(() => expect(screen.getByTestId('topology-ai-run-state')).toHaveTextContent('Completed'));
    expect(calls().filter((call) => call.startsWith('POST') && call.includes('diagnostic-runs'))).toEqual([]);
  });

  it('resumes a reopened run by id (expired) without any model call or execution POST', async () => {
    const run = traceRunFixture();
    vi.mocked(fetchWithAuth).mockImplementation(async (input) => String(input).endsWith(`/diagnostic-runs/${AI.run}`)
      ? jsonResponse({ ...run, id: AI.run, state: 'expired' }) : jsonResponse({ error: 'unexpected' }, 500));
    renderPanel({ initialRunId: AI.run });
    expect(await screen.findByTestId('topology-ai-run-state')).toHaveTextContent('Expired');
    expect(calls().every((call) => call.startsWith('GET'))).toBe(true);
  });
});
