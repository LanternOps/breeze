import { describe, it, expect, vi } from 'vitest';
import { CompositionCapture, deliverComposedText, type CaptureKeyEvent } from './compositionCapture';

function key(partial: Partial<CaptureKeyEvent> & { key: string; code: string }): CaptureKeyEvent {
  return { keyCode: 0, isComposing: false, ctrlKey: false, altKey: false, metaKey: false, ...partial };
}

function setup(enabled = true) {
  const sent: string[] = [];
  const dropped: string[] = [];
  let on = enabled;
  const capture = new CompositionCapture({
    sendText: (t) => sent.push(t),
    enabled: () => on,
    onDropped: (reason) => dropped.push(reason),
  });
  return { capture, sent, dropped, setEnabled: (v: boolean) => { on = v; } };
}

describe('CompositionCapture: disabled', () => {
  it('forwards every key and never touches beforeinput when capture is off', () => {
    const { capture, sent } = setup(false);
    expect(capture.keyDown(key({ key: 'Dead', code: 'Quote' }))).toBe('forward');
    expect(capture.keyDown(key({ key: 'Process', code: 'KeyA', keyCode: 229 }))).toBe('forward');
    expect(capture.keyUp(key({ key: 'Dead', code: 'Quote' }))).toBe('forward');
    capture.compositionStart();
    capture.compositionEnd('日本');
    expect(capture.beforeInput('insertText', 'é', false)).toEqual({ preventDefault: true });
    expect(sent).toEqual([]);
  });
});

describe('CompositionCapture: plain keys stay on the key path', () => {
  it('forwards printable, chord and non-printable keys', () => {
    const { capture, sent } = setup();
    expect(capture.keyDown(key({ key: 'a', code: 'KeyA', keyCode: 65 }))).toBe('forward');
    expect(capture.keyDown(key({ key: 'ö', code: 'Semicolon', keyCode: 192 }))).toBe('forward');
    expect(capture.keyDown(key({ key: 'c', code: 'KeyC', ctrlKey: true }))).toBe('forward');
    expect(capture.keyDown(key({ key: 'Enter', code: 'Enter', keyCode: 13 }))).toBe('forward');
    expect(capture.keyUp(key({ key: 'a', code: 'KeyA' }))).toBe('forward');
    expect(sent).toEqual([]);
  });
});

describe('CompositionCapture: IME', () => {
  it('sends the committed text once and suppresses every key of the composition', () => {
    const { capture, sent } = setup();
    // Chromium: the key that opens the composition reports keyCode 229 before compositionstart.
    expect(capture.keyDown(key({ key: 'Process', code: 'KeyN', keyCode: 229 }))).toBe('capture');
    capture.compositionStart();
    expect(capture.beforeInput('insertCompositionText', 'ｎ', true)).toEqual({ preventDefault: false });
    expect(capture.keyUp(key({ key: 'n', code: 'KeyN', keyCode: 229, isComposing: true }))).toBe('suppress');
    expect(capture.keyDown(key({ key: 'Process', code: 'KeyI', keyCode: 229, isComposing: true }))).toBe('capture');
    expect(capture.keyUp(key({ key: 'i', code: 'KeyI', isComposing: true }))).toBe('suppress');
    expect(capture.keyDown(key({ key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true }))).toBe('capture');
    capture.compositionEnd('に');
    // The Enter that committed the composition must not reach the remote either.
    expect(capture.keyUp(key({ key: 'Enter', code: 'Enter' }))).toBe('suppress');
    expect(sent).toEqual(['に']);
  });

  it('a cancelled or empty composition sends nothing', () => {
    const { capture, sent } = setup();
    capture.compositionStart();
    capture.compositionEnd('');
    capture.compositionStart();
    capture.compositionEnd(undefined);
    expect(sent).toEqual([]);
  });

  it('dedupes insertFromComposition against compositionend in either order', () => {
    const { capture, sent } = setup();
    capture.compositionStart();
    capture.compositionEnd('漢字');
    expect(capture.beforeInput('insertFromComposition', '漢字', false)).toEqual({ preventDefault: true });
    expect(sent).toEqual(['漢字']);

    // WebKit can report the insertion before compositionend.
    capture.keyDown(key({ key: 'a', code: 'KeyA', keyCode: 65 }));
    capture.compositionStart();
    expect(capture.beforeInput('insertFromComposition', 'かな', false)).toEqual({ preventDefault: false });
    capture.compositionEnd('かな');
    expect(sent).toEqual(['漢字', 'かな']);
  });

  it('does not let an insertText right after compositionend double-send the commit', () => {
    const { capture, sent } = setup();
    capture.compositionStart();
    capture.compositionEnd('é');
    capture.beforeInput('insertText', 'é', false);
    expect(sent).toEqual(['é']);
  });

  it('suppresses a modifier pressed during the composition, both edges', () => {
    const { capture } = setup();
    capture.compositionStart();
    expect(capture.keyDown(key({ key: 'Shift', code: 'ShiftLeft', isComposing: true }))).toBe('capture');
    capture.compositionEnd('ア');
    expect(capture.keyUp(key({ key: 'Shift', code: 'ShiftLeft' }))).toBe('suppress');
  });

  it('forwards the release of a key pressed BEFORE the composition began', () => {
    // Never drop a modifier release: Shift went down on the remote first.
    const { capture } = setup();
    expect(capture.keyDown(key({ key: 'Shift', code: 'ShiftLeft' }))).toBe('forward');
    capture.compositionStart();
    expect(capture.keyUp(key({ key: 'Shift', code: 'ShiftLeft', isComposing: true }))).toBe('forward');
    capture.compositionEnd('');
  });
});

describe('CompositionCapture: held keys and repeats (review fixes)', () => {
  it('a forwarded key that auto-repeats inside a composition keeps its release', () => {
    const { capture } = setup();
    expect(capture.keyDown(key({ key: 'Shift', code: 'ShiftLeft' }))).toBe('forward');
    capture.compositionStart();
    // The repeat is not sent again, but it must not mark the key as captured.
    expect(capture.keyDown(key({ key: 'Shift', code: 'ShiftLeft', isComposing: true }))).toBe('capture');
    capture.compositionEnd('あ');
    expect(capture.keyUp(key({ key: 'Shift', code: 'ShiftLeft' }))).toBe('forward');
  });

  it('the same dead-key character typed twice is sent twice', () => {
    const { capture, sent } = setup();
    for (let i = 0; i < 2; i++) {
      capture.keyDown(key({ key: 'Dead', code: 'Quote' }));
      capture.keyDown(key({ key: 'é', code: 'KeyE' }));
      capture.beforeInput('insertText', 'é', false);
      capture.keyUp(key({ key: 'e', code: 'KeyE' }));
      capture.keyUp(key({ key: 'Dead', code: 'Quote' }));
    }
    expect(sent).toEqual(['é', 'é']);
  });

  it('two IME commits of the same text are both sent', () => {
    const { capture, sent } = setup();
    capture.compositionStart();
    capture.compositionEnd('はい');
    capture.compositionStart();
    capture.compositionEnd('はい');
    expect(sent).toEqual(['はい', 'はい']);
  });
});

describe('CompositionCapture: dropped text is reported, never silent (review fix)', () => {
  it('a commit that arrives after capture was switched off is reported', () => {
    const { capture, sent, dropped, setEnabled } = setup();
    capture.compositionStart();
    setEnabled(false);
    capture.compositionEnd('中');
    expect(sent).toEqual([]);
    expect(dropped).toEqual(['disabled']);
  });

  it('interrupting an open composition is reported; resetting an idle capture is not', () => {
    const { capture, dropped } = setup();
    capture.reset();
    expect(dropped).toEqual([]);
    capture.compositionStart();
    capture.interrupt();
    expect(dropped).toEqual(['interrupted']);
    expect(capture.composing()).toBe(false);
  });
});

describe('CompositionCapture: dead keys', () => {
  it('Chromium order: Dead keydown, then the combined key, text via beforeinput', () => {
    const { capture, sent } = setup();
    expect(capture.keyDown(key({ key: 'Dead', code: 'Quote', keyCode: 222 }))).toBe('capture');
    expect(capture.keyUp(key({ key: 'Dead', code: 'Quote' }))).toBe('suppress');
    expect(capture.keyDown(key({ key: 'é', code: 'KeyE', keyCode: 69 }))).toBe('capture');
    expect(capture.beforeInput('insertText', 'é', false)).toEqual({ preventDefault: true });
    expect(capture.keyUp(key({ key: 'e', code: 'KeyE' }))).toBe('suppress');
    expect(sent).toEqual(['é']);
    // The next key is ordinary again.
    expect(capture.keyDown(key({ key: 'x', code: 'KeyX', keyCode: 88 }))).toBe('forward');
  });

  it('a modifier between the dead key and the letter keeps the dead state (´ then Shift+E = É)', () => {
    const { capture, sent } = setup();
    expect(capture.keyDown(key({ key: 'Dead', code: 'Quote' }))).toBe('capture');
    expect(capture.keyDown(key({ key: 'Shift', code: 'ShiftLeft' }))).toBe('forward');
    expect(capture.keyDown(key({ key: 'É', code: 'KeyE', keyCode: 69 }))).toBe('capture');
    capture.beforeInput('insertText', 'É', false);
    expect(capture.keyUp(key({ key: 'E', code: 'KeyE' }))).toBe('suppress');
    expect(capture.keyUp(key({ key: 'Shift', code: 'ShiftLeft' }))).toBe('forward');
    expect(sent).toEqual(['É']);
  });

  it('dead key followed by a non-printable: the non-printable goes as a key', () => {
    const { capture, sent } = setup();
    capture.keyDown(key({ key: 'Dead', code: 'Quote' }));
    expect(capture.keyDown(key({ key: 'Backspace', code: 'Backspace', keyCode: 8 }))).toBe('forward');
    expect(sent).toEqual([]);
  });

  it('dead key followed by a Ctrl chord: the chord goes as a key', () => {
    const { capture } = setup();
    capture.keyDown(key({ key: 'Dead', code: 'Quote' }));
    expect(capture.keyDown(key({ key: 'a', code: 'KeyA', ctrlKey: true }))).toBe('forward');
  });

  it('WebKit order: the dead key opens a composition and compositionend carries the char', () => {
    const { capture, sent } = setup();
    expect(capture.keyDown(key({ key: 'Dead', code: 'KeyE', altKey: true }))).toBe('capture');
    capture.compositionStart();
    capture.beforeInput('insertCompositionText', '´', true);
    expect(capture.keyDown(key({ key: 'é', code: 'KeyE', isComposing: true, keyCode: 229 }))).toBe('capture');
    capture.compositionEnd('é');
    expect(sent).toEqual(['é']);
  });

  it('a stray insertText from an unprevented key is sent once', () => {
    const { capture, sent } = setup();
    expect(capture.beforeInput('insertText', 'ñ', false)).toEqual({ preventDefault: true });
    expect(sent).toEqual(['ñ']);
  });

  it('other edits to the hidden input are blocked and send nothing', () => {
    const { capture, sent } = setup();
    expect(capture.beforeInput('deleteContentBackward', null, false)).toEqual({ preventDefault: true });
    expect(capture.beforeInput('insertText', '', false)).toEqual({ preventDefault: true });
    expect(sent).toEqual([]);
  });
});

describe('CompositionCapture: reset', () => {
  it('forgets composing / dead state and suppressed keys', () => {
    const { capture, sent } = setup();
    capture.keyDown(key({ key: 'Dead', code: 'Quote' }));
    capture.compositionStart();
    capture.reset();
    expect(capture.composing()).toBe(false);
    // Suppression bookkeeping is gone: the viewer's own held-key check decides now.
    expect(capture.keyUp(key({ key: 'Dead', code: 'Quote' }))).toBe('forward');
    expect(capture.keyDown(key({ key: 'e', code: 'KeyE' }))).toBe('forward');
    expect(sent).toEqual([]);
  });

  it('a composition committed after reset (blur commits it) is still delivered', () => {
    const { capture, sent } = setup();
    capture.compositionStart();
    capture.reset();
    capture.compositionEnd('中');
    expect(sent).toEqual(['中']);
  });

  it('nothing is sent once capture is switched off (Physical keys)', () => {
    const { capture, sent, setEnabled } = setup();
    capture.compositionStart();
    setEnabled(false);
    capture.compositionEnd('中');
    capture.beforeInput('insertText', 'é', false);
    expect(sent).toEqual([]);
  });
});

describe('deliverComposedText', () => {
  it('sends type_text on the control channel, chunked', () => {
    const sendControl = vi.fn();
    expect(deliverComposedText('あいう', sendControl, 2)).toBe(true);
    expect(sendControl.mock.calls.map((c) => JSON.parse(c[0]))).toEqual([
      { type: 'type_text', text: 'あい' },
      { type: 'type_text', text: 'う' },
    ]);
  });

  it('reports failure without a control channel (never silently dropped)', () => {
    expect(deliverComposedText('x', null)).toBe(false);
  });

  it('empty text is a no-op success', () => {
    const sendControl = vi.fn();
    expect(deliverComposedText('', sendControl)).toBe(true);
    expect(sendControl).not.toHaveBeenCalled();
  });

  it('a throwing send is reported as not delivered', () => {
    expect(deliverComposedText('x', () => { throw new Error('closed'); })).toBe(false);
  });
});
