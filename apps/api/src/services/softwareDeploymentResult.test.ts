import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateMock = vi.fn();

vi.mock('../db', () => ({
  db: {
    update: (...args: unknown[]) => updateMock(...(args as [])),
  },
}));

vi.mock('../db/schema', () => ({
  deploymentResults: {
    deploymentId: 'deployment_results.deployment_id',
    deviceId: 'deployment_results.device_id',
    status: 'deployment_results.status',
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

function riggedUpdate() {
  const whereMock = vi.fn().mockResolvedValue(undefined);
  const setMock = vi.fn().mockReturnValue({ where: whereMock });
  updateMock.mockReturnValue({ set: setMock });
  return { setMock, whereMock };
}

describe('SW_INSTALL_COMMAND_ID_REGEX', () => {
  it('matches sw-install-<deploymentUuid>-<deviceUuid> and captures both ids', () => {
    const match = `sw-install-${DEPLOYMENT_ID}-${DEVICE_ID}`.match(SW_INSTALL_COMMAND_ID_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(DEPLOYMENT_ID);
    expect(match![2]).toBe(DEVICE_ID);
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

  it('guards the UPDATE on status=pending so double delivery is a no-op', async () => {
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
      ),
    );
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
