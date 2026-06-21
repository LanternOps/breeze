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
vi.mock('./AiApprovalDialog', () => ({ default: () => null }));
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
});
