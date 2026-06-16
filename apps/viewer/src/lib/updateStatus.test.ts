import { describe, it, expect } from 'vitest';
import {
  updateProgressPercent,
  updateStatusMessage,
  isUpdateActive,
  isUpdateStatus,
  shouldAutoDismiss,
  type UpdateStatus,
} from './updateStatus';

describe('updateProgressPercent', () => {
  it('computes a whole-number percent for downloads with a known total', () => {
    expect(
      updateProgressPercent({ phase: 'downloading', version: '1.0.0', downloaded: 50, total: 200 }),
    ).toBe(25);
  });

  it('rounds to the nearest whole percent', () => {
    expect(
      updateProgressPercent({ phase: 'downloading', version: '1.0.0', downloaded: 1, total: 3 }),
    ).toBe(33);
  });

  it('clamps overshoot to 100', () => {
    expect(
      updateProgressPercent({ phase: 'downloading', version: '1.0.0', downloaded: 210, total: 200 }),
    ).toBe(100);
  });

  it('returns null when the total is unknown', () => {
    expect(
      updateProgressPercent({ phase: 'downloading', version: '1.0.0', downloaded: 50, total: null }),
    ).toBeNull();
  });

  it('returns null for a zero or negative total (no divide-by-zero)', () => {
    expect(
      updateProgressPercent({ phase: 'downloading', version: '1.0.0', downloaded: 0, total: 0 }),
    ).toBeNull();
  });

  it('returns null for non-download phases', () => {
    expect(updateProgressPercent({ phase: 'installing', version: '1.0.0' })).toBeNull();
    expect(updateProgressPercent({ phase: 'available', version: '1.0.0' })).toBeNull();
  });
});

describe('updateStatusMessage', () => {
  it('names the version while downloading without a total', () => {
    expect(
      updateStatusMessage({ phase: 'downloading', version: '1.2.3', downloaded: 10, total: null }),
    ).toBe('Downloading update 1.2.3…');
  });

  it('includes the percent while downloading with a total', () => {
    expect(
      updateStatusMessage({ phase: 'downloading', version: '1.2.3', downloaded: 50, total: 100 }),
    ).toBe('Downloading update 1.2.3… 50%');
  });

  it('explains the restart so it does not read as a crash', () => {
    expect(updateStatusMessage({ phase: 'restarting', version: '1.2.3' })).toMatch(/restarting/i);
  });

  it('explains a deferred update applies after the session', () => {
    expect(updateStatusMessage({ phase: 'deferred', version: '1.2.3' })).toMatch(/session ends/i);
  });

  it('explains a failed update will retry instead of leaving the banner stuck', () => {
    expect(updateStatusMessage({ phase: 'failed', version: '1.2.3' })).toMatch(/failed/i);
    expect(updateStatusMessage({ phase: 'failed', version: '1.2.3' })).toMatch(/retry/i);
  });

  it('covers every phase with a non-empty message', () => {
    const phases: UpdateStatus[] = [
      { phase: 'available', version: '1.0.0' },
      { phase: 'downloading', version: '1.0.0', downloaded: 1, total: 2 },
      { phase: 'installing', version: '1.0.0' },
      { phase: 'restarting', version: '1.0.0' },
      { phase: 'deferred', version: '1.0.0' },
      { phase: 'failed', version: '1.0.0' },
    ];
    for (const p of phases) {
      expect(updateStatusMessage(p).length).toBeGreaterThan(0);
    }
  });
});

describe('isUpdateActive', () => {
  it('treats in-flight phases as active', () => {
    expect(isUpdateActive({ phase: 'available', version: '1.0.0' })).toBe(true);
    expect(isUpdateActive({ phase: 'downloading', version: '1.0.0', downloaded: 1, total: 2 })).toBe(true);
    expect(isUpdateActive({ phase: 'installing', version: '1.0.0' })).toBe(true);
    expect(isUpdateActive({ phase: 'restarting', version: '1.0.0' })).toBe(true);
  });

  it('treats terminal notices (deferred / failed) as inactive', () => {
    expect(isUpdateActive({ phase: 'deferred', version: '1.0.0' })).toBe(false);
    expect(isUpdateActive({ phase: 'failed', version: '1.0.0' })).toBe(false);
  });
});

describe('shouldAutoDismiss', () => {
  it('auto-dismisses terminal notices (deferred / failed)', () => {
    expect(shouldAutoDismiss({ phase: 'deferred', version: '1.0.0' })).toBe(true);
    expect(shouldAutoDismiss({ phase: 'failed', version: '1.0.0' })).toBe(true);
  });

  it('keeps in-flight phases pinned', () => {
    expect(shouldAutoDismiss({ phase: 'installing', version: '1.0.0' })).toBe(false);
    expect(shouldAutoDismiss({ phase: 'restarting', version: '1.0.0' })).toBe(false);
    expect(shouldAutoDismiss({ phase: 'downloading', version: '1.0.0', downloaded: 1, total: 2 })).toBe(false);
  });
});

describe('isUpdateStatus', () => {
  it('accepts every well-formed phase payload', () => {
    const valid: UpdateStatus[] = [
      { phase: 'available', version: '1.0.0' },
      { phase: 'downloading', version: '1.0.0', downloaded: 1, total: 2 },
      { phase: 'installing', version: '1.0.0' },
      { phase: 'restarting', version: '1.0.0' },
      { phase: 'deferred', version: '1.0.0' },
      { phase: 'failed', version: '1.0.0' },
    ];
    for (const v of valid) {
      expect(isUpdateStatus(v)).toBe(true);
    }
  });

  it('rejects unknown, malformed, or non-object payloads (boundary guard)', () => {
    expect(isUpdateStatus({ phase: 'paused', version: '1.0.0' })).toBe(false); // drifted Rust variant
    expect(isUpdateStatus({ phase: 'available' })).toBe(false); // missing version
    expect(isUpdateStatus({ version: '1.0.0' })).toBe(false); // missing phase
    expect(isUpdateStatus({ phase: 7, version: '1.0.0' })).toBe(false); // non-string phase
    expect(isUpdateStatus(null)).toBe(false);
    expect(isUpdateStatus('downloading')).toBe(false);
    expect(isUpdateStatus(undefined)).toBe(false);
  });
});
