import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveInstallRemediationMaxAttempts,
  resolveInstallRemediationMaxPerPass,
} from './softwareInstallRemediationKnobs';

const KEYS = [
  'SOFTWARE_INSTALL_REMEDIATION_MAX_PER_PASS',
  'SOFTWARE_INSTALL_REMEDIATION_MAX_ATTEMPTS',
] as const;

describe('softwareInstallRemediationKnobs', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    for (const key of KEYS) delete process.env[key];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key] as string;
    }
    vi.restoreAllMocks();
  });

  it('returns the documented defaults when unset', () => {
    expect(resolveInstallRemediationMaxPerPass()).toBe(50);
    expect(resolveInstallRemediationMaxAttempts()).toBe(3);
  });

  /**
   * THE POINT OF THIS FILE (contract D5). BACKUP_GC_GRACE_MS froze its knob at
   * module load (`export const X = resolveX()`, backupRetention.ts), so a
   * lab could set the env var and watch it do nothing. Two calls straddling an
   * env change must disagree; a module-load-cached implementation makes them
   * agree and this case goes red.
   */
  it('re-reads the environment on EVERY call, never caching at module load', () => {
    process.env.SOFTWARE_INSTALL_REMEDIATION_MAX_PER_PASS = '7';
    expect(resolveInstallRemediationMaxPerPass()).toBe(7);

    process.env.SOFTWARE_INSTALL_REMEDIATION_MAX_PER_PASS = '9';
    expect(resolveInstallRemediationMaxPerPass()).toBe(9);

    delete process.env.SOFTWARE_INSTALL_REMEDIATION_MAX_PER_PASS;
    expect(resolveInstallRemediationMaxPerPass()).toBe(50);
  });

  it('clamps to the floor of 1 in every environment, not just production', () => {
    process.env.SOFTWARE_INSTALL_REMEDIATION_MAX_PER_PASS = '0';
    process.env.SOFTWARE_INSTALL_REMEDIATION_MAX_ATTEMPTS = '-4';
    expect(resolveInstallRemediationMaxPerPass()).toBe(1);
    expect(resolveInstallRemediationMaxAttempts()).toBe(1);
  });

  it('falls back to the default for non-numeric, blank and fractional-below-floor input', () => {
    process.env.SOFTWARE_INSTALL_REMEDIATION_MAX_ATTEMPTS = 'three';
    expect(resolveInstallRemediationMaxAttempts()).toBe(3);

    process.env.SOFTWARE_INSTALL_REMEDIATION_MAX_ATTEMPTS = '   ';
    expect(resolveInstallRemediationMaxAttempts()).toBe(3);

    process.env.SOFTWARE_INSTALL_REMEDIATION_MAX_ATTEMPTS = 'Infinity';
    expect(resolveInstallRemediationMaxAttempts()).toBe(3);
  });

  it('floors a fractional override rather than carrying a fraction into a counter comparison', () => {
    process.env.SOFTWARE_INSTALL_REMEDIATION_MAX_ATTEMPTS = '2.9';
    expect(resolveInstallRemediationMaxAttempts()).toBe(2);
  });
});
