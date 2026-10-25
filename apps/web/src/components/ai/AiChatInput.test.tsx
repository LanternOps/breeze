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
});
