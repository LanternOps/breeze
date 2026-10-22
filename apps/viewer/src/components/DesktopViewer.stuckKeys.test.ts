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

  it('"Release stuck keys" also asks the agent to release what it holds, on any input protocol', () => {
    const release = body('handleReleaseStuckKeys');
    const own = release.indexOf('releaseAllKeys()');
    const ask = release.indexOf("JSON.stringify({ type: 'release_held_input' })");
    expect(own).toBeGreaterThan(-1);
    expect(ask).toBeGreaterThan(own);
    expect(release.lastIndexOf('releaseHeldOnRequest', ask)).toBeGreaterThan(-1);
  });

  it('wires the toolbar item and the keyboard shortcut to it', () => {
    expect(source).toMatch(/onReleaseAllKeys=\{handleReleaseStuckKeys\}/);
    const down = body('handleKeyDown');
    const branch = down.slice(down.indexOf("shortcut === 'release-keys'"));
    expect(branch.slice(0, 200)).toMatch(/handleReleaseStuckKeys\(\)/);
  });
});
