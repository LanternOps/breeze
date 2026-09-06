import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ModeChoice from './ModeChoice';

function setup(overrides: Partial<Parameters<typeof ModeChoice>[0]> = {}) {
  const onChange = vi.fn();
  const onActAckChange = vi.fn();
  const props = {
    mode: 'shadow' as const,
    onChange,
    actSupported: true,
    enteringActMode: false,
    actAck: false,
    onActAckChange,
    actKeysWillBeOmitted: false,
    ...overrides,
  };
  render(<ModeChoice {...props} />);
  return { onChange, onActAckChange };
}

describe('ModeChoice (Task 13, #5051 — extracted from AiAgentForm)', () => {
  it('renders the three-option radiogroup and reports a click as onChange', () => {
    const { onChange } = setup();
    expect(screen.getByTestId('ai-agent-mode-shadow')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByTestId('ai-agent-mode-act'));
    expect(onChange).toHaveBeenCalledWith('act');
  });

  it('disables the act card and explains why when actSupported is false', () => {
    setup({ actSupported: false });
    expect(screen.getByTestId('ai-agent-mode-act')).toBeDisabled();
    expect(screen.getByTestId('ai-agent-mode-act-unavailable')).toBeInTheDocument();
  });

  it('shows the act warning only in act mode, and the acknowledgement only when entering it', () => {
    const { rerender } = render(
      <ModeChoice mode="shadow" onChange={vi.fn()} actSupported enteringActMode={false} actAck={false} onActAckChange={vi.fn()} actKeysWillBeOmitted={false} />,
    );
    expect(screen.queryByTestId('ai-agent-act-warning')).toBeNull();

    rerender(
      <ModeChoice mode="act" onChange={vi.fn()} actSupported enteringActMode={false} actAck={false} onActAckChange={vi.fn()} actKeysWillBeOmitted={false} />,
    );
    expect(screen.getByTestId('ai-agent-act-warning')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-agent-act-ack')).toBeNull();

    rerender(
      <ModeChoice mode="act" onChange={vi.fn()} actSupported enteringActMode actAck={false} onActAckChange={vi.fn()} actKeysWillBeOmitted={false} />,
    );
    expect(screen.getByTestId('ai-agent-act-ack')).not.toBeChecked();
  });

  it('resets the acknowledgement (onActAckChange(false)) when leaving act mode', () => {
    const { onActAckChange, onChange } = setup({ mode: 'act', actAck: true });
    fireEvent.click(screen.getByTestId('ai-agent-mode-shadow'));
    expect(onActAckChange).toHaveBeenCalledWith(false);
    expect(onChange).toHaveBeenCalledWith('shadow');
  });

  it('does not touch the acknowledgement when entering act mode', () => {
    const { onActAckChange } = setup({ mode: 'off' });
    fireEvent.click(screen.getByTestId('ai-agent-mode-act'));
    expect(onActAckChange).not.toHaveBeenCalled();
  });

  it('mounts the act-keys status region unconditionally, gating only its text', () => {
    const { rerender } = render(
      <ModeChoice mode="shadow" onChange={vi.fn()} actSupported enteringActMode={false} actAck={false} onActAckChange={vi.fn()} actKeysWillBeOmitted={false} />,
    );
    expect(screen.getByTestId('ai-agent-act-keys-cleared')).toHaveTextContent('');

    rerender(
      <ModeChoice mode="shadow" onChange={vi.fn()} actSupported enteringActMode={false} actAck={false} onActAckChange={vi.fn()} actKeysWillBeOmitted />,
    );
    expect(screen.getByTestId('ai-agent-act-keys-cleared').textContent).not.toBe('');
  });

  it('moves the roving tab stop and selection with arrow keys, wrapping at both ends', () => {
    const { onChange } = setup({ mode: 'off' });
    const offCard = screen.getByTestId('ai-agent-mode-off');
    fireEvent.keyDown(offCard, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledWith('act'); // wraps backward from the first option
  });

  it('falls back the roving tab stop to the first enabled option when the checked option is itself disabled', () => {
    setup({ mode: 'act', actSupported: false });
    expect(screen.getByTestId('ai-agent-mode-off')).toHaveAttribute('tabindex', '0');
    expect(screen.getByTestId('ai-agent-mode-act')).toHaveAttribute('tabindex', '-1');
  });
});
