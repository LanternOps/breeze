import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateMock = vi.fn();

vi.mock('../db', () => ({
  db: {
    update: (...args: unknown[]) => updateMock(...(args as [])),
  },
}));

vi.mock('../db/schema', () => ({
  deploymentResults: {
    id: 'deployment_results.id',
    deploymentId: 'deployment_results.deployment_id',
    deviceId: 'deployment_results.device_id',
    status: 'deployment_results.status',
    retryCount: 'deployment_results.retry_count',
  },
}));

import { and, eq } from 'drizzle-orm';
import { deploymentResults } from '../db/schema';
import {
  applySoftwareInstallResult,
  SW_INSTALL_COMMAND_ID_REGEX,
} from './softwareDeploymentResult';

const DEPLOYMENT_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '33333333-3333-4333-8333-333333333333';

// A complete, well-formed PEM private-key block that the redaction chokepoint
// must strip from persisted output/errorMessage.
const PRIVATE_KEY_BLOCK = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDexampleAAAA1234',
  '-----END PRIVATE KEY-----',
].join('\n');

/** Legacy shape: `.where()` resolves directly, with no `.returning()` method — matches the pre-#returning callers this helper originally modeled. */
function riggedUpdate() {
  const whereMock = vi.fn().mockResolvedValue(undefined);
  const setMock = vi.fn().mockReturnValue({ where: whereMock });
  updateMock.mockReturnValue({ set: setMock });
  return { setMock, whereMock };
}

/** Modern shape: `.where()` returns an object exposing `.returning()`, so the guard's row-count check (and its rejection logging) actually exercises. */
function riggedUpdateWithReturning(returningRows: unknown[]) {
  const returningMock = vi.fn().mockResolvedValue(returningRows);
  const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
  const setMock = vi.fn().mockReturnValue({ where: whereMock });
  updateMock.mockReturnValue({ set: setMock });
  return { setMock, whereMock, returningMock };
}

describe('SW_INSTALL_COMMAND_ID_REGEX', () => {
  it('matches sw-install-<deploymentUuid>-<deviceUuid> with no attempt suffix and captures both ids', () => {
    const match = `sw-install-${DEPLOYMENT_ID}-${DEVICE_ID}`.match(SW_INSTALL_COMMAND_ID_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(DEPLOYMENT_ID);
    expect(match![2]).toBe(DEVICE_ID);
    expect(match![3]).toBeUndefined();
  });

  it('matches sw-install-<deploymentUuid>-<deviceUuid>-<attempt> and captures the attempt number', () => {
    const match = `sw-install-${DEPLOYMENT_ID}-${DEVICE_ID}-2`.match(SW_INSTALL_COMMAND_ID_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(DEPLOYMENT_ID);
    expect(match![2]).toBe(DEVICE_ID);
    expect(match![3]).toBe('2');
  });

  it('captures a zero attempt suffix explicitly rather than treating it as absent', () => {
    const match = `sw-install-${DEPLOYMENT_ID}-${DEVICE_ID}-0`.match(SW_INSTALL_COMMAND_ID_REGEX);
    expect(match![3]).toBe('0');
  });

  it('rejects other command id shapes', () => {
    expect('dev-push-abc'.match(SW_INSTALL_COMMAND_ID_REGEX)).toBeNull();
    expect(`sw-install-${DEPLOYMENT_ID}`.match(SW_INSTALL_COMMAND_ID_REGEX)).toBeNull();
    expect('22222222-2222-4222-8222-222222222222'.match(SW_INSTALL_COMMAND_ID_REGEX)).toBeNull();
  });
});

describe('applySoftwareInstallResult', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps completed + exit code 0 to completed', async () => {
    const { setMock } = riggedUpdate();

    await applySoftwareInstallResult({
      deploymentId: DEPLOYMENT_ID,
      deviceId: DEVICE_ID,
      status: 'completed',
      exitCode: 0,
      stdout: 'installed ok',
    });

    const stored = setMock.mock.calls[0]![0];
    expect(stored.status).toBe('completed');
    expect(stored.exitCode).toBe(0);
    expect(stored.output).toBe('installed ok');
    expect(stored.completedAt).toBeInstanceOf(Date);
  });

  it('maps completed + non-zero exit code to failed', async () => {
    const { setMock } = riggedUpdate();

    await applySoftwareInstallResult({
      deploymentId: DEPLOYMENT_ID,
      deviceId: DEVICE_ID,
      status: 'completed',
      exitCode: 1603,
      stderr: 'msi fatal error',
    });

    const stored = setMock.mock.calls[0]![0];
    expect(stored.status).toBe('failed');
    expect(stored.exitCode).toBe(1603);
    // No error field → stderr becomes the errorMessage.
    expect(stored.errorMessage).toBe('msi fatal error');
  });

  it.each(['failed', 'timeout'] as const)('maps agent status %s to failed', async (status) => {
    const { setMock } = riggedUpdate();

    await applySoftwareInstallResult({
      deploymentId: DEPLOYMENT_ID,
      deviceId: DEVICE_ID,
      status,
      error: 'download failed',
    });

    const stored = setMock.mock.calls[0]![0];
    expect(stored.status).toBe('failed');
    expect(stored.errorMessage).toBe('download failed');
    expect(stored.exitCode).toBeNull();
  });

  it('guards the UPDATE on status=pending AND retryCount=attempt (default 0) so double delivery is a no-op', async () => {
    const { whereMock } = riggedUpdate();

    await applySoftwareInstallResult({
      deploymentId: DEPLOYMENT_ID,
      deviceId: DEVICE_ID,
      status: 'completed',
      exitCode: 0,
    });

    expect(whereMock).toHaveBeenCalledWith(
      and(
        eq(deploymentResults.deploymentId, DEPLOYMENT_ID),
        eq(deploymentResults.deviceId, DEVICE_ID),
        eq(deploymentResults.status, 'pending'),
        eq(deploymentResults.retryCount, 0),
      ),
    );
  });

  it('guards the UPDATE on the explicit attemptNumber when provided', async () => {
    const { whereMock } = riggedUpdate();

    await applySoftwareInstallResult({
      deploymentId: DEPLOYMENT_ID,
      deviceId: DEVICE_ID,
      status: 'completed',
      exitCode: 0,
      attemptNumber: 3,
    });

    expect(whereMock).toHaveBeenCalledWith(
      and(
        eq(deploymentResults.deploymentId, DEPLOYMENT_ID),
        eq(deploymentResults.deviceId, DEVICE_ID),
        eq(deploymentResults.status, 'pending'),
        eq(deploymentResults.retryCount, 3),
      ),
    );
  });

  // Race-condition coverage (retry re-dispatch under a new command id): a
  // late result carrying a superseded attempt number must never be applied,
  // even though its deploymentId/deviceId and status='pending' would
  // otherwise match — this is what stops attempt-1's late completion from
  // landing on attempt-2's fresh 'pending' row after a retry.
  describe('retry-race attempt guard', () => {
    it('(a) rejects a late result carrying the OLD attempt suffix after a retry bumped retryCount', async () => {
      // The row is currently on its 2nd attempt (retryCount=2, i.e. one
      // retry happened after the original dispatch). A stale result from the
      // superseded attempt-1 command id arrives late and must not apply —
      // simulated here by the UPDATE's retryCount=1 condition matching zero
      // real rows (the row is actually at retryCount=2).
      const { whereMock, returningMock } = riggedUpdateWithReturning([]);

      await applySoftwareInstallResult({
        deploymentId: DEPLOYMENT_ID,
        deviceId: DEVICE_ID,
        status: 'completed',
        exitCode: 0,
        attemptNumber: 1,
      });

      expect(whereMock).toHaveBeenCalledWith(
        and(
          eq(deploymentResults.deploymentId, DEPLOYMENT_ID),
          eq(deploymentResults.deviceId, DEVICE_ID),
          eq(deploymentResults.status, 'pending'),
          eq(deploymentResults.retryCount, 1),
        ),
      );
      expect(returningMock).toHaveBeenCalled();
    });

    it('(b) applies a result whose attempt number matches the row current retryCount', async () => {
      const { setMock, whereMock } = riggedUpdateWithReturning([{ id: 'dr-row-1' }]);

      await applySoftwareInstallResult({
        deploymentId: DEPLOYMENT_ID,
        deviceId: DEVICE_ID,
        status: 'completed',
        exitCode: 0,
        stdout: 'installed ok',
        attemptNumber: 2,
      });

      expect(whereMock).toHaveBeenCalledWith(
        and(
          eq(deploymentResults.deploymentId, DEPLOYMENT_ID),
          eq(deploymentResults.deviceId, DEVICE_ID),
          eq(deploymentResults.status, 'pending'),
          eq(deploymentResults.retryCount, 2),
        ),
      );
      const stored = setMock.mock.calls[0]![0];
      expect(stored.status).toBe('completed');
      expect(stored.output).toBe('installed ok');
    });

    it('(c) applies a legacy command id with no attempt suffix (defaults to 0) when retryCount is still 0', async () => {
      const { setMock, whereMock } = riggedUpdateWithReturning([{ id: 'dr-row-1' }]);

      // No attemptNumber passed — mirrors a command id parsed with the
      // optional suffix absent (pre-fix in-flight command).
      await applySoftwareInstallResult({
        deploymentId: DEPLOYMENT_ID,
        deviceId: DEVICE_ID,
        status: 'completed',
        exitCode: 0,
      });

      expect(whereMock).toHaveBeenCalledWith(
        and(
          eq(deploymentResults.deploymentId, DEPLOYMENT_ID),
          eq(deploymentResults.deviceId, DEVICE_ID),
          eq(deploymentResults.status, 'pending'),
          eq(deploymentResults.retryCount, 0),
        ),
      );
      const stored = setMock.mock.calls[0]![0];
      expect(stored.status).toBe('completed');
    });

    it('logs a rejection warning when the attempt guard drops a result', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      riggedUpdateWithReturning([]);

      await applySoftwareInstallResult({
        deploymentId: DEPLOYMENT_ID,
        deviceId: DEVICE_ID,
        status: 'completed',
        exitCode: 0,
        attemptNumber: 1,
      });

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('attempt=1'));
      warnSpy.mockRestore();
    });

    it('does not warn when the update applies normally', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      riggedUpdateWithReturning([{ id: 'dr-row-1' }]);

      await applySoftwareInstallResult({
        deploymentId: DEPLOYMENT_ID,
        deviceId: DEVICE_ID,
        status: 'completed',
        exitCode: 0,
        attemptNumber: 2,
      });

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  it('prefers agent-reported startedAt over durationMs reconstruction', async () => {
    const { setMock } = riggedUpdate();
    const startedAt = '2026-07-28T10:00:00.000Z';

    await applySoftwareInstallResult({
      deploymentId: DEPLOYMENT_ID,
      deviceId: DEVICE_ID,
      status: 'completed',
      exitCode: 0,
      startedAt,
      durationMs: 60_000,
    });

    const stored = setMock.mock.calls[0]![0];
    expect(stored.startedAt).toEqual(new Date(startedAt));
  });

  it('reconstructs startedAt from durationMs for pre-startedAt agents', async () => {
    const { setMock } = riggedUpdate();

    await applySoftwareInstallResult({
      deploymentId: DEPLOYMENT_ID,
      deviceId: DEVICE_ID,
      status: 'completed',
      exitCode: 0,
      durationMs: 30_000,
    });

    const stored = setMock.mock.calls[0]![0];
    expect(stored.completedAt.getTime() - stored.startedAt.getTime()).toBe(30_000);
  });

  it('falls back to completedAt when neither startedAt nor durationMs is present', async () => {
    const { setMock } = riggedUpdate();

    await applySoftwareInstallResult({
      deploymentId: DEPLOYMENT_ID,
      deviceId: DEVICE_ID,
      status: 'failed',
    });

    const stored = setMock.mock.calls[0]![0];
    expect(stored.startedAt).toEqual(stored.completedAt);
  });

  it('redacts private-key blocks from output and errorMessage before persisting', async () => {
    const { setMock } = riggedUpdate();

    await applySoftwareInstallResult({
      deploymentId: DEPLOYMENT_ID,
      deviceId: DEVICE_ID,
      status: 'completed',
      exitCode: 0,
      stdout: `install-log ${PRIVATE_KEY_BLOCK} done`,
      error: `install-error ${PRIVATE_KEY_BLOCK} boom`,
    });

    const stored = setMock.mock.calls[0]![0];
    expect(stored.output).toBe('install-log [PRIVATE_KEY_REDACTED] done');
    expect(stored.errorMessage).toBe('install-error [PRIVATE_KEY_REDACTED] boom');
    expect(JSON.stringify(stored)).not.toContain('BEGIN PRIVATE KEY');
  });

  it('stores null output/errorMessage when the agent supplied none', async () => {
    const { setMock } = riggedUpdate();

    await applySoftwareInstallResult({
      deploymentId: DEPLOYMENT_ID,
      deviceId: DEVICE_ID,
      status: 'completed',
      exitCode: 0,
    });

    const stored = setMock.mock.calls[0]![0];
    expect(stored.output).toBeNull();
    expect(stored.errorMessage).toBeNull();
  });
});
