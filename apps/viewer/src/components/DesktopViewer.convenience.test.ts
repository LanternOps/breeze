import { describe, it, expect } from 'vitest';
// Source-derived wiring guards (same approach as DesktopViewer.inputSafety.test.ts):
// the viewer has no React harness. The decisions themselves are unit-tested in
// lib/viewOnly.test.ts, lib/blockLocalInput.test.ts, lib/displayScaling.test.ts.
import source from './DesktopViewer.tsx?raw';
import toolbar from './ViewerToolbar.tsx?raw';

function body(name: string): string {
  const start = source.indexOf(`const ${name} = useCallback(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const end = source.indexOf('\n  }, [', start);
  return source.slice(start, end);
}

describe('view-only (W05, #8241)', () => {
  it('gates both WebRTC channels and the WebSocket path inside the sender, before the router assigns a seq', () => {
    const sender = body('getInputSender');
    const gate = sender.match(/suppressedByViewOnly\(event, viewOnlyRef\.current\)/g) ?? [];
    expect(gate.length).toBe(2);
    expect(sender.indexOf('suppressedByViewOnly(event, viewOnlyRef.current)'))
      .toBeLessThan(sender.indexOf('reliableInput.send(event)'));
    const ws = sender.indexOf('wsSession.inputChannel.send(');
    expect(sender.lastIndexOf('suppressedByViewOnly(event, viewOnlyRef.current)', ws)).toBeGreaterThan(sender.indexOf('reliableInput.send(event)'));
  });

  it('drops the RAF-coalesced mouse move before it reaches the router', () => {
    const flush = body('flushWebRTCMouseMove');
    const gate = flush.indexOf('viewOnlyRef.current');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(flush.indexOf('reliableInput.send('));
  });

  it('releases everything held before the gate closes', () => {
    const toggle = body('handleViewOnlyChange');
    const release = toggle.indexOf('releaseAllKeys()');
    expect(release).toBeGreaterThan(-1);
    expect(release).toBeLessThan(toggle.indexOf('viewOnlyRef.current = next'));
  });

  it('keeps view-only in noVNC too, including for a VNC session opened while it is on', () => {
    expect(body('handleViewOnlyChange')).toMatch(/vncSessionRef\.current\?\.setViewOnly\(next\)/);
    expect(source).toMatch(/session\.setViewOnly\(viewOnlyRef\.current\)/);
  });

  it('stops every handler that would otherwise send, without the "not delivered" notice', () => {
    for (const name of ['handleMouseMove', 'handleMouseDown', 'handleMouseUp', 'handleKeyUp', 'handlePasteAsKeystrokes', 'handleSendKeys', 'handleSendSAS', 'handleLockWorkstation']) {
      expect(body(name), name).toMatch(/if \(viewOnlyRef\.current\)/);
    }
  });

  it('still honours the fullscreen host key in view-only, and nothing else from the keyboard', () => {
    const down = body('handleKeyDown');
    const gate = down.indexOf('if (viewOnlyRef.current)');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(down.indexOf('isModifierOnly(ne)'));
  });

  it('lets the wheel scroll the local view instead of the remote in view-only', () => {
    const wheel = source.slice(source.indexOf('function onWheel('), source.indexOf("el.addEventListener('wheel', onWheel"));
    expect(wheel.indexOf('if (viewOnlyRef.current) return;')).toBeGreaterThan(-1);
    expect(wheel.indexOf('if (viewOnlyRef.current) return;')).toBeLessThan(wheel.indexOf('e.preventDefault()'));
  });

  it('shows a visible indicator and disables the input actions in the toolbar', () => {
    expect(source).toMatch(/data-testid="view-only-indicator"/);
    expect(toolbar).toMatch(/viewOnly/);
    expect(toolbar).toMatch(/disabled=\{!!pasteProgress \|\| viewOnly\}/);
  });
});

describe('block local input UI (W05, #8241, #966)', () => {
  it('sends the existing agent control message and renders the agent reply', () => {
    expect(source).toMatch(/blockLocalInputMessage\(/);
    expect(source).toMatch(/case 'block_local_input_result':/);
    expect(source).toMatch(/parseBlockLocalInputResult\(msg\)/);
  });

  it('forgets the block state when the control channel is replaced (the agent releases on session end)', () => {
    expect(source).toMatch(/setBlockLocalInput\(INITIAL_BLOCK_LOCAL_INPUT\)/);
  });

  it('times out a request that is never answered', () => {
    expect(source).toMatch(/BLOCK_LOCAL_INPUT_REPLY_TIMEOUT_MS/);
    expect(source).toMatch(/blockLocalInputTimedOut/);
  });
});

describe('view scaling (W05, #8241)', () => {
  it('drives the media and its scroller from the scaling mode on both video and canvas', () => {
    expect(source.match(/mediaClassName\(viewScaling\)/g)?.length).toBe(2);
    expect(source).toMatch(/scrollerClassName\(viewScaling\)/);
  });

  it('applies the mode to a VNC session, including one opened after the change', () => {
    expect(source).toMatch(/session\.setScaling\(viewScalingRef\.current\)/);
    expect(source).toMatch(/vncSessionRef\.current\?\.setScaling\(/);
  });
});

describe('stats overlay (W05, #8241)', () => {
  it('feeds the overlay from the existing stats reporter, off by default', () => {
    expect(source).toMatch(/onSample: \(sample\) => \{\s*\n\s*if \(statsOverlayRef\.current\) setStatsSample\(sample\);/);
    expect(source).toMatch(/const \[statsOverlay, setStatsOverlay\] = useState\(false\)/);
    expect(source).toMatch(/statsOverlayRows\(/);
    expect(source).toMatch(/data-testid="stats-overlay"/);
  });
});

describe('screenshot (W05, #8241)', () => {
  it('captures from the active transport and stays local (clipboard IO or the save command)', () => {
    const shot = body('captureScreenshot');
    expect(shot).toMatch(/kind: 'video'/);
    expect(shot).toMatch(/kind: 'canvas'/);
    expect(shot).toMatch(/kind: 'vnc'/);
    const copy = body('handleCopyScreenshot');
    expect(copy).toMatch(/clipboardIO\.writeImage\(/);
    const save = body('handleSaveScreenshot');
    expect(save).toMatch(/invoke<string>\('save_screenshot', bytes\)/);
    for (const fn of [shot, copy, save]) expect(fn).not.toMatch(/fetch\(|apiUrl/);
  });
});

describe('per-device prefs (W05, #8241)', () => {
  it('loads and saves by the deep link device id only, through the local store', () => {
    expect(source).toMatch(/loadDevicePrefs\(store, params\.deviceId\)/);
    expect(source.match(/rememberDevicePrefs\(\{/g)?.length).toBeGreaterThanOrEqual(3);
    expect(body('rememberDevicePrefs')).toMatch(/saveDevicePrefs\(store, params\.deviceId, patch\)/);
  });

  it('remembers remap, scaling and audio when the operator changes them', () => {
    expect(source).toMatch(/rememberDevicePrefs\(\{ remapCmdCtrl: v \}\)/);
    expect(body('handleViewScalingChange')).toMatch(/rememberDevicePrefs\(\{ viewScaling: mode \}\)/);
    expect(body('handleToggleAudio')).toMatch(/rememberDevicePrefs\(\{ audio: newEnabled \}\)/);
  });

  it('restores audio through the same path as the toggle, once a track and the control channel exist', () => {
    const restore = source.slice(source.indexOf('pendingAudioRestoreRef.current = false;') - 400, source.indexOf('pendingAudioRestoreRef.current = false;') + 200);
    expect(restore).toMatch(/hasAudioTrack/);
    expect(restore).toMatch(/handleToggleAudio\(\)/);
  });
});

describe('keyboard lock (W05, #8241)', () => {
  it('locks only under the shared condition and releases on unmount', () => {
    expect(source).toMatch(/createKeyboardLockController\(getKeyboardLockApi\(\)\)/);
    expect(source).toMatch(/keyboardLock\.sync\(shouldLockKeyboard\(/);
    expect(source).toMatch(/keyboardLockRef\.current\?\.release\(\)/);
    expect(source).toMatch(/addEventListener\('fullscreenchange'/);
  });
});
