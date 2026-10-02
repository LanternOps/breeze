import { describe, it, expect } from 'vitest';
import {
  updateProgressPercent,
  updateStatusMessage,
  isUpdateActive,
  parseUpdateStatus,
  autoDismissMs,
  statusAfterApplyRejected,
  type UpdateStatus,
} from './updateStatus';

const failed = (overrides: Partial<Extract<UpdateStatus, { phase: 'failed' }>> = {}): UpdateStatus => ({
  phase: 'failed',
  version: '1.0.0',
  stage: 'download',
  error: 'timed out',
  logPath: null,
  ...overrides,
});

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
    expect(updateStatusMessage(failed({ version: '1.2.3' }))).toMatch(/failed/i);
    expect(updateStatusMessage(failed({ version: '1.2.3' }))).toMatch(/retry/i);
  });

  // #7681: "failed — will retry" alone gave no way to tell a download problem
  // from a bad signature from an installer that would not unpack.
  it('names the stage a failed update died at', () => {
    expect(updateStatusMessage(failed({ version: '0.119.0', stage: 'download' }))).toBe(
      'Update 0.119.0 failed while downloading — will retry on next launch.',
    );
    expect(updateStatusMessage(failed({ version: '0.119.0', stage: 'verify' }))).toBe(
      'Update 0.119.0 failed while verifying its signature — will retry on next launch.',
    );
    expect(updateStatusMessage(failed({ version: '0.119.0', stage: 'extract' }))).toBe(
      'Update 0.119.0 failed while unpacking the installer — will retry on next launch.',
    );
    expect(updateStatusMessage(failed({ version: '0.119.0', stage: 'install' }))).toBe(
      'Update 0.119.0 failed while installing — will retry on next launch.',
    );
  });

  it('covers every phase with a non-empty message', () => {
    const phases: UpdateStatus[] = [
      { phase: 'available', version: '1.0.0' },
      { phase: 'downloading', version: '1.0.0', downloaded: 1, total: 2 },
      { phase: 'installing', version: '1.0.0' },
      { phase: 'restarting', version: '1.0.0' },
      { phase: 'deferred', version: '1.0.0' },
      failed(),
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
    expect(isUpdateActive(failed())).toBe(false);
  });
});

describe('autoDismissMs', () => {
  it('auto-dismisses terminal notices (deferred / failed)', () => {
    expect(autoDismissMs({ phase: 'deferred', version: '1.0.0' })).toBe(10_000);
    // A failure carries an error and a log path to read, so it lingers longer.
    expect(autoDismissMs(failed())).toBe(30_000);
  });

  it('keeps in-flight phases pinned', () => {
    expect(autoDismissMs({ phase: 'installing', version: '1.0.0' })).toBeNull();
    expect(autoDismissMs({ phase: 'restarting', version: '1.0.0' })).toBeNull();
    expect(autoDismissMs({ phase: 'downloading', version: '1.0.0', downloaded: 1, total: 2 })).toBeNull();
  });
});

describe('statusAfterApplyRejected', () => {
  it('keeps the detailed failure Rust already emitted for this version', () => {
    const detailed = failed({
      version: '0.119.0',
      stage: 'extract',
      error: 'unsupported Zip archive: Compression method not supported',
      logPath: 'C:\\logs\\updater.log',
    });
    expect(statusAfterApplyRejected(detailed, '0.119.0', 'unsupported Zip archive')).toBe(detailed);
  });

  it('builds an install failure from the rejection when Rust reported nothing', () => {
    const installing: UpdateStatus = { phase: 'installing', version: '0.119.0' };
    expect(statusAfterApplyRejected(installing, '0.119.0', 'no pending update to apply')).toEqual({
      phase: 'failed',
      version: '0.119.0',
      stage: 'install',
      error: 'no pending update to apply',
      logPath: null,
    });
    expect(statusAfterApplyRejected(null, '0.119.0', new Error('boom'))).toMatchObject({ error: 'boom' });
  });

  it('does not keep a stale failure from a different version', () => {
    const stale = failed({ version: '0.118.0' });
    expect(statusAfterApplyRejected(stale, '0.119.0', 'nope')).toMatchObject({
      version: '0.119.0',
      error: 'nope',
    });
  });
});

describe('ready phase', () => {
  const ready: UpdateStatus = { phase: 'ready', version: '1.2.3' };

  it('messages as a downloaded-and-waiting prompt', () => {
    // Rust only reaches `ready` after download() returned, which is after the
    // signature check — say so, since a later failure is then an install one.
    expect(updateStatusMessage(ready)).toBe('Update 1.2.3 downloaded and verified');
  });

  it('is not "active" (no progress affordance)', () => {
    expect(isUpdateActive(ready)).toBe(false);
  });

  it('does not auto-dismiss (stays pinned until the user acts)', () => {
    expect(autoDismissMs(ready)).toBeNull();
  });

  it('is accepted by the IPC-boundary guard', () => {
    expect(parseUpdateStatus({ phase: 'ready', version: '1.2.3' })).toEqual(ready);
  });
});

describe('parseUpdateStatus', () => {
  it('accepts every well-formed phase payload', () => {
    const valid: UpdateStatus[] = [
      { phase: 'available', version: '1.0.0' },
      { phase: 'downloading', version: '1.0.0', downloaded: 1, total: 2 },
      { phase: 'installing', version: '1.0.0' },
      { phase: 'restarting', version: '1.0.0' },
      { phase: 'deferred', version: '1.0.0' },
      failed(),
      failed({ stage: 'extract', logPath: '/var/log/updater.log' }),
      { phase: 'ready', version: '1.2.3' },
    ];
    for (const v of valid) {
      expect(parseUpdateStatus(v)).toEqual(v);
    }
  });

  it('rejects unknown, malformed, or non-object payloads (boundary guard)', () => {
    expect(parseUpdateStatus({ phase: 'paused', version: '1.0.0' })).toBeNull(); // drifted Rust variant
    expect(parseUpdateStatus({ phase: 'available' })).toBeNull(); // missing version
    expect(parseUpdateStatus({ version: '1.0.0' })).toBeNull(); // missing phase
    expect(parseUpdateStatus({ phase: 7, version: '1.0.0' })).toBeNull(); // non-string phase
    expect(parseUpdateStatus({ phase: 'toString', version: '1.0.0' })).toBeNull(); // prototype key
    expect(parseUpdateStatus(null)).toBeNull();
    expect(parseUpdateStatus('downloading')).toBeNull();
    expect(parseUpdateStatus(undefined)).toBeNull();
  });

  // A failure must always reach the banner: dropping it would leave the
  // banner pinned on "Downloading…"/"Installing…", the very symptom of #7681.
  // So a failed payload with drifted detail fields degrades instead.
  it('keeps a failed payload whose detail fields drifted, degrading them', () => {
    const base = { phase: 'failed', version: '1.0.0', stage: 'download', error: 'x', logPath: null };
    expect(parseUpdateStatus(base)).toEqual(base);

    const drifted = parseUpdateStatus({ ...base, stage: 'unpack', error: 42, logPath: 7 });
    expect(drifted).toEqual({ ...base, stage: null, error: '', logPath: null });
    expect(updateStatusMessage(drifted!)).toBe('Update 1.0.0 failed — will retry on next launch.');

    // Prototype keys are not stages.
    expect(parseUpdateStatus({ ...base, stage: 'toString' })).toMatchObject({ stage: null });
    // Pre-#7681 shape (no detail at all) still shows a failure.
    expect(parseUpdateStatus({ phase: 'failed', version: '1.0.0' })).toEqual({
      ...base,
      stage: null,
      error: '',
    });
  });
});
