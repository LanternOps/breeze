import { describe, it, expect, vi, beforeEach } from 'vitest';

// #4919 — the maintenance-window gate moved INTO dispatchScriptToDevice so
// every caller (HTTP, AI tool, automation, edition auto-migrate) inherits it.
// This file proves the gate fires before ANY write happens, that it is
// fail-closed, and that the opt-out exists but is off by default.

vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./commandQueue', async () => {
  const { CommandTypes } = await import('./commandTypes');
  return { CommandTypes, queueCommand: vi.fn() };
});
vi.mock('./commandDispatch', () => ({
  claimPendingCommandForDelivery: vi.fn().mockResolvedValue(null),
  releaseClaimedCommandDelivery: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./sensitiveCommandPayload', () => ({
  encryptSensitivePayloadFields: vi.fn((_t: string, p: unknown) => p),
  decryptCommandForDelivery: vi.fn((c: unknown) => c),
  toAgentCommandFrame: vi.fn((c: unknown) => c),
}));
vi.mock('../routes/agentWs', () => ({ sendCommandToAgent: vi.fn().mockReturnValue(false) }));
vi.mock('./scriptSecretDelivery', () => ({
  AGENT_UPGRADE_REQUIRED_MESSAGE: 'Agent upgrade required: mocked message',
  SECRET_GATE_UNAVAILABLE_MESSAGE: 'Secret gate unavailable: mocked message',
  secretDeliveryPreflight: vi.fn().mockResolvedValue({ ok: true }),
  failClaimedSecretCommandsForUnsupportedAgent: vi.fn((claimed: unknown[]) => Promise.resolve(claimed)),
}));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
// The real gate is unit-tested in scriptMaintenanceGate.test.ts. Here it is
// mocked so this file tests the WIRING: that dispatch consults it, refuses on
// its verdict, and writes nothing when it does.
vi.mock('./scriptMaintenanceGate', () => ({
  MAINTENANCE_SUPPRESSED_MESSAGE: 'Device is in a maintenance window that suppresses script execution',
  MAINTENANCE_CHECK_FAILED_MESSAGE: 'Maintenance window could not be evaluated for this device; refusing to run the script (fail-closed)',
  checkScriptMaintenanceSuppression: vi.fn().mockResolvedValue({ suppressed: false }),
}));

import { db } from '../db';
import { queueCommand } from './commandQueue';
import { checkScriptMaintenanceSuppression } from './scriptMaintenanceGate';
import { dispatchScriptToDevice } from './scriptDispatch';

const savedScript = (o = {}) => ({
  id: 'script-1', orgId: 'org-a', partnerId: null, isSystem: false,
  osTypes: ['linux'], language: 'bash', content: 'echo hi',
  timeoutSeconds: 60, runAs: 'system', deletedAt: null, parameters: null, ...o,
}) as any;

const device = (o = {}) => ({
  id: 'device-1', orgId: 'org-a', osType: 'linux', status: 'online', agentId: null,
  hostname: 'host-1', siteId: 'site-1', customFields: {}, ...o,
}) as any;

const suppressed = (reason: 'window_active' | 'check_failed', message: string) => ({
  suppressed: true as const,
  reason,
  message,
  windowEndsAt: reason === 'window_active' ? new Date('2030-01-01T00:00:00Z') : null,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.insert).mockReturnValue({
    values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'exec-1' }]) }),
  } as any);
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ status: 'online' }]) }),
    }),
  } as any);
  vi.mocked(queueCommand).mockResolvedValue({ id: 'cmd-1', payload: {} } as any);
  vi.mocked(checkScriptMaintenanceSuppression).mockResolvedValue({ suppressed: false });
});

describe('dispatchScriptToDevice — maintenance window gate (#4919)', () => {
  it('refuses a saved script when the device window suppresses scripts', async () => {
    vi.mocked(checkScriptMaintenanceSuppression).mockResolvedValue(
      suppressed('window_active', 'Device is in a maintenance window that suppresses script execution'),
    );

    const r = await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'saved', script: savedScript() },
    });

    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ code: 'maintenance_suppressed' });
    expect(r.ok === false && r.error).toContain('maintenance window');
  });

  it('writes NO execution row and enqueues NO command when suppressed', async () => {
    vi.mocked(checkScriptMaintenanceSuppression).mockResolvedValue(
      suppressed('window_active', 'Device is in a maintenance window that suppresses script execution'),
    );

    await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'saved', script: savedScript() },
    });

    expect(db.insert).not.toHaveBeenCalled();
    expect(queueCommand).not.toHaveBeenCalled();
  });

  it('refuses a RAW (execute_command) dispatch too — not just saved scripts', async () => {
    vi.mocked(checkScriptMaintenanceSuppression).mockResolvedValue(
      suppressed('window_active', 'Device is in a maintenance window that suppresses script execution'),
    );

    const r = await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'raw', content: 'whoami', language: 'bash', provenance: 'automation:a-1' },
    });

    expect(r).toMatchObject({ ok: false, code: 'maintenance_suppressed' });
    expect(queueCommand).not.toHaveBeenCalled();
  });

  it('is fail-closed: a gate that could not evaluate the window still refuses, with a distinct message', async () => {
    vi.mocked(checkScriptMaintenanceSuppression).mockResolvedValue(
      suppressed('check_failed', 'Maintenance window could not be evaluated for this device; refusing to run the script (fail-closed)'),
    );

    const r = await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'saved', script: savedScript() },
    });

    expect(r).toMatchObject({ ok: false, code: 'maintenance_suppressed' });
    expect(r.ok === false && r.error).toContain('fail-closed');
    expect(queueCommand).not.toHaveBeenCalled();
  });

  it('dispatches normally when no window suppresses scripts', async () => {
    const r = await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'saved', script: savedScript() },
    });

    expect(r.ok).toBe(true);
    expect(queueCommand).toHaveBeenCalled();
  });

  it('bypassMaintenanceWindow skips the gate entirely (hook for a future per-automation override)', async () => {
    vi.mocked(checkScriptMaintenanceSuppression).mockResolvedValue(
      suppressed('window_active', 'Device is in a maintenance window that suppresses script execution'),
    );

    const r = await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'saved', script: savedScript() },
      bypassMaintenanceWindow: true,
    });

    expect(r.ok).toBe(true);
    expect(checkScriptMaintenanceSuppression).not.toHaveBeenCalled();
  });

  it('checks the window before the decommissioned/offline gates spend a query — decommissioned still wins', async () => {
    // Decommission is terminal and needs no DB read, so it stays first; the
    // gate must not be consulted for a device that can never run anything.
    const r = await dispatchScriptToDevice({
      device: device({ status: 'decommissioned' }),
      source: { kind: 'saved', script: savedScript() },
    });

    expect(r).toMatchObject({ ok: false, code: 'device_decommissioned' });
    expect(checkScriptMaintenanceSuppression).not.toHaveBeenCalled();
  });
});
