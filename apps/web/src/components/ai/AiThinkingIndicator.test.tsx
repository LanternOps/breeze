import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AiThinkingIndicator from './AiThinkingIndicator';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('AiThinkingIndicator', () => {
  it('renders nothing when not thinking', () => {
    const { container } = render(<AiThinkingIndicator thinking={false} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('shows "Thinking…" with elapsed seconds (never a silent pause)', () => {
    render(<AiThinkingIndicator thinking />);
    expect(screen.getByTestId('ai-thinking-indicator').textContent).toContain('Thinking');
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByTestId('ai-thinking-indicator').textContent).toContain('3');
  });
});
