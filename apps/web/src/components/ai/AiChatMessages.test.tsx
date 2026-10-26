import { fireEvent, render } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AiChatMessages from './AiChatMessages';

// The streamed-content children are irrelevant to scroll-anchoring behavior.
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: () => {} }));
// Records the props each AiToolCallCard instance receives (sweep E6): what
// this file owns is the wiring from a message row to the card's `input`
// prop, not the card's own rendering, which has its own test suite.
const toolCallCards = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>>, mounts: 0 }));
vi.mock('./AiToolCallCard', async () => {
  const { useEffect } = await import('react');
  return {
    default: (props: Record<string, unknown>) => {
      toolCallCards.props.push(props);
      // Counts MOUNTS (#9534): a completed card must replace its pending card
      // in place, i.e. reuse the same instance rather than mount a second one.
      useEffect(() => {
        toolCallCards.mounts += 1;
      }, []);
      return null;
    },
  };
});

// Records the props AiChatMessages forwards to the approval card. The real
// dialog is heavy (WebAuthn + i18n), and what this file owns is the wiring:
// that the self-approve id and the decided callback reach the card at all.
const approvalDialog = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
  mounts: 0,
}));
vi.mock('./AiApprovalDialog', async () => {
  const { useEffect } = await import('react');
  return {
    default: (props: Record<string, unknown>) => {
      approvalDialog.props.push(props);
      // Counts MOUNTS, not renders — the only way to observe from here whether
      // the parent keyed the card (new key ⇒ fresh instance ⇒ fresh state).
      useEffect(() => {
        approvalDialog.mounts += 1;
      }, []);
      return null;
    },
  };
});
vi.mock('./AiPlanReviewCard', () => ({ default: () => null }));
vi.mock('./AiPlanProgressBar', () => ({ default: () => null }));
// The run card polls the API; what this file owns is which run id reaches it.
const runCards = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));
vi.mock('./AiRunCard', () => ({
  default: (props: Record<string, unknown>) => {
    runCards.props.push(props);
    return <div data-testid="run-card-stub" data-run-id={String(props.runId)} />;
  },
}));

type Msg = {
  id: string;
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  content: string;
  isStreaming?: boolean;
};

const baseProps = {
  pendingApproval: null,
  onApprove: vi.fn(),
  onReject: vi.fn(),
};

/**
 * Wisp companion W01: tool calls fold into a collapsed group by default. The
 * suites below this helper pin the per-call wiring inside a group (input
 * reuse, one card per call, proposal links), so they open every group first.
 */
function expandToolGroups(root: ParentNode = document) {
  root
    .querySelectorAll<HTMLButtonElement>('[data-testid="ai-tool-group"] > button[aria-expanded="false"]')
    .forEach((b) => fireEvent.click(b));
}

function renderWithMessages(messages: Msg[]) {
  const view = render(<AiChatMessages {...baseProps} messages={messages as never} />);
  expandToolGroups(view.container);
  return view;
}

// jsdom has no layout engine, so scrollHeight/clientHeight are 0. Stamp a
// realistic geometry onto the scroll container so the bottom-pinning math runs.
function stampGeometry(el: HTMLElement, opts: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: opts.scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: opts.clientHeight });
  let scrollTop = opts.scrollTop;
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
    },
  });
}

const container = (root: HTMLElement) => root.querySelector('.overflow-y-auto') as HTMLElement;

describe('AiChatMessages auto-scroll anchoring (#1713)', () => {
  let rafCallbacks: FrameRequestCallback[];
  let cancelSpy: ReturnType<typeof vi.fn<(id: number) => void>>;

  beforeEach(() => {
    rafCallbacks = [];
    cancelSpy = vi.fn<(id: number) => void>();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      cancelSpy(id);
      rafCallbacks[id - 1] = () => {};
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const flushRaf = () => act(() => rafCallbacks.forEach((cb) => cb(0)));

  it('scrolls the container to the bottom (not scrollIntoView) when a message is appended', () => {
    const { rerender } = renderWithMessages([{ id: '1', role: 'user', content: 'hi' }]);
    const el = container(document.body);
    stampGeometry(el, { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 });

    rerender(
      <AiChatMessages
        {...baseProps}
        messages={[
          { id: '1', role: 'user', content: 'hi' },
          { id: '2', role: 'assistant', content: 'hello', isStreaming: true },
        ] as never}
      />,
    );
    flushRaf();

    // Anchored to the bottom: scrollTop === scrollHeight.
    expect(el.scrollTop).toBe(1000);
  });

  it('does NOT auto-scroll once the user has scrolled up to read history', () => {
    const { rerender } = renderWithMessages([{ id: '1', role: 'user', content: 'hi' }]);
    const el = container(document.body);
    // User is 400px from the bottom — well past the pin threshold.
    stampGeometry(el, { scrollHeight: 1000, clientHeight: 300, scrollTop: 300 });
    fireEvent.scroll(el);

    rerender(
      <AiChatMessages
        {...baseProps}
        messages={[
          { id: '1', role: 'user', content: 'hi' },
          { id: '2', role: 'assistant', content: 'streaming…', isStreaming: true },
        ] as never}
      />,
    );
    flushRaf();

    // Position is left where the reader put it — not yanked to the bottom.
    expect(el.scrollTop).toBe(300);
  });

  it('re-pins and auto-scrolls again after the user scrolls back to the bottom', () => {
    const { rerender } = renderWithMessages([{ id: '1', role: 'user', content: 'hi' }]);
    const el = container(document.body);

    // Scroll up first → unpin.
    stampGeometry(el, { scrollHeight: 1000, clientHeight: 300, scrollTop: 300 });
    fireEvent.scroll(el);

    // Then scroll back to the bottom → re-pin.
    el.scrollTop = 700;
    fireEvent.scroll(el);

    stampGeometry(el, { scrollHeight: 1200, clientHeight: 300, scrollTop: 700 });
    rerender(
      <AiChatMessages
        {...baseProps}
        messages={[
          { id: '1', role: 'user', content: 'hi' },
          { id: '2', role: 'assistant', content: 'more', isStreaming: true },
        ] as never}
      />,
    );
    flushRaf();

    expect(el.scrollTop).toBe(1200);
  });

  // The core of the #1713 fix: a burst of streaming re-renders must coalesce into
  // ONE post-paint scroll, cancelling the prior frame each time. Without the
  // cancellation block, the original interrupted-animation jank returns — yet the
  // single-rerender tests above would still pass. This locks in the mechanism.
  it('coalesces a burst of re-renders into a single scroll (cancels the prior frame)', () => {
    const msg = (n: number) => ({ id: `m${n}`, role: 'assistant' as const, content: `delta ${n}`, isStreaming: true });
    const { rerender } = renderWithMessages([{ id: '1', role: 'user', content: 'hi' }]);
    const el = container(document.body);
    stampGeometry(el, { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 });

    // Three rapid streaming re-renders before any frame fires. (The initial
    // mount also scheduled a frame.)
    rerender(<AiChatMessages {...baseProps} messages={[{ id: '1', role: 'user', content: 'hi' }, msg(1)] as never} />);
    rerender(<AiChatMessages {...baseProps} messages={[{ id: '1', role: 'user', content: 'hi' }, msg(2)] as never} />);
    rerender(<AiChatMessages {...baseProps} messages={[{ id: '1', role: 'user', content: 'hi' }, msg(3)] as never} />);

    // Each re-render runs the prior effect's cleanup, which cancels the still-
    // pending frame before the new effect schedules the next one. Across the
    // mount + 3 rerenders that is 3 cancellations, leaving exactly one live
    // frame — the coalescing contract. Delete the cancellation block and this
    // drops to 0, while the single-rerender tests above still pass.
    expect(cancelSpy).toHaveBeenCalledTimes(3);

    flushRaf();
    expect(el.scrollTop).toBe(1000);
  });

  it('auto-scrolls when a pending-approval card appears (not just on messages change)', () => {
    const messages = [{ id: '1', role: 'user', content: 'run it' }];
    const { rerender } = render(<AiChatMessages {...baseProps} messages={messages as never} />);
    const el = container(document.body);
    stampGeometry(el, { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 });

    // messages unchanged; only the pendingApproval prop flips on.
    rerender(
      <AiChatMessages
        {...baseProps}
        messages={messages as never}
        pendingApproval={{
          executionId: 'e1', toolName: 'run_script', input: {}, description: 'Run a script',
        }}
      />,
    );
    flushRaf();

    expect(el.scrollTop).toBe(1000);
  });

  it('forwards selfApprovalRequestId and onIntentDecided to the approval card', () => {
    approvalDialog.props.length = 0;
    const onIntentDecided = vi.fn();

    render(
      <AiChatMessages
        {...baseProps}
        messages={[{ id: '1', role: 'user', content: 'read that file' }] as never}
        pendingApproval={{
          executionId: 'e1',
          toolName: 'file_operations',
          input: {},
          description: 'Read a file',
          intentBacked: true,
          selfApprovalRequestId: 'ap-1',
        }}
        onIntentDecided={onIntentDecided}
      />,
    );

    const props = approvalDialog.props.at(-1)!;
    // Without both of these the card can never render its inline
    // Verify & Approve / Deny buttons (they are gated on the id).
    expect(props.intentBacked).toBe(true);
    expect(props.selfApprovalRequestId).toBe('ap-1');
    (props.onIntentDecided as () => void)();
    expect(onIntentDecided).toHaveBeenCalledTimes(1);
  });

  it('remounts the approval card for each new execution so decide state cannot leak', () => {
    // pendingApproval is REPLACED in place by every approval_required event.
    // Without key={executionId} React reconciles the same instance and the
    // previous card's needs_device / error / decided state survives into an
    // unrelated approval — the reported symptom being a card that renders with
    // no Approve button for the rest of the session after the user hit
    // needs_device once and then registered a passkey.
    approvalDialog.props.length = 0;
    approvalDialog.mounts = 0;
    const messages = [{ id: '1', role: 'user', content: 'read that file' }] as never;
    const approval = (executionId: string, selfApprovalRequestId: string) => ({
      executionId,
      toolName: 'file_operations',
      input: {},
      description: 'Read a file',
      intentBacked: true,
      selfApprovalRequestId,
    });

    const { rerender } = render(
      <AiChatMessages {...baseProps} messages={messages} pendingApproval={approval('e1', 'ap-1')} />,
    );
    expect(approvalDialog.mounts).toBe(1);

    // Same execution, incidental re-render → no remount (state is preserved).
    rerender(
      <AiChatMessages {...baseProps} messages={messages} pendingApproval={approval('e1', 'ap-1')} />,
    );
    expect(approvalDialog.mounts).toBe(1);

    // New execution → fresh instance, so the Approve button is back.
    rerender(
      <AiChatMessages {...baseProps} messages={messages} pendingApproval={approval('e2', 'ap-2')} />,
    );
    expect(approvalDialog.mounts).toBe(2);
    expect(approvalDialog.props.at(-1)!.selfApprovalRequestId).toBe('ap-2');
  });

  /**
   * #4888 — the run context reaches the card, or the approver is never warned.
   *
   * The dialog renders the row correctly when handed the prop and the store
   * puts it on `pendingApproval`; this line is the seam between those two
   * facts. Deleting it would hide "the assistant chose SYSTEM, overriding this
   * script's default" from the human deciding the approval, with every other
   * test in the tree still green.
   */
  it('forwards the resolved scriptRunContext to the approval card', () => {
    approvalDialog.props.length = 0;
    const messages = [{ id: '1', role: 'user', content: 'run the cleanup script' }] as never;
    const scriptRunContext = {
      effectiveRunAs: 'system' as const,
      scriptDefaultRunAs: 'user' as const,
      chosenByAssistant: true,
      targetSessionId: null,
    };

    render(
      <AiChatMessages
        {...baseProps}
        messages={messages}
        pendingApproval={{
          executionId: 'e-rc',
          toolName: 'run_script',
          input: { scriptId: 's-1', deviceIds: ['d-1'], runAs: 'system' },
          description: 'Run script s-1 on 1 device(s)',
          intentBacked: true,
          scriptRunContext,
        }}
      />,
    );

    expect(approvalDialog.props.at(-1)!.scriptRunContext).toEqual(scriptRunContext);
  });

  it('cancels the pending frame on unmount so it never scrolls a torn-down container', () => {
    const { rerender, unmount } = renderWithMessages([{ id: '1', role: 'user', content: 'hi' }]);
    const el = container(document.body);
    stampGeometry(el, { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 });

    rerender(
      <AiChatMessages
        {...baseProps}
        messages={[
          { id: '1', role: 'user', content: 'hi' },
          { id: '2', role: 'assistant', content: 'streaming…', isStreaming: true },
        ] as never}
      />,
    );

    unmount();
    expect(cancelSpy).toHaveBeenCalled();

    // Flushing any surviving callback must not write to the detached container.
    el.scrollTop = 700;
    flushRaf();
    expect(el.scrollTop).toBe(700);
  });
});

/**
 * #5612 W04 — a lane-released run renders as an inline note, never through
 * the generic tool-call card (which would misdescribe it as an executed tool).
 */
describe('unattended_release note (#5612 W04)', () => {
  it('renders the note for a tool_result whose toolName is unattended_release', () => {
    const { getByTestId } = renderWithMessages([
      { id: '1', role: 'user', content: 'clear the temp files' },
      { id: 'unattended-release-int-1', role: 'tool_result', content: '', toolName: 'unattended_release' } as never,
    ]);
    expect(getByTestId('ai-unattended-release-note')).toBeTruthy();
  });

  it('does NOT render the note for an ordinary tool_result', () => {
    const { queryByTestId } = renderWithMessages([
      { id: 'r1', role: 'tool_result', content: '{}', toolName: 'run_script' } as never,
    ]);
    expect(queryByTestId('ai-unattended-release-note')).toBeNull();
  });
});

/**
 * Sweep E6 — the tool_result card used to render with no `input` prop at
 * all, so its label (aiToolLabel, which needs `input.action` to tell a read
 * from a write) always fell back to the tool name's own verb. It must reuse
 * the input already sitting on the matching tool_use row.
 */
describe('tool_result reuses its tool_use sibling\'s input (sweep E6)', () => {
  beforeEach(() => { toolCallCards.props.length = 0; });

  it('passes the matching tool_use row\'s toolInput to the tool_result card', () => {
    renderWithMessages([
      { id: 'tu-1', role: 'tool_use', content: '', toolName: 'manage_alerts', toolUseId: 'call-1', toolInput: { action: 'list' } } as never,
      { id: 'r1', role: 'tool_result', content: '[]', toolName: 'manage_alerts', toolUseId: 'call-1' } as never,
    ]);

    const resultCardProps = toolCallCards.props.find((p) => p.output !== undefined);
    expect(resultCardProps?.input).toEqual({ action: 'list' });
  });

  it('leaves input undefined when no matching tool_use row exists (e.g. replayed pre-#6086 history)', () => {
    renderWithMessages([
      { id: 'r1', role: 'tool_result', content: '[]', toolName: 'manage_alerts', toolUseId: 'call-orphan' } as never,
    ]);

    expect(toolCallCards.props.at(-1)?.input).toBeUndefined();
  });
});

// #7918: once a run_script call has finished (or failed) the approval card is
// gone, and the proposal page that shows its runs and offers "Save to
// library" had no link from anywhere a user could find.
describe('script proposal link after a run (#7918)', () => {
  const PROPOSAL = '6f1c2a4e-8d3b-4c5a-9e7f-0a1b2c3d4e5f';

  it('links a run_script { proposalId } result to the proposal page', () => {
    const { getByTestId } = renderWithMessages([
      { id: 'u1', role: 'tool_use', content: '', toolName: 'run_script', toolUseId: 't1', toolInput: { proposalId: PROPOSAL, deviceIds: ['d1'] } },
      { id: 'r1', role: 'tool_result', content: '{"error":"The tool could not complete this request"}', toolName: 'run_script', toolUseId: 't1', isError: true },
    ] as never);
    expect(getByTestId('ai-script-proposal-link').getAttribute('href')).toBe(`/approvals#proposal-${PROPOSAL}`);
  });

  it('links a propose_script result by the proposalId in its output', () => {
    const { getByTestId } = renderWithMessages([
      { id: 'u1', role: 'tool_use', content: '', toolName: 'propose_script', toolUseId: 't1', toolInput: {} },
      { id: 'r1', role: 'tool_result', content: '', toolName: 'propose_script', toolUseId: 't1', toolOutput: { proposalId: PROPOSAL, status: 'reviewed' } },
    ] as never);
    expect(getByTestId('ai-script-proposal-link').getAttribute('href')).toBe(`/approvals#proposal-${PROPOSAL}`);
  });

  it('renders no link for a library run_script { scriptId }', () => {
    const { queryByTestId } = renderWithMessages([
      { id: 'u1', role: 'tool_use', content: '', toolName: 'run_script', toolUseId: 't1', toolInput: { scriptId: PROPOSAL, deviceIds: ['d1'] } },
      { id: 'r1', role: 'tool_result', content: '{}', toolName: 'run_script', toolUseId: 't1' },
    ] as never);
    expect(queryByTestId('ai-script-proposal-link')).toBeNull();
  });

  it('never builds a link from a proposalId that is not a UUID', () => {
    const { queryByTestId } = renderWithMessages([
      { id: 'u1', role: 'tool_use', content: '', toolName: 'run_script', toolUseId: 't1', toolInput: { proposalId: 'not-a-uuid/../x' } },
      { id: 'r1', role: 'tool_result', content: '{}', toolName: 'run_script', toolUseId: 't1' },
    ] as never);
    expect(queryByTestId('ai-script-proposal-link')).toBeNull();
  });
});

// Tool Catalog W3 (#5218): a saved draft_flow / get_flow result renders the
// Flow card; anything else keeps the default tool card so errors stay visible.
describe('flow card for draft_flow / get_flow results (#5218)', () => {
  const FLOW_ID = '9f1c0f4e-0000-4000-8000-000000000001';
  const flowPayload = (id = FLOW_ID) => ({
    flow: {
      id, slug: 'nightly', name: 'Nightly offline report', description: null, ownerScope: 'organization',
      orgId: 'org-1', partnerId: null, status: 'draft', effectiveTier: 1, triggerType: 'manual',
      definitionVersion: 1, updatedAt: '2026-10-20T02:00:00.000Z', createdAt: '2026-10-20T02:00:00.000Z',
      createdByUserId: null, aiSessionId: null,
      definition: {
        version: 1, name: 'Nightly offline report', trigger: { type: 'manual' }, inputs: [],
        steps: [
          { id: 'a', tool: 'query_devices', input: {}, approval: 'default', onFailure: 'stop', timeoutSec: 300 },
          { id: 'b', tool: 'query_alerts', input: {}, approval: 'default', onFailure: 'stop', timeoutSec: 300 },
          { id: 'c', tool: 'send_email', input: {}, approval: 'default', onFailure: 'stop', timeoutSec: 300 },
        ],
      },
    },
    validation: {
      valid: true, effectiveTier: 1, issues: [],
      steps: ['a', 'b', 'c'].map((id) => ({ id, tool: 't', source: 'core', tier: 1, approval: 'default' })),
    },
  });
  const result = (toolName: string, toolOutput: unknown) => [
    { id: 'u1', role: 'tool_use', content: '', toolName, toolUseId: 't1', toolInput: {} },
    { id: 'r1', role: 'tool_result', content: '', toolName, toolUseId: 't1', toolOutput },
  ];

  beforeEach(() => {
    toolCallCards.props.length = 0;
  });

  it('renders the Flow card with 3 steps and a /flows/<uuid> link for a saved draft', () => {
    const { getByTestId, getAllByTestId } = renderWithMessages(
      result('draft_flow', { saved: true, ...flowPayload(), reviewPath: `/flows/${FLOW_ID}` }) as never,
    );
    expect(getByTestId('flow-draft-card')).toBeTruthy();
    expect(getAllByTestId(/^flow-step-[abc]$/)).toHaveLength(3);
    expect(getByTestId('flow-draft-review').getAttribute('href')).toBe(`/flows/${FLOW_ID}`);
    // The Flow card takes the tool_use row's place (#9534); no default tool
    // card renders beside it.
    expect(toolCallCards.props.some((p) => p.output !== undefined)).toBe(false);
  });

  it('renders no review link when the id is not a UUID', () => {
    const { getByTestId, queryByTestId } = renderWithMessages(
      result('draft_flow', { saved: true, ...flowPayload('nope/../x') }) as never,
    );
    expect(getByTestId('flow-draft-card')).toBeTruthy();
    expect(queryByTestId('flow-draft-review')).toBeNull();
  });

  it('renders the card for a get_flow result', () => {
    const { getByTestId } = renderWithMessages(result('get_flow', flowPayload()) as never);
    expect(getByTestId('flow-draft-card')).toBeTruthy();
  });

  it('falls through to the default tool card when saved is false', () => {
    const { queryByTestId } = renderWithMessages(
      result('draft_flow', { saved: false, error: 'invalid' }) as never,
    );
    expect(queryByTestId('flow-draft-card')).toBeNull();
    expect(toolCallCards.props.at(-1)?.toolName).toBe('draft_flow');
  });

  it('falls through to the default tool card for malformed JSON output', () => {
    const { queryByTestId } = renderWithMessages(result('draft_flow', '{not json') as never);
    expect(queryByTestId('flow-draft-card')).toBeNull();
    expect(toolCallCards.props.at(-1)?.toolName).toBe('draft_flow');
  });
});

// #9534: a 4-tool run showed 8 rows — the pending card ("Searched devices",
// wrench) stayed after the completed card arrived. One tool call is one card:
// the completed card replaces the pending one in place, keyed by tool_use id.
describe('one card per tool call (#9534)', () => {
  beforeEach(() => {
    toolCallCards.props.length = 0;
    toolCallCards.mounts = 0;
  });

  const use = (id: string, toolUseId?: string, toolName = 'query_devices') =>
    ({ id, role: 'tool_use', content: '', toolName, toolUseId, toolInput: { status: 'online' } }) as never;
  const result = (id: string, toolUseId?: string, toolName = 'query_devices') =>
    ({ id, role: 'tool_result', content: '[]', toolName, toolUseId, toolOutput: [] }) as never;

  it('renders a completed tool call as ONE card, not a pending card plus a result card', () => {
    renderWithMessages([use('tool-a', 'a'), result('result-a', 'a')]);
    expect(toolCallCards.props).toHaveLength(1);
    expect(toolCallCards.props[0]).toMatchObject({ output: [], input: { status: 'online' } });
    expect(toolCallCards.props[0].isExecuting).toBeFalsy();
  });

  it('replaces the pending card in place when the result arrives (same instance, no second mount)', () => {
    const { rerender } = renderWithMessages([use('tool-a', 'a')]);
    expect(toolCallCards.props.at(-1)?.isExecuting).toBe(true);
    expect(toolCallCards.mounts).toBe(1);

    rerender(<AiChatMessages {...baseProps} messages={[use('tool-a', 'a'), result('result-a', 'a')] as never} />);
    expect(toolCallCards.mounts).toBe(1);
    expect(toolCallCards.props.at(-1)).toMatchObject({ output: [] });
  });

  it('keeps each parallel call in its own place; only the finished one completes', () => {
    renderWithMessages([use('tool-a', 'a'), use('tool-b', 'b'), result('result-a', 'a')]);
    expect(toolCallCards.props).toHaveLength(2);
    expect(toolCallCards.props[0]).toMatchObject({ output: [] });
    // b's neighbour is a's result: it must not borrow it and stop spinning.
    expect(toolCallCards.props[1]).toMatchObject({ isExecuting: true });
    expect(toolCallCards.props[1].output).toBeUndefined();
  });

  it('pairs replayed history rows that carry no tool_use id by adjacency', () => {
    renderWithMessages([use('u1', undefined), result('r1', undefined)]);
    expect(toolCallCards.props).toHaveLength(1);
    expect(toolCallCards.props[0]).toMatchObject({ output: [] });
  });

  it('never pairs a synthetic id-less row (unattended_release) with the tool_use before it', () => {
    const { getByTestId, rerender } = renderWithMessages([
      use('u1', 'x', 'run_script'),
      result('note', undefined, 'unattended_release'),
    ]);
    expect(getByTestId('ai-unattended-release-note')).toBeTruthy();
    expect(toolCallCards.props.at(-1)).toMatchObject({ toolName: 'run_script', isExecuting: true });

    rerender(<AiChatMessages {...baseProps} messages={[
      use('u1', 'x', 'run_script'),
      result('note', undefined, 'unattended_release'),
      result('r1', 'x', 'run_script'),
    ] as never} />);
    expect(getByTestId('ai-unattended-release-note')).toBeTruthy();
    expect(toolCallCards.props.at(-1)).toMatchObject({ toolName: 'run_script', output: [] });
  });

  it('still renders an orphan result (no tool_use row) as its own card', () => {
    renderWithMessages([result('r1', 'gone')]);
    expect(toolCallCards.props).toHaveLength(1);
  });
});

/**
 * Wisp companion W01 (#10211, spec §4.2): prose replies with no avatar, a
 * name label on the first reply of a run, user bubbles, folded tool activity,
 * specialist run cards, time dividers, and the page/panel layouts.
 */
describe('chat kit units (Wisp companion W01)', () => {
  const T0 = new Date(2026, 9, 25, 9, 0);
  const atMin = (m: number) => new Date(T0.getTime() + m * 60_000);
  const u = (id: string, m = 0) => ({ id, role: 'user', content: `question ${id}`, createdAt: atMin(m) });
  const a = (id: string, content: string, m = 0, extra: Record<string, unknown> = {}) =>
    ({ id, role: 'assistant', content, createdAt: atMin(m), ...extra });
  const tu = (id: string, toolUseId: string, toolName = 'query_devices') =>
    ({ id, role: 'tool_use', content: '', toolName, toolUseId, toolInput: {}, createdAt: T0 });
  const tr = (id: string, toolUseId: string, toolName = 'query_devices', extra: Record<string, unknown> = {}) =>
    ({ id, role: 'tool_result', content: '[]', toolName, toolUseId, toolOutput: [], createdAt: T0, ...extra });
  const view = (messages: unknown[], props: Record<string, unknown> = {}) =>
    render(<AiChatMessages {...baseProps} messages={messages as never} {...props} />);

  beforeEach(() => {
    toolCallCards.props.length = 0;
    runCards.props.length = 0;
  });

  it('renders no avatar and labels the first assistant message of a run', () => {
    const { container, getAllByTestId, rerender } = view([u('u1'), a('a1', 'first'), a('a2', 'second')]);
    expect(container.querySelector('svg')).toBeNull();
    expect(getAllByTestId('ai-msg-label').map((n) => n.textContent)).toEqual(['Breeze AI']);
    expect(getAllByTestId('ai-msg-assistant')).toHaveLength(2);
    const bubble = getAllByTestId('ai-msg-user')[0] as HTMLElement;
    expect(bubble.textContent).toBe('question u1');
    expect(bubble.className).toContain('max-w-[75%]');
    expect(bubble.className).toContain('break-words');
    rerender(<AiChatMessages {...baseProps} messages={[u('u1'), a('a1', 'first')] as never} assistantLabel="Wisp" />);
    expect(getAllByTestId('ai-msg-label').map((n) => n.textContent)).toEqual(['Wisp']);
  });

  it('blank assistant rows are not rendered; a streaming one shows the caret', () => {
    const { getAllByTestId, getByTestId, rerender } = view([u('u1'), a('blank', '\n\n')]);
    expect(() => getAllByTestId('ai-msg-assistant')).toThrow();
    rerender(<AiChatMessages {...baseProps} messages={[u('u1'), a('live', '', 0, { isStreaming: true })] as never} />);
    expect(getAllByTestId('ai-msg-assistant')).toHaveLength(1);
    expect(getByTestId('ai-msg-caret')).toBeTruthy();
  });

  it('three tool rows render one ai-tool-group; a failed one is expanded and the assistant text after it still renders in order', () => {
    const { getAllByTestId, container } = view([
      u('u1'),
      tu('t1', 'a'), tr('r1', 'a'),
      a('pre', ' '),
      tu('t2', 'b', 'list_sites'), tr('r2', 'b', 'list_sites', { isError: true, toolOutput: { error: 'nope' } }),
      tu('t3', 'c', 'manage_alerts'), tr('r3', 'c', 'manage_alerts'),
      a('after', 'One check failed.'),
    ]);
    const groups = getAllByTestId('ai-tool-group');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.getAttribute('data-state')).toBe('failed');
    // Expanded: every call's own card renders inside the group.
    expect(toolCallCards.props.map((p) => p.toolName)).toEqual(['query_devices', 'list_sites', 'manage_alerts']);
    const order = Array.from(container.querySelectorAll('[data-testid="ai-msg-user"], [data-testid="ai-tool-group"], [data-testid="ai-msg-assistant"]'))
      .map((n) => n.getAttribute('data-testid'));
    expect(order).toEqual(['ai-msg-user', 'ai-tool-group', 'ai-msg-assistant']);
    expect(getAllByTestId('ai-msg-assistant')[0]?.textContent).toContain('One check failed.');
  });

  it('a successful group stays collapsed and renders no per-call card until opened', () => {
    const { getByTestId } = view([u('u1'), tu('t1', 'a'), tr('r1', 'a'), tu('t2', 'b', 'list_sites'), tr('r2', 'b', 'list_sites')]);
    expect(getByTestId('ai-tool-group').getAttribute('data-state')).toBe('done');
    expect(toolCallCards.props).toHaveLength(0);
    expandToolGroups();
    expect(toolCallCards.props.map((p) => p.toolName)).toEqual(['query_devices', 'list_sites']);
  });

  it('launch_specialist admitted result renders AiRunCard with its runId', () => {
    const RUN = '0b9a4c1e-2f3d-4a5b-8c6d-7e8f9a0b1c2d';
    const RUN_2 = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
    const launch = (id: string, runId: string) => [
      tu(id, id, 'launch_specialist'),
      tr(`r-${id}`, id, 'launch_specialist', { toolOutput: undefined, content: JSON.stringify({ admitted: true, runId }) }),
    ];
    const { getAllByTestId, queryByText, getByText, rerender } = view([u('u1'), ...launch('s1', RUN)]);
    expect(getAllByTestId('run-card-stub').map((n) => n.getAttribute('data-run-id'))).toEqual([RUN]);
    expect(runCards.props[0]).toMatchObject({ runId: RUN, initialStatus: 'queued' });
    expect(queryByText(/Handed to/)).toBeNull();
    rerender(<AiChatMessages {...baseProps} messages={[u('u1'), ...launch('s1', RUN), ...launch('s2', RUN_2)] as never} />);
    expect(getAllByTestId('run-card-stub').map((n) => n.getAttribute('data-run-id'))).toEqual([RUN, RUN_2]);
    expect(getByText('Handed to 2 specialists')).toBeTruthy();
  });

  it('a script proposal call stays a visible card so its link is never folded away (#7918)', () => {
    const PROPOSAL = '6f1c2a4e-8d3b-4c5a-9e7f-0a1b2c3d4e5f';
    const { getByTestId, queryByTestId } = view([
      tu('t1', 'p', 'propose_script'),
      tr('r1', 'p', 'propose_script', { toolOutput: { proposalId: PROPOSAL } }),
    ]);
    expect(queryByTestId('ai-tool-group')).toBeNull();
    expect(getByTestId('ai-script-proposal-link').getAttribute('href')).toBe(`/approvals#proposal-${PROPOSAL}`);
  });

  it('showTimeDividers inserts ai-chat-divider on a day change', () => {
    const nextDay = new Date(T0.getFullYear(), T0.getMonth(), T0.getDate() + 1, 8, 15);
    const { getAllByTestId } = view(
      [u('u1', 0), a('a1', 'hi', 1), { ...u('u2'), createdAt: nextDay }],
      { showTimeDividers: true, layout: 'page' },
    );
    const dividers = getAllByTestId('ai-chat-divider');
    expect(dividers).toHaveLength(2);
    expect(dividers[0]?.getAttribute('role')).toBe('separator');
    expect(dividers[1]?.textContent).toMatch(/8:15/);
  });

  it('a call that fails mid-stream opens its group in place, above the text that streams after it', () => {
    const pending = [u('u1'), tu('t1', 'a'), tu('t2', 'b', 'list_sites')];
    const { getByTestId, getAllByTestId, container, rerender } = view(pending);
    const before = getByTestId('ai-tool-group');
    expect(before.getAttribute('data-state')).toBe('executing');
    expect(toolCallCards.props).toHaveLength(0);
    rerender(<AiChatMessages {...baseProps} messages={[
      ...pending,
      tr('r1', 'a'),
      tr('r2', 'b', 'list_sites', { isError: true, toolOutput: { error: 'Site lookup refused' } }),
      a('after', 'One check failed', 0, { isStreaming: true }),
    ] as never} />);
    const after = getByTestId('ai-tool-group');
    // Same element: the group kept its instance (and any user toggle) when the results arrived.
    expect(after).toBe(before);
    expect(after.getAttribute('data-state')).toBe('failed');
    expect(after.textContent).toContain('1 failed');
    expect(toolCallCards.props.map((p) => p.toolName)).toEqual(expect.arrayContaining(['query_devices', 'list_sites']));
    const order = Array.from(container.querySelectorAll('[data-testid="ai-tool-group"], [data-testid="ai-msg-assistant"]'))
      .map((n) => n.getAttribute('data-testid'));
    expect(order).toEqual(['ai-tool-group', 'ai-msg-assistant']);
    expect(getAllByTestId('ai-msg-caret')).toHaveLength(1);
  });

  it('a failed run_script with a proposal keeps its proposal link visible without a click (#7918)', () => {
    const PROPOSAL = '6f1c2a4e-8d3b-4c5a-9e7f-0a1b2c3d4e5f';
    const { getByTestId, queryByTestId } = view([
      tu('t1', 'r', 'run_script'),
      tr('r1', 'r', 'run_script', { isError: true, toolOutput: { error: 'Device offline' } }),
    ].map((m, i) => (i === 0 ? { ...m, toolInput: { proposalId: PROPOSAL } } : m)));
    expect(queryByTestId('ai-tool-group')).toBeNull();
    expect(getByTestId('ai-script-proposal-link').getAttribute('href')).toBe(`/approvals#proposal-${PROPOSAL}`);
  });

  it('assistant prose breaks long unbroken words so a URL cannot widen the 400 px panel', () => {
    const { getByTestId } = view([u('u1'), a('a1', 'see https://example.com/' + 'x'.repeat(200))]);
    const prose = getByTestId('ai-msg-assistant').querySelector('.prose') as HTMLElement;
    expect(prose.className).toContain('break-words');
  });

  it('layout=panel has no max-w-3xl wrapper and no dividers', () => {
    // Dividers are opt-in per surface (showTimeDividers); the docked panel never
    // opts in (AiChatSidebar.wispHome.test pins that it passes no flag).
    const { container, queryAllByTestId } = view([u('u1', 0), u('u2', 90)]);
    expect(container.querySelector('.max-w-3xl')).toBeNull();
    expect(queryAllByTestId('ai-chat-divider')).toHaveLength(0);
    const page = view([u('u1', 0)], { layout: 'page' });
    expect(page.container.querySelector('.max-w-3xl')).not.toBeNull();
  });

  it('emptyState replaces the quick actions', () => {
    const { getByTestId, queryByText } = view([], { emptyState: <div data-testid="custom-empty">hello</div> });
    expect(getByTestId('custom-empty')).toBeTruthy();
    expect(queryByText('Check server health')).toBeNull();
  });

  it('without emptyState the quick actions still render', () => {
    const { getByText } = view([]);
    expect(getByText('Check server health')).toBeTruthy();
  });

  it('leading renders inside the scroll container before the first message', () => {
    const { container, getByTestId } = view([u('u1')], { leading: <article data-testid="lead">brief</article>, layout: 'page' });
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    const lead = getByTestId('lead');
    expect(scroller.contains(lead)).toBe(true);
    const first = getByTestId('ai-msg-user');
    expect(lead.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('leading still renders, above the empty state, when there are no messages yet', () => {
    const { getByTestId } = view([], { leading: <article data-testid="lead">brief</article>, emptyState: <div data-testid="custom-empty" /> });
    const lead = getByTestId('lead');
    expect(lead.compareDocumentPosition(getByTestId('custom-empty')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('timed extras and Load earlier (Wisp companion W02b)', () => {
  const T0 = new Date(2026, 9, 26, 9, 0);
  const atMin = (m: number) => new Date(T0.getTime() + m * 60_000);
  const u = (id: string, m: number) => ({ id, role: 'user', content: `question ${id}`, createdAt: atMin(m) });
  const a = (id: string, m: number) => ({ id, role: 'assistant', content: `answer ${id}`, createdAt: atMin(m) });
  const post = (id: string, m: number) => ({ id, at: atMin(m), render: () => <article data-testid={`post-${id}`}>post {id}</article> });
  const view = (messages: unknown[], props: Record<string, unknown> = {}) =>
    render(<AiChatMessages {...baseProps} messages={messages as never} {...props} />);

  let rafCallbacks: FrameRequestCallback[];
  beforeEach(() => {
    rafCallbacks = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      rafCallbacks[id - 1] = () => {};
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });
  const flushRaf = () => act(() => rafCallbacks.splice(0).forEach((cb) => cb(0)));

  it('renders an extra via its render fn in time order', () => {
    const { getByTestId } = view([u('u1', 0), a('a1', 5)], { extras: [post('p1', 2)] });
    const bubble = getByTestId('ai-msg-user');
    const p1 = getByTestId('post-p1');
    const reply = getByTestId('ai-msg-assistant');
    expect(bubble.compareDocumentPosition(p1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(p1.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('extras without messages render instead of the empty state', () => {
    const { getByTestId, queryByText } = view([], { extras: [post('p1', 0)] });
    expect(getByTestId('post-p1')).toBeTruthy();
    expect(queryByText('Check server health')).toBeNull();
  });

  it('Load earlier renders above leading only with hasEarlier and a handler, and calls it', () => {
    const onLoadEarlier = vi.fn();
    const { getByTestId, queryByTestId, rerender } = view([u('u1', 0)], {
      hasEarlier: true, onLoadEarlier, leading: <article data-testid="lead">lead</article>,
    });
    const button = getByTestId('ai-chat-load-earlier');
    expect(button.textContent).toBe('Load earlier');
    expect(button.compareDocumentPosition(getByTestId('lead')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(button);
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);

    rerender(<AiChatMessages {...baseProps} messages={[u('u1', 0)] as never} hasEarlier onLoadEarlier={onLoadEarlier} loadingEarlier />);
    expect(getByTestId('ai-chat-load-earlier')).toBeDisabled();
    expect(getByTestId('ai-chat-load-earlier')).toHaveAttribute('aria-busy', 'true');

    rerender(<AiChatMessages {...baseProps} messages={[u('u1', 0)] as never} hasEarlier={false} onLoadEarlier={onLoadEarlier} />);
    expect(queryByTestId('ai-chat-load-earlier')).toBeNull();
    rerender(<AiChatMessages {...baseProps} messages={[u('u1', 0)] as never} hasEarlier />);
    expect(queryByTestId('ai-chat-load-earlier')).toBeNull();
  });

  it('a prepend keeps the viewport anchored: scrollTop moves by the height delta, never to the bottom', () => {
    const onLoadEarlier = vi.fn();
    const newer = [u('u2', 30), a('a2', 31)];
    const { getByTestId, rerender } = view(newer, { hasEarlier: true, onLoadEarlier });
    flushRaf();
    const el = container(document.body);
    // Reading at the top, where the button is.
    stampGeometry(el, { scrollHeight: 1000, clientHeight: 300, scrollTop: 0 });
    fireEvent.scroll(el);
    fireEvent.click(getByTestId('ai-chat-load-earlier'));
    rerender(<AiChatMessages {...baseProps} messages={newer as never} hasEarlier onLoadEarlier={onLoadEarlier} loadingEarlier />);

    // The older page lands: 600 px of content above what the reader was looking at.
    stampGeometry(el, { scrollHeight: 1600, clientHeight: 300, scrollTop: 0 });
    rerender(
      <AiChatMessages
        {...baseProps}
        messages={[u('u1', 0), a('a1', 1), ...newer] as never}
        extras={[post('p0', -5)]}
        hasEarlier={false}
        onLoadEarlier={onLoadEarlier}
      />,
    );
    expect(el.scrollTop).toBe(600);
    flushRaf();
    expect(el.scrollTop).toBe(600);
  });

  it('a prepend on a short (pinned) thread is anchored too, and the next append still follows the bottom', () => {
    const onLoadEarlier = vi.fn();
    const newer = [u('u2', 30)];
    const { getByTestId, rerender } = view(newer, { hasEarlier: true, onLoadEarlier });
    flushRaf();
    const el = container(document.body);
    stampGeometry(el, { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 });
    fireEvent.scroll(el);
    fireEvent.click(getByTestId('ai-chat-load-earlier'));

    stampGeometry(el, { scrollHeight: 1600, clientHeight: 300, scrollTop: 700 });
    const all = [u('u1', 0), ...newer];
    rerender(<AiChatMessages {...baseProps} messages={all as never} hasEarlier onLoadEarlier={onLoadEarlier} />);
    flushRaf();
    // 700 + 600, not the auto-scroll's scrollHeight (1600).
    expect(el.scrollTop).toBe(1300);

    fireEvent.scroll(el);
    stampGeometry(el, { scrollHeight: 1800, clientHeight: 300, scrollTop: 1300 });
    rerender(<AiChatMessages {...baseProps} messages={[...all, a('a2', 31)] as never} hasEarlier onLoadEarlier={onLoadEarlier} />);
    flushRaf();
    expect(el.scrollTop).toBe(1800);
  });

  it('a load started without the button (a Retry elsewhere) is anchored too', () => {
    const onLoadEarlier = vi.fn();
    const newer = [u('u2', 30)];
    const { rerender } = view(newer, { hasEarlier: true, onLoadEarlier });
    flushRaf();
    const el = container(document.body);
    stampGeometry(el, { scrollHeight: 1000, clientHeight: 300, scrollTop: 120 });
    fireEvent.scroll(el);
    // The host starts the load itself: no click on ai-chat-load-earlier.
    rerender(<AiChatMessages {...baseProps} messages={newer as never} hasEarlier onLoadEarlier={onLoadEarlier} loadingEarlier />);
    stampGeometry(el, { scrollHeight: 1400, clientHeight: 300, scrollTop: 120 });
    rerender(<AiChatMessages {...baseProps} messages={[u('u1', 0), ...newer] as never} hasEarlier onLoadEarlier={onLoadEarlier} />);
    expect(el.scrollTop).toBe(520);
    expect(onLoadEarlier).not.toHaveBeenCalled();
  });

  it('a load that adds nothing leaves no stale anchor behind', () => {
    const onLoadEarlier = vi.fn();
    const newer = [u('u2', 30)];
    const { getByTestId, rerender } = view(newer, { hasEarlier: true, onLoadEarlier });
    flushRaf();
    const el = container(document.body);
    stampGeometry(el, { scrollHeight: 1000, clientHeight: 300, scrollTop: 0 });
    fireEvent.scroll(el);
    fireEvent.click(getByTestId('ai-chat-load-earlier'));
    rerender(<AiChatMessages {...baseProps} messages={newer as never} hasEarlier onLoadEarlier={onLoadEarlier} loadingEarlier />);
    // The fetch failed: loading ends with nothing prepended.
    rerender(<AiChatMessages {...baseProps} messages={newer as never} hasEarlier onLoadEarlier={onLoadEarlier} />);
    // Later the thread is replaced wholesale (a rebind): no stale anchor shifts it.
    stampGeometry(el, { scrollHeight: 1600, clientHeight: 300, scrollTop: 0 });
    rerender(<AiChatMessages {...baseProps} messages={[u('u0', -60), ...newer] as never} hasEarlier onLoadEarlier={onLoadEarlier} />);
    expect(el.scrollTop).toBe(0);
  });
});
