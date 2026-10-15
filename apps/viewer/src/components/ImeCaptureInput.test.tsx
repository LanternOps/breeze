import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ImeCaptureInput } from './ImeCaptureInput';
import { CompositionCapture } from '../lib/compositionCapture';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(enabled = true) {
  const sent: string[] = [];
  const capture = new CompositionCapture({ sendText: (t) => sent.push(t), enabled: () => enabled });
  const onKeyDown = vi.fn();
  const ref = createRef<HTMLTextAreaElement>();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<ImeCaptureInput ref={ref} capture={capture} onKeyDown={onKeyDown} />);
  });
  return { el: ref.current!, sent, onKeyDown };
}

function beforeInput(el: HTMLElement, inputType: string, data: string | null, isComposing = false) {
  const ev = new InputEvent('beforeinput', { inputType, data, isComposing, cancelable: true, bubbles: true });
  el.dispatchEvent(ev);
  return ev;
}

describe('ImeCaptureInput', () => {
  it('renders a hidden, focusable textarea that is not announced as a text box to fill', () => {
    const { el } = render();
    expect(el.tagName).toBe('TEXTAREA');
    expect(el.getAttribute('data-testid')).toBe('ime-capture');
    expect(el.getAttribute('autocomplete')).toBe('off');
    expect(el.getAttribute('spellcheck')).toBe('false');
  });

  it('sends a committed composition once and clears the input', () => {
    const { el, sent } = render();
    el.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    el.value = 'にほん';
    expect(beforeInput(el, 'insertCompositionText', 'にほん', true).defaultPrevented).toBe(false);
    el.dispatchEvent(new CompositionEvent('compositionend', { data: '日本' }));
    expect(beforeInput(el, 'insertFromComposition', '日本').defaultPrevented).toBe(true);
    expect(sent).toEqual(['日本']);
    expect(el.value).toBe('');
  });

  it('sends a dead-key insertText and prevents it landing in the input', () => {
    const { el, sent } = render();
    const ev = beforeInput(el, 'insertText', 'é');
    expect(ev.defaultPrevented).toBe(true);
    expect(sent).toEqual(['é']);
  });

  it('clears anything that still landed in the input after a non-composing input event', () => {
    const { el } = render();
    el.value = 'x';
    el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'x', isComposing: false, bubbles: true }));
    expect(el.value).toBe('');
  });

  it('passes key events to the viewer handlers', () => {
    const { el, onKeyDown } = render();
    act(() => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }));
    });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when capture is disabled', () => {
    const { el, sent } = render(false);
    el.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    el.dispatchEvent(new CompositionEvent('compositionend', { data: '日本' }));
    beforeInput(el, 'insertText', 'é');
    expect(sent).toEqual([]);
  });
});
