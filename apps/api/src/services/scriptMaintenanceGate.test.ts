import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./featureConfigResolver', () => ({ checkDeviceMaintenanceWindow: vi.fn() }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { checkDeviceMaintenanceWindow } from './featureConfigResolver';
import { captureException } from './sentry';
import {
  MAINTENANCE_CHECK_FAILED_MESSAGE,
  MAINTENANCE_SUPPRESSED_MESSAGE,
  checkScriptMaintenanceSuppression,
} from './scriptMaintenanceGate';

const status = (o: Record<string, unknown> = {}) => ({
  active: false,
  suppressAlerts: false,
  suppressPatching: false,
  suppressAutomations: false,
  suppressScripts: false,
  rebootIfPending: false,
  windowEndsAt: null,
  ...o,
}) as any;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('checkScriptMaintenanceSuppression (#4919)', () => {
  it('suppresses when a window is active AND suppressScripts is set', async () => {
    const endsAt = new Date('2030-01-01T00:00:00Z');
    vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue(
      status({ active: true, suppressScripts: true, windowEndsAt: endsAt }),
    );

    const v = await checkScriptMaintenanceSuppression('device-1');

    expect(v).toEqual({
      suppressed: true,
      reason: 'window_active',
      message: MAINTENANCE_SUPPRESSED_MESSAGE,
      windowEndsAt: endsAt,
    });
  });

  it('does NOT suppress an active window that only suppresses alerts/patching/automations', async () => {
    vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue(
      status({ active: true, suppressAlerts: true, suppressPatching: true, suppressAutomations: true }),
    );

    expect(await checkScriptMaintenanceSuppression('device-1')).toEqual({ suppressed: false });
  });

  it('does NOT suppress when suppressScripts is set on an INACTIVE window', async () => {
    vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue(
      status({ active: false, suppressScripts: true }),
    );

    expect(await checkScriptMaintenanceSuppression('device-1')).toEqual({ suppressed: false });
  });

  it('fails CLOSED when the resolve throws, with a message that does not claim a window exists', async () => {
    vi.mocked(checkDeviceMaintenanceWindow).mockRejectedValue(new Error('connection terminated'));

    const v = await checkScriptMaintenanceSuppression('device-1');

    expect(v).toEqual({
      suppressed: true,
      reason: 'check_failed',
      message: MAINTENANCE_CHECK_FAILED_MESSAGE,
      windowEndsAt: null,
    });
    expect(v.suppressed && v.message).not.toBe(MAINTENANCE_SUPPRESSED_MESSAGE);
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
