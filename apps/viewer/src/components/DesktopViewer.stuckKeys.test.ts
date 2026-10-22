import { describe, it, expect } from 'vitest';
// Source-derived wiring guards (same approach as DesktopViewer.convenience.test.ts):
// the viewer has no React harness. The decisions are unit-tested in
// lib/inputSafety.test.ts and lib/inputCapabilities.test.ts.
import source from './DesktopViewer.tsx?raw';

function body(name: string): string {
  const start = source.indexOf(`const ${name} = useCallback(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const end = source.indexOf('\n  }, [', start);
  return source.slice(start, end);
}

describe('stuck modifiers (#9595)', () => {
  it('only forgets the modifiers the agent actually released', () => {
    const forget = body('forgetModifiersReleasedByKeyPress');
    expect(forget).toMatch(/modifiersReleasedByKeyPress\(modifiers, inputCapabilitiesRef\.current\.snapshot\(\)\.releasesHeldInput\)/);
  });

  it('"Release stuck keys" asks the agent to release everything, and falls back to the viewer\'s own releases', () => {
    const release = body('handleReleaseStuckKeys');
    const gate = release.indexOf('releaseHeldOnRequest');
    const fallback = release.indexOf('releaseAllKeys()');
    const ask = release.indexOf("JSON.stringify({ type: 'release_held_input' })");
    expect(gate).toBeGreaterThan(-1);
    expect(fallback).toBeGreaterThan(gate);
    expect(ask).toBeGreaterThan(fallback);
    // With the agent releasing, the viewer forgets its own held keys instead of
    // sending key_ups that could land after the release as stray key-ups.
    const forget = release.slice(fallback, release.indexOf('control.send(', fallback));
    expect(forget).toMatch(/pressedKeysRef\.current\.clear\(\)/);
    expect(forget).not.toMatch(/send\(/);
  });

  it('wires the toolbar item and the keyboard shortcut to it', () => {
    expect(source).toMatch(/onReleaseAllKeys=\{handleReleaseStuckKeys\}/);
    const down = body('handleKeyDown');
    const branch = down.slice(down.indexOf("shortcut === 'release-keys'"));
    expect(branch.slice(0, 200)).toMatch(/handleReleaseStuckKeys\(\)/);
    // The release-keys shortcut must not send its own prefix key_ups first.
    expect(down.indexOf("shortcut === 'release-keys'")).toBeLessThan(down.indexOf('releaseAllKeys();', down.indexOf('const shortcut = viewerShortcut')));
  });
});
