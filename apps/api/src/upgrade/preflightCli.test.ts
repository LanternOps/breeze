import { describe, expect, it } from 'vitest';
import { crashExitCode, strictRequested } from './preflightCli';
import { runUpgradePreflight } from './upgradePreflightRunner';

describe('runUpgradePreflight with a malformed DATABASE_URL', () => {
  // postgres() throws synchronously on an unparseable URL; that must become
  // the broad report, not a crash, like every other database failure.
  it('returns the broad report instead of throwing', async () => {
    const logger = { log: () => {}, warn: () => {} };
    const { report, exitCode } = await runUpgradePreflight({
      databaseUrl: 'not a url',
      currentVersion: '0.116.0',
      logger,
      strict: true,
    });
    expect(report.historyKnown).toBe(false);
    expect(report.historyNote).toMatch(/could not open a database connection/);
    expect(exitCode).toBe(1);
  });
});

describe('strictRequested', () => {
  it('is off by default', () => {
    expect(strictRequested([], {})).toBe(false);
    expect(strictRequested(['--json'], { BREEZE_UPGRADE_PREFLIGHT_STRICT: 'false' })).toBe(false);
    expect(strictRequested([], { BREEZE_UPGRADE_PREFLIGHT_STRICT: 'yes please' })).toBe(false);
  });

  it('turns on with --strict', () => {
    expect(strictRequested(['--strict'], {})).toBe(true);
  });

  it('turns on with BREEZE_UPGRADE_PREFLIGHT_STRICT=true or 1, tolerating case and whitespace', () => {
    expect(strictRequested([], { BREEZE_UPGRADE_PREFLIGHT_STRICT: 'true' })).toBe(true);
    expect(strictRequested([], { BREEZE_UPGRADE_PREFLIGHT_STRICT: ' TRUE ' })).toBe(true);
    expect(strictRequested([], { BREEZE_UPGRADE_PREFLIGHT_STRICT: '1' })).toBe(true);
  });
});

describe('crashExitCode', () => {
  it('fails only a strict run', () => {
    expect(crashExitCode(false)).toBe(0);
    expect(crashExitCode(true)).toBe(1);
  });
});
