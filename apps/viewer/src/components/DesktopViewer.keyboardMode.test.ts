import { describe, it, expect } from 'vitest';
import source from './DesktopViewer.tsx?raw';

/**
 * Source guard for the keyboard-mode / IME wiring (W06, #8242). The behaviour
 * lives in lib/keyboardMode.ts and lib/compositionCapture.ts (unit-tested);
 * apps/viewer has no harness for DesktopViewer itself, so this pins that the
 * component routes through them.
 */
const keyDown = source.slice(
  source.indexOf('const handleKeyDown = useCallback('),
  source.indexOf('const handleKeyUp = useCallback('),
);
const keyUp = source.slice(
  source.indexOf('const handleKeyUp = useCallback('),
  source.indexOf('// ── Toolbar: config changes'),
);

describe('DesktopViewer keyboard mode + IME (W06, #8242)', () => {
  it('asks the composition capture before preventing or forwarding a keydown', () => {
    const capture = keyDown.indexOf("composition.keyDown(ne) === 'capture'");
    expect(capture).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(keyDown.indexOf('e.preventDefault();'));
    // View-only never composes: the capture is consulted only when input is live.
    expect(keyDown).toMatch(/if \(!viewOnlyRef\.current && composition\.keyDown\(ne\) === 'capture'\) return;/);
  });

  it('drops the keyup of a captured key before anything is forwarded', () => {
    const suppress = keyUp.indexOf("composition.keyUp(ne) === 'suppress'");
    expect(suppress).toBeGreaterThan(-1);
    expect(suppress).toBeLessThan(keyUp.indexOf('sendInputFn('));
  });

  it('sends `code` only in Physical keys mode', () => {
    expect(keyDown).toContain('const keyFields = extendedKeyFields(ne, keyCodes, { omitCode: !sendKeyCodes });');
    expect(keyDown).toContain('extendedKeyFields(ne, keyCodes, { omitCode: remapped || !sendKeyCodes })');
    expect(keyUp).toContain("extendedKeyFields(ne, keyCodes, { omitCode: !sendKeyCodes })");
    expect(keyUp).toContain('extendedKeyFields(ne, keyCodes, { omitCode: remapped || !sendKeyCodes })');
    expect(source.match(/const sendKeyCodes = effectiveKeyboardModeRef\.current === 'physical';/g)).toHaveLength(2);
  });

  it('derives the mode and capture from what the session supports', () => {
    expect(source).toMatch(/keyboardModeSupport\(\{\s*transport,\s*keyCodes: inputCaps\.keyCodes,\s*typeText: inputCaps\.typeText,?\s*\}\)/);
    expect(source).toContain('effectiveKeyboardMode(keyboardMode, keyboardSupport)');
    expect(source).toContain("const captureEnabled = effectiveMode === 'text' && keyboardSupport.composition;");
  });

  it('releases everything held and resets the capture when the mode or capture changes', () => {
    const effect = source.slice(source.indexOf('// Keyboard mode or capture changed'));
    expect(effect.slice(0, 600)).toContain('releaseAllKeysRef.current();');
    expect(effect.slice(0, 600)).toContain('composition.interrupt();');
  });

  it('tells the operator when composed text was dropped (review fix)', () => {
    expect(source).toMatch(/onDropped: \(\) => setInputNotice\(/);
  });

  it('does not let a late prefs load overwrite a mode the operator just picked (review fix)', () => {
    expect(source).toContain('if (!cancelled && !keyboardModeChosenRef.current) setKeyboardMode(mode);');
    const handler = source.slice(source.indexOf('const handleKeyboardModeChange = useCallback('));
    expect(handler.slice(0, 300)).toContain('keyboardModeChosenRef.current = true;');
  });

  it('resets the capture when view-only switches on (review fix)', () => {
    const fn = source.slice(source.indexOf('const handleViewOnlyChange = useCallback('));
    expect(fn.slice(0, 500)).toContain('composition.reset();');
  });

  it('resets the capture on focus loss alongside the release', () => {
    const blur = source.slice(source.indexOf('const handleInputBlur = useCallback('));
    expect(blur.slice(0, 300)).toContain('releaseAllKeys();');
    expect(blur.slice(0, 300)).toContain('composition.reset();');
  });

  it('delivers composed text through type_text on the control channel, view-only checked', () => {
    const fn = source.slice(source.indexOf('const sendComposedText = useCallback('));
    expect(fn.slice(0, 900)).toContain('if (viewOnlyRef.current) return;');
    expect(fn.slice(0, 900)).toContain('deliverComposedText(');
    // Never dropped silently.
    expect(fn.slice(0, 900)).toContain('setInputNotice(');
  });

  it('remembers the mode through the per-device prefs store', () => {
    expect(source).toContain('loadKeyboardMode(store, params.deviceId)');
    expect(source).toContain('saveKeyboardMode(store, params.deviceId, mode)');
  });

  it('renders the hidden capture input only for WebRTC with capture on, wired to the key handlers', () => {
    expect(source).toMatch(/\{captureEnabled && transport === 'webrtc' && \(\s*<ImeCaptureInput/);
    expect(source).toMatch(/<ImeCaptureInput[\s\S]{0,300}onKeyDown=\{handleKeyDown\}/);
  });

  it('never logs composed or typed text', () => {
    expect(source).not.toMatch(/console\.\w+\([^)]*compos/i);
  });
});
