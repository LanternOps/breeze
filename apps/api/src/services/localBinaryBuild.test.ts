/**
 * #7516 — in BINARY_SOURCE=local mode the server holds ONE build per
 * (component, os, arch): the binaries volume. An upgrade offer naming any other
 * version is unsatisfiable by construction — the download route serves the
 * volume's bytes, which fail the offered version's checksum on every attempt.
 * These tests pin how the server learns which build it holds and when an offer
 * must be withheld.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetLocalBinaryBuildForTests,
  getLocalBinariesBuildVersion,
  isUpgradeTargetServable,
} from './localBinaryBuild';

const ENV_KEYS = [
  'BINARY_SOURCE',
  'BINARY_VERSION_FILE',
  'BINARY_VERSION',
  'BREEZE_BINARIES_VERSION',
  'BREEZE_VERSION',
] as const;

describe('localBinaryBuild (#7516)', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  let dir: string;
  let versionFile: string;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    dir = mkdtempSync(join(tmpdir(), 'breeze-7516-'));
    versionFile = join(dir, 'VERSION');
    __resetLocalBinaryBuildForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function localMode(volumeVersion: string | null): void {
    process.env.BINARY_SOURCE = 'local';
    if (volumeVersion !== null) {
      writeFileSync(versionFile, `${volumeVersion}\n`);
      process.env.BINARY_VERSION_FILE = versionFile;
    }
  }

  describe('getLocalBinariesBuildVersion', () => {
    it('reads the binaries-volume VERSION file (what registration used), trimmed', async () => {
      localMode('0.118.2');
      await expect(getLocalBinariesBuildVersion()).resolves.toBe('0.118.2');
    });

    it('prefers the VERSION file over BREEZE_VERSION: the file describes the bytes on disk', async () => {
      localMode('0.118.1');
      process.env.BREEZE_VERSION = '0.118.2';
      await expect(getLocalBinariesBuildVersion()).resolves.toBe('0.118.1');
    });

    it('falls back to the env-resolved binaries version when no VERSION file is configured', async () => {
      localMode(null);
      process.env.BREEZE_VERSION = '0.118.2';
      await expect(getLocalBinariesBuildVersion()).resolves.toBe('0.118.2');
    });

    it('falls back to the env version when the VERSION file is unreadable', async () => {
      localMode(null);
      process.env.BINARY_VERSION_FILE = join(dir, 'missing');
      process.env.BREEZE_VERSION = '0.118.2';
      await expect(getLocalBinariesBuildVersion()).resolves.toBe('0.118.2');
    });

    it('retries an unreadable VERSION file after a short TTL, not the full 60 s', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        localMode(null);
        process.env.BINARY_VERSION_FILE = versionFile; // not written yet
        process.env.BREEZE_VERSION = '0.118.3';
        await expect(getLocalBinariesBuildVersion()).resolves.toBe('0.118.3');
        writeFileSync(versionFile, '0.118.2\n'); // binaries-init finished
        vi.setSystemTime(Date.now() + 6_000);
        await expect(getLocalBinariesBuildVersion()).resolves.toBe('0.118.2');
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns null when nothing names the build (no file, env unresolvable)', async () => {
      localMode(null);
      await expect(getLocalBinariesBuildVersion()).resolves.toBeNull();
    });

    it('re-reads the VERSION file after the cache TTL, so a refreshed volume is seen without a restart', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        localMode('0.118.1');
        await expect(getLocalBinariesBuildVersion()).resolves.toBe('0.118.1');
        writeFileSync(versionFile, '0.118.2\n');
        // Inside the TTL the cached value stands (heartbeat hot path).
        await expect(getLocalBinariesBuildVersion()).resolves.toBe('0.118.1');
        vi.setSystemTime(Date.now() + 61_000);
        await expect(getLocalBinariesBuildVersion()).resolves.toBe('0.118.2');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('isUpgradeTargetServable', () => {
    const where = { component: 'agent', platform: 'windows', architecture: 'amd64' };

    it('the incident: local mode holds 0.118.2, promoted 0.118.1 → NOT servable (offer withheld)', async () => {
      localMode('0.118.2');
      await expect(isUpgradeTargetServable({ ...where, version: '0.118.1' })).resolves.toBe(false);
    });

    it('local mode, offer matches the volume build → servable', async () => {
      localMode('0.118.2');
      await expect(isUpgradeTargetServable({ ...where, version: '0.118.2' })).resolves.toBe(true);
    });

    it('treats a leading "v" on either side as the same release', async () => {
      localMode('v0.118.2');
      await expect(isUpgradeTargetServable({ ...where, version: '0.118.2' })).resolves.toBe(true);
      __resetLocalBinaryBuildForTests();
      localMode('0.118.2');
      await expect(isUpgradeTargetServable({ ...where, version: 'v0.118.2' })).resolves.toBe(true);
    });

    it('applies to every component the volume holds (backup, user-helper, watchdog, helper)', async () => {
      localMode('0.118.2');
      for (const component of ['backup', 'user-helper', 'watchdog', 'helper']) {
        await expect(
          isUpgradeTargetServable({ ...where, component, version: '0.118.1' }),
        ).resolves.toBe(false);
      }
    });

    it('a pin to a version the volume does not hold is withheld too (local mode cannot serve it)', async () => {
      localMode('0.118.2');
      await expect(isUpgradeTargetServable({ ...where, version: '0.117.0' })).resolves.toBe(false);
    });

    it('github mode serves per-version release assets → always servable', async () => {
      process.env.BINARY_SOURCE = 'github';
      process.env.BINARY_VERSION_FILE = versionFile;
      writeFileSync(versionFile, '0.118.2\n');
      process.env.BREEZE_VERSION = '0.118.2';
      await expect(isUpgradeTargetServable({ ...where, version: '0.118.1' })).resolves.toBe(true);
    });

    it('local mode with an unknown build → servable (cannot tell; unchanged behaviour)', async () => {
      localMode(null);
      await expect(isUpgradeTargetServable({ ...where, version: '0.118.1' })).resolves.toBe(true);
    });

    it('the "unknown" sentinel row was registered FROM the volume → servable', async () => {
      localMode(null);
      process.env.BREEZE_VERSION = '0.118.2';
      await expect(isUpgradeTargetServable({ ...where, version: 'unknown' })).resolves.toBe(true);
    });

    it('logs the withhold once per (component, platform, arch, target, build), not per heartbeat', async () => {
      localMode('0.118.2');
      const warn = vi.mocked(console.warn);
      await isUpgradeTargetServable({ ...where, version: '0.118.1' });
      await isUpgradeTargetServable({ ...where, version: '0.118.1' });
      const hits = warn.mock.calls.filter((c) => String(c[0]).includes('#7516'));
      expect(hits).toHaveLength(1);
      expect(String(hits[0]![0])).toContain('0.118.1');
      expect(String(hits[0]![0])).toContain('0.118.2');
    });
  });
});
