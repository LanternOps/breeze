import { describe, it, expect } from 'vitest';
// Source-derived guards (see DesktopViewer.inputSafety.test.ts): the viewer has
// no React test harness. The rules themselves are unit-tested in
// lib/inputSafety.test.ts and lib/clipboardSync.test.ts (#11310).
import source from './DesktopViewer.tsx?raw';

describe('DesktopViewer clipboard input-recency wiring (#11310)', () => {
  it('stamps operator input when a key or click is sent to the remote', () => {
    const sendInputFn = source.slice(source.indexOf('const sendInputFn = useCallback'), source.indexOf('const sendComposedText = useCallback'));
    expect(sendInputFn).toMatch(/send\(event\);\s*\n\s*if \(countsAsOperatorInput\(event\)\) lastRemoteInputAtRef\.current = Date\.now\(\);/);
  });

  it('gives the WebRTC clipboard controller the input clock', () => {
    expect(source).toMatch(/lastInputAt: \(\) => lastRemoteInputAtRef\.current,/);
  });

  it('no longer lets focus alone decide (no hasFocus-only controller)', () => {
    const ctor = source.slice(source.indexOf('const sync = new ClipboardSync({'), source.indexOf('clipboardSyncRef.current = sync;'));
    expect(ctor).toMatch(/hasFocus: \(\) => document\.hasFocus\(\),/);
    expect(ctor).toMatch(/lastInputAt:/);
  });
});
