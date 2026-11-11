/**
 * #9840 W2 (Task 10): the side-panel composer's text can live in aiStore
 * (`composerDraft`) so a refused send can put it back and a move can carry it.
 * Controlled when `value`/`onValueChange` are passed; uncontrolled otherwise
 * (the workspace composer keeps working unchanged until W3).
 */
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AiChatInput from './AiChatInput';

const textbox = () => screen.getByRole('textbox') as HTMLTextAreaElement;
const sendButton = (container: HTMLElement) => container.querySelector('button') as HTMLButtonElement;

describe('AiChatInput', () => {
  it('uncontrolled: typing and submitting sends the text and clears the box', () => {
    const onSend = vi.fn();
    const { container } = render(<AiChatInput onSend={onSend} />);
    fireEvent.change(textbox(), { target: { value: 'hello' } });
    fireEvent.click(sendButton(container));
    expect(onSend).toHaveBeenCalledWith('hello');
    expect(textbox().value).toBe('');
  });

  it('controlled: typing calls onValueChange and renders only the value it is given', () => {
    const onValueChange = vi.fn();
    render(<AiChatInput onSend={vi.fn()} value="draft" onValueChange={onValueChange} />);
    expect(textbox().value).toBe('draft');
    fireEvent.change(textbox(), { target: { value: 'draft!' } });
    expect(onValueChange).toHaveBeenCalledWith('draft!');
    expect(textbox().value).toBe('draft');
  });

  it('controlled: an external value change renders (a refused send restores its text)', () => {
    const { rerender } = render(<AiChatInput onSend={vi.fn()} value="" onValueChange={vi.fn()} />);
    expect(textbox().value).toBe('');
    rerender(<AiChatInput onSend={vi.fn()} value="the refused text" onValueChange={vi.fn()} />);
    expect(textbox().value).toBe('the refused text');
  });

  it('controlled: submit sends the trimmed value and clears it through onValueChange', () => {
    const onSend = vi.fn();
    const seen: string[] = [];
    function Harness() {
      const [v, setV] = useState('  ask this  ');
      return <AiChatInput onSend={onSend} value={v} onValueChange={(next) => { seen.push(next); setV(next); }} />;
    }
    const { container } = render(<Harness />);
    fireEvent.click(sendButton(container));
    expect(onSend).toHaveBeenCalledWith('ask this');
    expect(seen).toEqual(['']);
    expect(textbox().value).toBe('');
  });

  // #9840 W5: the E2E locates the composer by data-testid, scoped under its
  // surface root (the component renders in the panel and in every tab).
  it('the textarea, send and stop controls carry their test ids', () => {
    const onSend = vi.fn();
    const onInterrupt = vi.fn();
    const { rerender } = render(<AiChatInput onSend={onSend} />);
    expect(screen.getByTestId('ai-chat-input')).toBe(textbox());
    fireEvent.change(screen.getByTestId('ai-chat-input'), { target: { value: 'hi' } });
    fireEvent.click(screen.getByTestId('ai-chat-send'));
    expect(onSend).toHaveBeenCalledWith('hi');
    expect(screen.queryByTestId('ai-chat-stop')).toBeNull();
    rerender(<AiChatInput onSend={onSend} isStreaming onInterrupt={onInterrupt} />);
    expect(screen.queryByTestId('ai-chat-send')).toBeNull();
    fireEvent.click(screen.getByTestId('ai-chat-stop'));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });
});

/**
 * Wisp companion W01 (#10211, spec §4.1): Enter sends, Shift+Enter is a
 * newline, Cmd/Ctrl+Enter still sends, and an IME composition Enter (a
 * Japanese or Chinese user confirming a candidate) never sends.
 */
describe('AiChatInput composer keys', () => {
  const type = (value: string) => fireEvent.change(textbox(), { target: { value } });

  it('Enter sends and clears', () => {
    const onSend = vi.fn();
    render(<AiChatInput onSend={onSend} />);
    type('status of acme');
    const notPrevented = fireEvent.keyDown(textbox(), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('status of acme');
    expect(textbox().value).toBe('');
    // The newline the browser would insert is suppressed.
    expect(notPrevented).toBe(false);
  });

  it('Shift+Enter does not send', () => {
    const onSend = vi.fn();
    render(<AiChatInput onSend={onSend} />);
    type('line one');
    const notPrevented = fireEvent.keyDown(textbox(), { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(textbox().value).toBe('line one');
    expect(notPrevented).toBe(true);
  });

  it('Enter during IME composition does not send', () => {
    const onSend = vi.fn();
    render(<AiChatInput onSend={onSend} />);
    type('にほんご');
    fireEvent.keyDown(textbox(), { key: 'Enter', isComposing: true });
    // Safari reports the confirming Enter as keyCode 229 with isComposing false.
    fireEvent.keyDown(textbox(), { key: 'Enter', keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
    expect(textbox().value).toBe('にほんご');
  });

  it('Cmd+Enter and Ctrl+Enter still send', () => {
    const onSend = vi.fn();
    render(<AiChatInput onSend={onSend} />);
    type('one');
    fireEvent.keyDown(textbox(), { key: 'Enter', metaKey: true });
    type('two');
    fireEvent.keyDown(textbox(), { key: 'Enter', ctrlKey: true });
    expect(onSend.mock.calls).toEqual([['one'], ['two']]);
  });

  it('Enter while streaming does not send', () => {
    const onSend = vi.fn();
    render(<AiChatInput onSend={onSend} isStreaming value="queued" onValueChange={vi.fn()} />);
    fireEvent.keyDown(textbox(), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('placeholder prop wins, and the waiting copy shows while streaming', () => {
    const { rerender } = render(<AiChatInput onSend={vi.fn()} placeholder="Message Wisp" />);
    expect(textbox().placeholder).toBe('Message Wisp');
    rerender(<AiChatInput onSend={vi.fn()} placeholder="Message Wisp" isStreaming />);
    expect(textbox().placeholder).toBe('Waiting for response...');
  });

  it('leftSlot renders before the textarea', () => {
    render(<AiChatInput onSend={vi.fn()} leftSlot={<button type="button" data-testid="slot">+</button>} />);
    const slot = screen.getByTestId('slot');
    expect(slot.compareDocumentPosition(textbox()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the textarea draws no border of its own (the rounded field is the border)', () => {
    render(<AiChatInput onSend={vi.fn()} />);
    expect(textbox().className).toMatch(/(^|\s)border-0(\s|$)/);
    expect(textbox().className).toContain('focus:ring-0');
  });

  it('no shortcut hint text is rendered', () => {
    const { container, rerender } = render(<AiChatInput onSend={vi.fn()} />);
    expect(container.textContent).not.toMatch(/Cmd\+Enter|to send/);
    rerender(<AiChatInput onSend={vi.fn()} isStreaming />);
    expect(container.textContent).not.toMatch(/thinking/i);
  });

  it('send and stop buttons carry accessible names', () => {
    const { rerender } = render(<AiChatInput onSend={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy();
    rerender(<AiChatInput onSend={vi.fn()} isStreaming onInterrupt={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Stop response' })).toBeTruthy();
  });
});

it('focuses a requested composer after loading completes without sending', () => {
  const send = vi.fn();
  const view = render(<AiChatInput onSend={send} focusRequest={1} disabled value="About Printer: " onValueChange={vi.fn()} />);
  expect(screen.getByTestId('ai-chat-input')).not.toHaveFocus();
  view.rerender(<AiChatInput onSend={send} focusRequest={1} value="About Printer: " onValueChange={vi.fn()} />);
  expect(screen.getByTestId('ai-chat-input')).toHaveFocus();
  expect(send).not.toHaveBeenCalled();
});
