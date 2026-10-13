import { describe, expect, it } from 'vitest';
import {
  WATCHDOG_INSTALL_BANNER_STATES,
  WATCHDOG_INSTALL_ERROR_CLASSES,
  WATCHDOG_INSTALL_STATES,
  deriveWatchdogInstallBanner,
  parseWatchdogInstall,
  planWatchdogInstallWrite,
} from './watchdogInstallHealth';

const NOW = new Date('2026-12-26T12:00:00.000Z');
const EARLIER = new Date('2026-12-20T00:00:00.000Z');
const blank = { watchdogInstallState: null, watchdogInstallErrorClass: null, watchdogInstallSince: null };

describe('parseWatchdogInstall', () => {
  it('undefined is absent', () => {
    expect(parseWatchdogInstall(undefined)).toEqual({ kind: 'absent' });
  });

  it('mirrors the agent state and error-class vocabularies exactly', () => {
    expect([...WATCHDOG_INSTALL_STATES]).toEqual([
      'retrying', 'gave_up', 'opted_out', 'unsupported', 'disabled_by_policy',
    ]);
    expect([...WATCHDOG_INSTALL_ERROR_CLASSES]).toEqual([
      'network', 'server', 'policy', 'signature', 'checksum', 'dev_build',
      'unsupported_os', 'install_cmd', 'locked', 'unknown',
    ]);
  });

  it('accepts a full agent report', () => {
    expect(
      parseWatchdogInstall({
        state: 'gave_up', attempts: 7, lastAttemptAt: '2026-12-26T11:00:00Z', lastErrorClass: 'signature',
      }),
    ).toEqual({ kind: 'ok', state: 'gave_up', errorClass: 'signature' });
  });

  it('state only -> errorClass null', () => {
    expect(parseWatchdogInstall({ state: 'opted_out' })).toEqual({ kind: 'ok', state: 'opted_out', errorClass: null });
  });

  it('an unknown error class collapses to unknown without invalidating the report', () => {
    expect(parseWatchdogInstall({ state: 'gave_up', lastErrorClass: 'novel_class' })).toEqual({
      kind: 'ok', state: 'gave_up', errorClass: 'unknown',
    });
  });

  it.each([
    ['garbage string', 'garbage'],
    ['null', null],
    ['array', []],
    ['unknown state', { state: 'x' }],
    ['missing state', { attempts: 3 }],
    ['attempts out of range', { state: 'gave_up', attempts: 1_000_000 }],
    ['non-int attempts', { state: 'gave_up', attempts: 1.5 }],
    ['non-string state', { state: 5 }],
  ])('malformed (%s) is invalid, never coerced', (_n, raw) => {
    expect(parseWatchdogInstall(raw)).toEqual({ kind: 'invalid' });
  });

  it('a bad lastAttemptAt does not invalidate an otherwise valid report', () => {
    expect(parseWatchdogInstall({ state: 'retrying', lastAttemptAt: 'yesterday' })).toEqual({
      kind: 'ok', state: 'retrying', errorClass: null,
    });
  });
});

describe('planWatchdogInstallWrite', () => {
  it('absent on a blank row writes nothing', () => {
    expect(planWatchdogInstallWrite(blank, { kind: 'absent' }, NOW)).toEqual({});
  });

  it('invalid never changes anything, including an existing gave_up', () => {
    const row = { watchdogInstallState: 'gave_up', watchdogInstallErrorClass: 'signature', watchdogInstallSince: EARLIER };
    expect(planWatchdogInstallWrite(row, { kind: 'invalid' }, NOW)).toEqual({});
    expect(planWatchdogInstallWrite(blank, { kind: 'invalid' }, NOW)).toEqual({});
  });

  it('absent clears all three on a row that had a state', () => {
    const row = { watchdogInstallState: 'gave_up', watchdogInstallErrorClass: 'signature', watchdogInstallSince: EARLIER };
    expect(planWatchdogInstallWrite(row, { kind: 'absent' }, NOW)).toEqual({
      watchdogInstallState: null, watchdogInstallErrorClass: null, watchdogInstallSince: null,
    });
  });

  it('first report writes all three with since = now', () => {
    expect(
      planWatchdogInstallWrite(blank, { kind: 'ok', state: 'gave_up', errorClass: 'signature' }, NOW),
    ).toEqual({ watchdogInstallState: 'gave_up', watchdogInstallErrorClass: 'signature', watchdogInstallSince: NOW });
  });

  it('first report with no class writes state and since only', () => {
    expect(planWatchdogInstallWrite(blank, { kind: 'ok', state: 'opted_out', errorClass: null }, NOW)).toEqual({
      watchdogInstallState: 'opted_out', watchdogInstallSince: NOW,
    });
  });

  it('identical report adds zero keys and does not move since', () => {
    const row = { watchdogInstallState: 'gave_up', watchdogInstallErrorClass: 'signature', watchdogInstallSince: EARLIER };
    expect(planWatchdogInstallWrite(row, { kind: 'ok', state: 'gave_up', errorClass: 'signature' }, NOW)).toEqual({});
  });

  it('same state, new class updates the class only; since is kept', () => {
    const row = { watchdogInstallState: 'retrying', watchdogInstallErrorClass: 'network', watchdogInstallSince: EARLIER };
    expect(planWatchdogInstallWrite(row, { kind: 'ok', state: 'retrying', errorClass: 'server' }, NOW)).toEqual({
      watchdogInstallErrorClass: 'server',
    });
  });

  it('state change moves since; unchanged class is not rewritten', () => {
    const row = { watchdogInstallState: 'retrying', watchdogInstallErrorClass: 'network', watchdogInstallSince: EARLIER };
    expect(planWatchdogInstallWrite(row, { kind: 'ok', state: 'gave_up', errorClass: 'network' }, NOW)).toEqual({
      watchdogInstallState: 'gave_up', watchdogInstallSince: NOW,
    });
  });

  it('a state with no class clears a stale class', () => {
    const row = { watchdogInstallState: 'retrying', watchdogInstallErrorClass: 'network', watchdogInstallSince: EARLIER };
    expect(planWatchdogInstallWrite(row, { kind: 'ok', state: 'opted_out', errorClass: null }, NOW)).toEqual({
      watchdogInstallState: 'opted_out', watchdogInstallErrorClass: null, watchdogInstallSince: NOW,
    });
  });
});

describe('deriveWatchdogInstallBanner', () => {
  it('only terminal failure states surface', () => {
    expect([...WATCHDOG_INSTALL_BANNER_STATES]).toEqual(['gave_up', 'unsupported']);
  });

  it.each(['retrying', 'opted_out', 'disabled_by_policy', null, 'something_else'])(
    '%s is not shown',
    (state) => {
      expect(
        deriveWatchdogInstallBanner({ watchdogInstallState: state, watchdogInstallErrorClass: 'network', watchdogInstallSince: EARLIER }),
      ).toBeNull();
    },
  );

  it('gave_up exposes state, class and since (ISO) only', () => {
    expect(
      deriveWatchdogInstallBanner({ watchdogInstallState: 'gave_up', watchdogInstallErrorClass: 'signature', watchdogInstallSince: EARLIER }),
    ).toEqual({ state: 'gave_up', errorClass: 'signature', since: EARLIER.toISOString() });
  });

  it('an out-of-vocabulary stored class is reported as unknown', () => {
    expect(
      deriveWatchdogInstallBanner({ watchdogInstallState: 'gave_up', watchdogInstallErrorClass: 'weird', watchdogInstallSince: null }),
    ).toEqual({ state: 'gave_up', errorClass: 'unknown', since: null });
  });
});
