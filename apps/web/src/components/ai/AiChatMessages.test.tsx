import { fireEvent, render } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AiChatMessages from './AiChatMessages';

// The streamed-content children are irrelevant to scroll-anchoring behavior.
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: () => {} }));
vi.mock('./AiToolCallCard', () => ({ default: () => null }));

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

function renderWithMessages(messages: Msg[]) {
  return render(<AiChatMessages {...baseProps} messages={messages as never} />);
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
