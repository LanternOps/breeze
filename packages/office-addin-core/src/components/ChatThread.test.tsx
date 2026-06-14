import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ChatThread } from './ChatThread';
import type { ChatState } from '../chat/chatController';

afterEach(cleanup);

function baseState(overrides: Partial<ChatState> = {}): ChatState {
  return {
    thread: [],
    streamingText: '',
    busy: false,
    banner: null,
    draft: '',
    contextKind: 'selection',
    usage: null,
    writeApproval: 'ask',
    autoApply: false,
    flagged: false,
    ...overrides,
  };
}

function renderThread(state: ChatState) {
  return render(
    <ChatThread
      state={state}
      approvals={[]}
      onApply={() => {}}
      onReject={() => {}}
      onDismissBanner={() => {}}
    />,
  );
}

describe('ChatThread markdown rendering', () => {
  it('renders an assistant message as markdown (bold + list)', () => {
    const { container } = renderThread(
      baseState({
        thread: [
          { kind: 'assistant', id: 1, text: 'Here is **bold** and:\n- one\n- two' },
        ],
      }),
    );
    const msg = container.querySelector('[data-testid="assistant-message"]');
    expect(msg).toBeTruthy();
    expect(msg?.querySelector('strong')?.textContent).toBe('bold');
    expect(msg?.querySelectorAll('li')).toHaveLength(2);
  });

  it('keeps a user message as plain text (no markdown parsing)', () => {
    const { container } = renderThread(
      baseState({
        thread: [{ kind: 'user', id: 1, text: 'send me **literally** this' }],
      }),
    );
    // user bubble should contain the raw asterisks, not a <strong>
    expect(container.querySelector('strong')).toBeNull();
    expect(container.textContent).toContain('**literally**');
  });

  it('sanitizes script injection in an assistant message', () => {
    const { container } = renderThread(
      baseState({
        thread: [
          { kind: 'assistant', id: 1, text: 'ok <script>window.__x=1</script>' },
        ],
      }),
    );
    expect(container.querySelector('script')).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((window as any).__x).toBeUndefined();
  });

  it('renders streaming text as markdown without crashing on partial input', () => {
    const { container } = renderThread(
      baseState({ streamingText: 'Generating **the rep' }),
    );
    const streaming = container.querySelector('[data-testid="streaming-message"]');
    expect(streaming).toBeTruthy();
    // cursor still present
    expect(streaming?.textContent).toContain('▍');
  });
});
