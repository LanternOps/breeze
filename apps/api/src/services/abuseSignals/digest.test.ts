import { describe, it, expect, beforeEach, vi } from 'vitest';

// Deliberately does NOT mock this module itself (unlike abuseSignalsSweep.test.ts) —
// these tests exercise runAbuseDigest's real branches around ops-alert config.
const { dbExecute, isOpsAlertingConfigured, sendOpsAlert } = vi.hoisted(() => ({
  dbExecute: vi.fn().mockResolvedValue([]),
  isOpsAlertingConfigured: vi.fn(),
  sendOpsAlert: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: { execute: dbExecute },
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));

vi.mock('../opsAlerts', () => ({
  isOpsAlertingConfigured,
  sendOpsAlert,
}));

import { runAbuseDigest } from './index';

beforeEach(() => {
  vi.clearAllMocks();
  dbExecute.mockResolvedValue([]);
});

describe('runAbuseDigest', () => {
  it('skips and warns without throwing when ops alerting is not configured', async () => {
    isOpsAlertingConfigured.mockReturnValue(false);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(runAbuseDigest()).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith('[AbuseSignals] Digest skipped — ops alerting not configured');
    expect(sendOpsAlert).not.toHaveBeenCalled();
    expect(dbExecute).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('throws when configured but delivery fails, so the job lands in the failed set', async () => {
    isOpsAlertingConfigured.mockReturnValue(true);
    sendOpsAlert.mockResolvedValue(false);

    await expect(runAbuseDigest()).rejects.toThrow('[AbuseSignals] Weekly digest delivery failed');
    expect(sendOpsAlert).toHaveBeenCalledTimes(1);
  });

  it('does not throw when configured and delivery succeeds', async () => {
    isOpsAlertingConfigured.mockReturnValue(true);
    sendOpsAlert.mockResolvedValue(true);

    await expect(runAbuseDigest()).resolves.toBeUndefined();
    expect(sendOpsAlert).toHaveBeenCalledTimes(1);
  });
});
