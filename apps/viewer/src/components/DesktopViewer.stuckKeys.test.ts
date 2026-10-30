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
    // The viewer sends no key_ups of its own on this path: they could land
    // after the agent's release on `control` as stray key-ups.
    expect(release).not.toMatch(/\bsend\(ev\)/);
  });

  it('forgets its held keys only after the request was sent, and reports what happened', () => {
    const release = body('handleReleaseStuckKeys');
    const ask = release.indexOf("JSON.stringify({ type: 'release_held_input' })");
    const forget = release.indexOf('pressedKeysRef.current.clear()');
    // A send that throws (channel closing between the readyState check and
    // the send) must not leave the viewer believing nothing is held.
    expect(release.slice(0, ask)).toMatch(/try \{/);
    expect(forget).toBeGreaterThan(ask);
    const catchBlock = release.slice(release.indexOf('catch', ask), forget);
    expect(catchBlock).toMatch(/releaseAllKeys\(\)/);
    expect(catchBlock).toMatch(/setInputNotice\(/);
    // Every branch tells the operator what was done, and none claims a release
    // the agent has not acknowledged: the request is fire-and-forget.
    expect(release.match(/setInputNotice\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(release).not.toMatch(/setInputNotice\('Released all keys/);
  });

  it('wires the toolbar item and the keyboard shortcut to it', () => {
    expect(source).toMatch(/onReleaseAllKeys=\{handleReleaseStuckKeys\}/);
    const down = body('handleKeyDown');
    const branch = down.slice(down.indexOf("shortcut === 'release-keys'"));
    expect(branch.slice(0, 200)).toMatch(/handleReleaseStuckKeys\(\)/);
    // The notice lives in the handler, so the toolbar item reports too.
    expect(branch.slice(0, 200)).not.toMatch(/setInputNotice\(/);
    // The release-keys shortcut must not send its own prefix key_ups first.
    expect(down.indexOf("shortcut === 'release-keys'")).toBeLessThan(down.indexOf('releaseAllKeys();', down.indexOf('const shortcut = viewerShortcut')));
  });
});
