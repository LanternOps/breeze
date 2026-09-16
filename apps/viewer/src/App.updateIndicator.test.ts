import { describe, it, expect } from 'vitest';
import source from './App.tsx?raw';

/**
 * Structural guard ensuring UpdateIndicator is mounted in all top-level window branches.
 *
 * If omitted from `windowLabel === 'main'`, the auto-update banner ("Restart & update")
 * will never surface when the viewer is launched into the idle standby state.
 */
describe('App update indicator mounting', () => {
  it('mounts UpdateIndicator in the main window idle ready branch', () => {
    const mainWindowSection = source.slice(
      source.indexOf("if (windowLabel === 'main')"),
      source.indexOf('// ── Session window: viewer'),
    );
    expect(mainWindowSection).toContain('Breeze Viewer is ready');
    // Ensure UpdateIndicator appears at least twice in the main window section (scheme error + ready)
    const matches = mainWindowSection.match(/<UpdateIndicator \/>/g);
    expect(matches).not.toBeNull();
    expect(matches?.length).toBeGreaterThanOrEqual(2);
  });
});
