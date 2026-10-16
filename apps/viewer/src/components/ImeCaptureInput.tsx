// Hidden composition input (W06, #8242). IME and dead-key composition only
// happen in a focused editable element, so while "Type what I see" capture is
// on, keyboard focus sits here instead of on the <video>. Key events are
// handed to the viewer's normal handlers; composition and beforeinput go to
// the CompositionCapture state machine, which decides what is sent as text.
//
// beforeinput is bound natively: React's onBeforeInput is a keypress/textInput
// polyfill without inputType, which the dedupe needs.

import { forwardRef, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { CompositionCapture } from '../lib/compositionCapture';

interface Props {
  capture: CompositionCapture;
  onKeyDown?: (e: ReactKeyboardEvent) => void;
  onKeyUp?: (e: ReactKeyboardEvent) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

export const ImeCaptureInput = forwardRef<HTMLTextAreaElement, Props>(function ImeCaptureInput(
  { capture, onKeyDown, onKeyUp, onFocus, onBlur },
  ref,
) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = localRef.current;
    if (!el) return;
    const clear = () => { el.value = ''; };
    const onCompositionStart = () => capture.compositionStart();
    const onCompositionEnd = (e: CompositionEvent) => {
      capture.compositionEnd(e.data);
      clear();
    };
    const onBeforeInput = (e: Event) => {
      const ie = e as InputEvent;
      if (capture.beforeInput(ie.inputType ?? '', ie.data ?? null, ie.isComposing ?? false).preventDefault) {
        e.preventDefault();
      }
    };
    // Belt and braces: anything that still landed outside a composition is
    // cleared so the input never accumulates text.
    const onInput = (e: Event) => {
      if (!(e as InputEvent).isComposing && !capture.composing()) clear();
    };
    el.addEventListener('compositionstart', onCompositionStart);
    el.addEventListener('compositionend', onCompositionEnd);
    el.addEventListener('beforeinput', onBeforeInput);
    el.addEventListener('input', onInput);
    return () => {
      el.removeEventListener('compositionstart', onCompositionStart);
      el.removeEventListener('compositionend', onCompositionEnd);
      el.removeEventListener('beforeinput', onBeforeInput);
      el.removeEventListener('input', onInput);
    };
  }, [capture]);

  return (
    <textarea
      ref={(el) => {
        localRef.current = el;
        if (typeof ref === 'function') ref(el);
        else if (ref) ref.current = el;
      }}
      data-testid="ime-capture"
      aria-label="Keyboard input to the remote computer"
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      tabIndex={-1}
      rows={1}
      // Kept on-screen (bottom-left of the view) so the OS places the IME
      // candidate window there; invisible and click-through.
      className="absolute left-2 bottom-2 w-px h-px p-0 m-0 border-0 opacity-0 resize-none overflow-hidden pointer-events-none"
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onFocus={onFocus}
      onBlur={onBlur}
    />
  );
});
