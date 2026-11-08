import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const audit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./auditService', () => ({ createAuditLogAsync: audit }));

import { runWithAuditRequestTracking, markRequestAuditWritten } from './auditRequestTracking';
import {
  reportInvalidStoredSettings,
  resetInvalidStoredSettingsReportsForTest,
} from './invalidStoredSettingsReport';

const base = {
  feature: 'system_protection',
  orgId: 'org-1',
  deviceId: 'device-1',
  featureLinkId: 'link-1',
  sourcePolicyId: 'policy-1',
  issues: ['beforeScripts: Invalid input'],
};

async function flush() {
  await new Promise((r) => setImmediate(r));
}

describe('reportInvalidStoredSettings (#8585)', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetInvalidStoredSettingsReportsForTest();
    audit.mockClear();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => { warn.mockRestore(); });

  it('warns and journals once per (org, feature, link) however many devices resolve it', async () => {
    reportInvalidStoredSettings(base);
    reportInvalidStoredSettings({ ...base, deviceId: 'device-2' });
    reportInvalidStoredSettings(base);
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(audit).toHaveBeenCalledTimes(1));
    await flush();
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1',
      actorType: 'system',
      actorId: '00000000-0000-0000-0000-000000000000',
      action: 'config_policy.invalid_stored_settings',
      resourceType: 'config_policy_feature_link',
      resourceId: 'link-1',
      result: 'failure',
      details: expect.objectContaining({ feature: 'system_protection', sourcePolicyId: 'policy-1' }),
    }));
  });

  it('reports again for a different feature or org', async () => {
    reportInvalidStoredSettings(base);
    reportInvalidStoredSettings({ ...base, feature: 'containment', featureLinkId: 'link-2' });
    reportInvalidStoredSettings({ ...base, orgId: 'org-2' });
    await flush();
    expect(warn).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(audit).toHaveBeenCalledTimes(3));
  });

  it('reports again after the dedupe window elapses', async () => {
    vi.useFakeTimers();
    try {
      reportInvalidStoredSettings(base);
      vi.advanceTimersByTime(61 * 60 * 1000);
      reportInvalidStoredSettings(base);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never throws when the journal write rejects', async () => {
    audit.mockRejectedValueOnce(new Error('db down'));
    expect(() => reportInvalidStoredSettings(base)).not.toThrow();
    await flush();
  });

  it('does not mark the surrounding request as having written its audit row', async () => {
    audit.mockImplementationOnce(async () => { markRequestAuditWritten(); });
    let written = true;
    written = await runWithAuditRequestTracking(async () => {
      reportInvalidStoredSettings(base);
      await vi.waitFor(() => expect(audit).toHaveBeenCalledTimes(1));
    });
    expect(written).toBe(false);
  });
});
