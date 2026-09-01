import { describe, it, expect, vi } from 'vitest';
import {
  TYPE_TEXT_CHUNK_UNITS,
  chunkTextForInjection,
  pasteFailureMessage,
  sendPasteText,
  type PasteTextDeps,
} from './pasteText';

function makeDeps(overrides: Partial<PasteTextDeps> = {}): {
  deps: PasteTextDeps;
  control: string[];
  input: unknown[];
  progress: ({ current: number; total: number } | null)[];
} {
  const control: string[] = [];
  const input: unknown[] = [];
  const progress: ({ current: number; total: number } | null)[] = [];

  const deps: PasteTextDeps = {
    text: '',
    supportsTypeText: true,
    sendControl: (json: string) => control.push(json),
    sendInput: (event) => input.push(event),
    onProgress: (p) => progress.push(p),
    isCancelled: () => false,
    yieldToUi: async () => {},
    ...overrides,
  };

  return { deps, control, input, progress };
}

describe('chunkTextForInjection', () => {
  it('returns nothing for empty text', () => {
    expect(chunkTextForInjection('')).toEqual([]);
  });

  it('keeps short text in a single chunk', () => {
    expect(chunkTextForInjection('echo hi')).toEqual(['echo hi']);
  });

  it('splits at the unit cap', () => {
    expect(chunkTextForInjection('abcde', 2)).toEqual(['ab', 'cd', 'e']);
  });

  it('never splits a surrogate pair across chunks', () => {
    // '\u{1F600}' is two UTF-16 code units.
    const chunks = chunkTextForInjection('a\u{1F600}b', 2);
    expect(chunks).toEqual(['a', '\u{1F600}', 'b']);
    expect(chunks.join('')).toBe('a\u{1F600}b');
  });

  it('emits an astral character whole even when it exceeds the cap', () => {
    expect(chunkTextForInjection('\u{1F600}', 1)).toEqual(['\u{1F600}']);
  });

  it('reassembles losslessly for a realistic shell block', () => {
    const text = 'cd /usr/local/bin\necho "===== HOST ====="\nid -u\n';
    expect(chunkTextForInjection(text, 7).join('')).toBe(text);
  });

  it('keeps every chunk small enough to fit the agent control-message cap', () => {
    // The agent rejects control messages over 32 KiB (maxControlMessageBytes in
    // agent/internal/remote/desktop/session_control.go). Worst-case JSON
    // escaping is 6 bytes per UTF-16 unit, so the default cap must leave room.
    const worstCaseBytes = TYPE_TEXT_CHUNK_UNITS * 6 + 64;
    expect(worstCaseBytes).toBeLessThan(32 * 1024);
  });
});

describe('sendPasteText — type_text path', () => {
  it('sends chunked type_text control messages and no key events', async () => {
    const { deps, control, input } = makeDeps({ text: 'ab/cd', chunkUnits: 2 });
    await sendPasteText(deps);

    expect(control).toEqual([
      JSON.stringify({ type: 'type_text', text: 'ab' }),
      JSON.stringify({ type: 'type_text', text: '/c' }),
      JSON.stringify({ type: 'type_text', text: 'd' }),
    ]);
    expect(input).toEqual([]);
  });

  it('sends punctuation and casing verbatim rather than as shifted keystrokes', async () => {
    const { deps, control } = makeDeps({ text: 'ls /usr/local/bin | grep "A=B"' });
    await sendPasteText(deps);

    expect(control).toHaveLength(1);
    expect(JSON.parse(control[0])).toEqual({
      type: 'type_text',
      text: 'ls /usr/local/bin | grep "A=B"',
    });
  });

  it('reports progress per chunk and clears it at the end', async () => {
    const { deps, progress } = makeDeps({ text: 'abcd', chunkUnits: 2 });
    await sendPasteText(deps);

    expect(progress).toEqual([
      { current: 0, total: 2 },
      { current: 1, total: 2 },
      { current: 2, total: 2 },
      null,
    ]);
  });

  it('stops sending once cancelled', async () => {
    let sent = 0;
    const { deps, control } = makeDeps({
      text: 'abcdef',
      chunkUnits: 2,
      isCancelled: () => sent >= 1,
      sendControl: (json: string) => {
        sent++;
        control.push(json);
      },
    });
    await sendPasteText(deps);

    expect(control).toHaveLength(1);
  });

  it('clears progress even when a send throws', async () => {
    const { deps, progress } = makeDeps({
      text: 'abcd',
      chunkUnits: 2,
      sendControl: () => {
        throw new Error('channel closed');
      },
    });

    await expect(sendPasteText(deps)).rejects.toThrow('channel closed');
    expect(progress[progress.length - 1]).toBeNull();
  });
});

describe('sendPasteText — key-synthesis fallback', () => {
  it('falls back when the agent does not advertise type_text', async () => {
    const { deps, control, input } = makeDeps({ text: 'A?', supportsTypeText: false });
    await sendPasteText(deps);

    expect(control).toEqual([]);
    expect(input).toEqual([
      { type: 'key_press', key: 'a', modifiers: ['shift'] },
      { type: 'key_press', key: '/', modifiers: ['shift'] },
    ]);
  });

  it('falls back when there is no control channel, even if type_text is supported', async () => {
    const { deps, input } = makeDeps({ text: 'ab', supportsTypeText: true, sendControl: null });
    await sendPasteText(deps);

    expect(input).toEqual([
      { type: 'key_press', key: 'a', modifiers: [] },
      { type: 'key_press', key: 'b', modifiers: [] },
    ]);
  });

  it('stops the fallback loop once cancelled', async () => {
    let sent = 0;
    const { deps, input } = makeDeps({
      text: 'abcdef',
      supportsTypeText: false,
      isCancelled: () => sent >= 2,
      sendInput: (event) => {
        sent++;
        input.push(event);
      },
    });
    await sendPasteText(deps);

    expect(input).toHaveLength(2);
  });
});

describe('pasteFailureMessage', () => {
  it('explains an unavailable remote input path', () => {
    const msg = pasteFailureMessage({ reason: 'input_unavailable' });
    expect(msg).toContain('not accepting input');
    expect(msg).toContain('login window');
  });

  it('surfaces the agent detail for a partial injection', () => {
    const msg = pasteFailureMessage({
      reason: 'injection_failed',
      error: 'skipped 2 character(s) with no key mapping on this platform',
    });
    expect(msg).toContain('incomplete');
    expect(msg).toContain('skipped 2 character(s)');
  });

  it('omits the parenthetical when the agent sent no detail', () => {
    expect(pasteFailureMessage({ reason: 'injection_failed' })).not.toContain('(');
  });

  it('still says something useful for an unrecognised reason', () => {
    const msg = pasteFailureMessage({ reason: 'something_new' });
    expect(msg).toContain('Paste failed');
  });
});

describe('sendPasteText — empty input', () => {
  it('does nothing and never shows progress', async () => {
    const { deps, control, input, progress } = makeDeps({ text: '' });
    await sendPasteText(deps);

    expect(control).toEqual([]);
    expect(input).toEqual([]);
    expect(progress).toEqual([]);
  });

  it('never yields to the UI when there is nothing to send', async () => {
    const yieldToUi = vi.fn(async () => {});
    const { deps } = makeDeps({ text: '', yieldToUi });
    await sendPasteText(deps);

    expect(yieldToUi).not.toHaveBeenCalled();
  });
});
