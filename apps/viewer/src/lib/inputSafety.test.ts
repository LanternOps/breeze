import { describe, it, expect } from 'vitest';
import {
  detectViewerOs,
  defaultRemapCmdCtrl,
  mouseButtonName,
  shouldForwardKeyRepeat,
  chordRouting,
  remoteClipboardDecision,
  REMOTE_CLIPBOARD_COPY_INTENT_MS,
  isCopyChord,
  REMOTE_CLIPBOARD_BASELINE_WINDOW_MS,
  viewerShortcut,
  shortcutLabel,
  isPasteChord,
} from './inputSafety';

describe('detectViewerOs', () => {
  it.each([
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)', 'macos'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0', 'windows'],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)', 'linux'],
    ['', 'unknown'],
  ])('%s → %s', (ua, expected) => {
    expect(detectViewerOs(ua)).toBe(expected);
  });
});

describe('defaultRemapCmdCtrl', () => {
  it('is off for Windows viewer → Windows remote (Ctrl must not become the Win key)', () => {
    expect(defaultRemapCmdCtrl('windows', 'windows')).toBe(false);
  });
  it('is off for Windows viewer → Linux remote', () => {
    expect(defaultRemapCmdCtrl('windows', 'linux')).toBe(false);
  });
  it('is on for Mac viewer → Windows remote (Cmd+C becomes Ctrl+C)', () => {
    expect(defaultRemapCmdCtrl('macos', 'windows')).toBe(true);
  });
  it('is on for Windows viewer → Mac remote (Ctrl+C becomes Cmd+C)', () => {
    expect(defaultRemapCmdCtrl('windows', 'macos')).toBe(true);
  });
  it('is off for Mac viewer → Mac remote', () => {
    expect(defaultRemapCmdCtrl('macos', 'macos')).toBe(false);
  });
  it('assumes a non-Mac remote while the remote OS is still unknown', () => {
    expect(defaultRemapCmdCtrl('macos', null)).toBe(true);
    expect(defaultRemapCmdCtrl('windows', null)).toBe(false);
  });
  it('is off when the viewer OS is unknown', () => {
    expect(defaultRemapCmdCtrl('unknown', 'windows')).toBe(false);
  });
});

describe('mouseButtonName', () => {
  it('maps the three primary buttons', () => {
    expect(mouseButtonName(0)).toBe('left');
    expect(mouseButtonName(1)).toBe('middle');
    expect(mouseButtonName(2)).toBe('right');
  });
  it('returns null for back/forward so a thumb button never clicks on the remote', () => {
    expect(mouseButtonName(3)).toBeNull();
    expect(mouseButtonName(4)).toBeNull();
  });
});

describe('shouldForwardKeyRepeat', () => {
  it('forwards on Windows and macOS remotes, which do not autorepeat injected keys', () => {
    expect(shouldForwardKeyRepeat('windows')).toBe(true);
    expect(shouldForwardKeyRepeat('macos')).toBe(true);
  });
  it('does not forward on Linux, where the X server autorepeats XTEST-held keys', () => {
    expect(shouldForwardKeyRepeat('linux')).toBe(false);
  });
  it('does not forward while the remote OS is unknown', () => {
    expect(shouldForwardKeyRepeat(null)).toBe(false);
  });
});

describe('chordRouting', () => {
  const base = {
    modifiers: ['shift'],
    heldKeys: new Set(['shift']),
    remoteOs: 'windows' as string | null,
    viewerOs: 'windows' as const,
    physicalMeta: false,
    remapActive: false,
  };

  it('uses held key_down/key_up when every chord modifier is already held on a Windows remote', () => {
    expect(chordRouting(base)).toBe('held');
  });
  it('keeps key_press on a Linux remote (raw XTEST key_down skips layout-required Shift)', () => {
    expect(chordRouting({ ...base, remoteOs: 'linux' })).toBe('key_press');
  });
  it('uses held routing for a real Win key chord (remap off)', () => {
    expect(chordRouting({ ...base, modifiers: ['meta'], heldKeys: new Set(['meta']) })).toBe('held');
  });
  it('keeps key_press for a remapped meta: today it reaches Windows as Ctrl, held it would be the Win key', () => {
    expect(chordRouting({
      ...base, modifiers: ['meta'], heldKeys: new Set(['meta']), remapActive: true,
    })).toBe('key_press');
  });
  it('falls back to key_press when a modifier was not seen going down', () => {
    expect(chordRouting({ ...base, modifiers: ['ctrl', 'shift'] })).toBe('key_press');
  });
  it('keeps key_press for macOS remotes, whose agent cannot hold a modifier', () => {
    expect(chordRouting({ ...base, remoteOs: 'macos' })).toBe('key_press');
  });
  it('keeps key_press while the remote OS is unknown', () => {
    expect(chordRouting({ ...base, remoteOs: null })).toBe('key_press');
  });
  it('keeps key_press for a Mac viewer with Cmd held (macOS drops the keyup of a key released under Cmd)', () => {
    expect(chordRouting({
      ...base,
      viewerOs: 'macos',
      modifiers: ['ctrl'],
      heldKeys: new Set(['ctrl']),
      physicalMeta: true,
    })).toBe('key_press');
  });
  it('uses held routing for a Mac viewer chord without Cmd', () => {
    expect(chordRouting({ ...base, viewerOs: 'macos', remapActive: true })).toBe('held');
  });
  it('returns key_press when there are no modifiers (caller handles plain keys)', () => {
    expect(chordRouting({ ...base, modifiers: [] })).toBe('key_press');
  });
});

describe('remoteClipboardDecision', () => {
  const opened = 10_000;
  const later = opened + REMOTE_CLIPBOARD_BASELINE_WINDOW_MS + 1;
  const base = { now: later, hasFocus: true, lastCopyIntentAt: null, channelOpenedAt: opened, pushesSeen: 3 };

  it('applies a push to the focused window', () => {
    expect(remoteClipboardDecision(base)).toBe('apply');
  });

  it('skips a push to a background window (no cross-session clipboard bleed)', () => {
    expect(remoteClipboardDecision({ ...base, hasFocus: false })).toBe('skip-unfocused');
  });

  it('skips a background push even right after the operator switched away, absent a copy', () => {
    // Switching from customer A's window to B's and A's user copying a moment
    // later must not land A's data on the local clipboard.
    expect(remoteClipboardDecision({ ...base, hasFocus: false, lastCopyIntentAt: null })).toBe('skip-unfocused');
  });

  it('applies a push that lands after the operator copied in this window and switched away', () => {
    expect(remoteClipboardDecision({
      ...base, hasFocus: false, lastCopyIntentAt: later - 400,
    })).toBe('apply');
  });

  it('skips a background push once the copy intent has expired', () => {
    expect(remoteClipboardDecision({
      ...base, hasFocus: false, lastCopyIntentAt: later - REMOTE_CLIPBOARD_COPY_INTENT_MS - 1,
    })).toBe('skip-unfocused');
  });

  it('skips the baseline push the agent sends right after the channel opens', () => {
    expect(remoteClipboardDecision({ ...base, now: opened + 600, pushesSeen: 0 })).toBe('skip-baseline');
  });

  it('applies a second push inside the baseline window (a real copy, not the baseline)', () => {
    expect(remoteClipboardDecision({ ...base, now: opened + 1500, pushesSeen: 1 })).toBe('apply');
  });

  it('applies a first push that arrives after the baseline window', () => {
    expect(remoteClipboardDecision({ ...base, pushesSeen: 0 })).toBe('apply');
  });
});

describe('isCopyChord', () => {
  const ev = (code: string, m: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>>) =>
    ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...m });
  it('covers Ctrl/Cmd+C, Ctrl/Cmd+X and Ctrl+Insert', () => {
    expect(isCopyChord(ev('KeyC', { ctrlKey: true }))).toBe(true);
    expect(isCopyChord(ev('KeyC', { metaKey: true }))).toBe(true);
    expect(isCopyChord(ev('KeyX', { ctrlKey: true }))).toBe(true);
    expect(isCopyChord(ev('KeyC', { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isCopyChord(ev('Insert', { ctrlKey: true }))).toBe(true);
  });
  it('is not a plain C or an Alt chord', () => {
    expect(isCopyChord(ev('KeyC', {}))).toBe(false);
    expect(isCopyChord(ev('KeyC', { ctrlKey: true, altKey: true }))).toBe(false);
  });
});

describe('viewerShortcut', () => {
  const ev = (code: string, m: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>>) =>
    ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...m });

  it('recognises the Ctrl+Alt+Shift prefix on a Windows viewer', () => {
    const p = { ctrlKey: true, altKey: true, shiftKey: true };
    expect(viewerShortcut(ev('KeyF', p), 'windows')).toBe('fullscreen');
    expect(viewerShortcut(ev('KeyV', p), 'windows')).toBe('paste-keystrokes');
    expect(viewerShortcut(ev('KeyR', p), 'windows')).toBe('release-keys');
  });

  it('recognises the Ctrl+Opt+Cmd prefix on a Mac viewer', () => {
    const p = { ctrlKey: true, altKey: true, metaKey: true };
    expect(viewerShortcut(ev('KeyF', p), 'macos')).toBe('fullscreen');
    expect(viewerShortcut(ev('KeyV', p), 'macos')).toBe('paste-keystrokes');
  });

  it('no longer claims Ctrl/Cmd+Shift+V or +F — those go to the remote', () => {
    expect(viewerShortcut(ev('KeyV', { ctrlKey: true, shiftKey: true }), 'windows')).toBeNull();
    expect(viewerShortcut(ev('KeyF', { ctrlKey: true, shiftKey: true }), 'windows')).toBeNull();
    expect(viewerShortcut(ev('KeyV', { metaKey: true, shiftKey: true }), 'macos')).toBeNull();
    expect(viewerShortcut(ev('KeyF', { metaKey: true, shiftKey: true }), 'macos')).toBeNull();
  });

  it('requires the full prefix and nothing extra', () => {
    expect(viewerShortcut(ev('KeyF', { ctrlKey: true, altKey: true }), 'windows')).toBeNull();
    expect(viewerShortcut(ev('KeyF', { ctrlKey: true, altKey: true, shiftKey: true, metaKey: true }), 'windows')).toBeNull();
    expect(viewerShortcut(ev('KeyF', { ctrlKey: true, altKey: true, shiftKey: true }), 'macos')).toBeNull();
  });

  it('ignores keys outside the shortcut set', () => {
    expect(viewerShortcut(ev('KeyQ', { ctrlKey: true, altKey: true, shiftKey: true }), 'windows')).toBeNull();
  });

  it('labels the prefix for the viewer OS', () => {
    expect(shortcutLabel('V', 'windows')).toBe('Ctrl+Alt+Shift+V');
    expect(shortcutLabel('F', 'macos')).toBe('⌃⌥⌘F');
  });
});

describe('isPasteChord', () => {
  const ev = (code: string, m: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>>) =>
    ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...m });

  it('covers Ctrl/Cmd+V and Ctrl/Cmd+Shift+V (paste as plain text)', () => {
    expect(isPasteChord(ev('KeyV', { ctrlKey: true }))).toBe(true);
    expect(isPasteChord(ev('KeyV', { metaKey: true }))).toBe(true);
    expect(isPasteChord(ev('KeyV', { ctrlKey: true, shiftKey: true }))).toBe(true);
  });
  it('covers Shift+Insert', () => {
    expect(isPasteChord(ev('Insert', { shiftKey: true }))).toBe(true);
    expect(isPasteChord(ev('Insert', {}))).toBe(false);
    expect(isPasteChord(ev('Insert', { ctrlKey: true, shiftKey: true }))).toBe(false);
  });
  it('is not a plain V or an Alt chord', () => {
    expect(isPasteChord(ev('KeyV', {}))).toBe(false);
    expect(isPasteChord(ev('KeyV', { ctrlKey: true, altKey: true }))).toBe(false);
  });
});
