import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { KeyboardModeControl } from './KeyboardModeControl';
import { keyboardModeSupport, type KeyboardMode } from '../lib/keyboardMode';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(props: {
  mode: KeyboardMode;
  keyCodes?: boolean;
  transport?: 'webrtc' | 'websocket' | 'vnc';
  disabled?: boolean;
}) {
  const onChange = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const support = keyboardModeSupport({
    transport: props.transport ?? 'webrtc',
    keyCodes: props.keyCodes ?? true,
    typeText: true,
  });
  act(() => {
    root!.render(
      <KeyboardModeControl mode={props.mode} support={support} disabled={props.disabled} onChange={onChange} />,
    );
  });
  return { onChange };
}

const q = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);

function open() {
  act(() => q('keyboard-mode')!.click());
}

describe('KeyboardModeControl', () => {
  it('shows the current mode on the toolbar button', () => {
    render({ mode: 'text' });
    expect(q('keyboard-mode')!.textContent).toContain('Type what I see');
    act(() => root!.unmount());
    root = null;
    render({ mode: 'physical' });
    expect(q('keyboard-mode')!.textContent).toContain('Physical keys');
  });

  it('switches mode from the menu', () => {
    const { onChange } = render({ mode: 'text' });
    open();
    expect(q('keyboard-mode-text')!.getAttribute('aria-checked')).toBe('true');
    act(() => q('keyboard-mode-physical')!.click());
    expect(onChange).toHaveBeenCalledWith('physical');
  });

  it('disables Physical with an explanation when the agent lacks key codes', () => {
    const { onChange } = render({ mode: 'text', keyCodes: false });
    open();
    const physical = q('keyboard-mode-physical')!;
    expect(physical.disabled).toBe(true);
    expect(physical.title).toMatch(/agent/i);
    act(() => physical.click());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('is not shown for VNC, where keyboard mode does not apply', () => {
    render({ mode: 'text', transport: 'vnc' });
    expect(q('keyboard-mode')).toBeNull();
  });

  it('is disabled in view-only mode', () => {
    render({ mode: 'text', disabled: true });
    expect(q('keyboard-mode')!.disabled).toBe(true);
  });
});
