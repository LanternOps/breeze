import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeMock: vi.fn(),
  appendUserRiskSignalEventMock: vi.fn(),
  resolveMlFeatureFlagForOrgMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    execute: mocks.executeMock,
  },
}));

vi.mock('./userRiskScoring', () => ({
  appendUserRiskSignalEvent: mocks.appendUserRiskSignalEventMock,
}));

vi.mock('./mlFeatureFlags', () => ({
  resolveMlFeatureFlagForOrg: mocks.resolveMlFeatureFlagForOrgMock,
}));

import { evaluateUserRiskSignalsForOrg } from './userRiskSignals';

const ORG_ID = '00000000-0000-4000-8000-000000000001';
const USER_ID = '00000000-0000-4000-8000-000000000010';

describe('userRiskSignals', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T12:00:00.000Z'));
    mocks.executeMock.mockReset();
    mocks.appendUserRiskSignalEventMock.mockReset();
    mocks.resolveMlFeatureFlagForOrgMock.mockReset();
    mocks.resolveMlFeatureFlagForOrgMock.mockResolvedValue({
      flag: 'ml.user_risk_v0.enabled',
      enabled: true,
      defaultEnabled: true,
      source: 'default',
    });
    mocks.appendUserRiskSignalEventMock.mockResolvedValue('event-1');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips scanning when user-risk v0 is disabled', async () => {
    mocks.resolveMlFeatureFlagForOrgMock.mockResolvedValue({
      flag: 'ml.user_risk_v0.enabled',
      enabled: false,
      defaultEnabled: true,
      source: 'org_settings',
    });

    const result = await evaluateUserRiskSignalsForOrg(ORG_ID);

    expect(result.skipped).toBe(true);
    expect(result.appended).toBe(0);
    expect(mocks.executeMock).not.toHaveBeenCalled();
    expect(mocks.appendUserRiskSignalEventMock).not.toHaveBeenCalled();
  });

  it('appends off-hours script, remote-session, and elevation burst signals', async () => {
    mocks.executeMock
      .mockResolvedValueOnce([
        {
          batch_id: '00000000-0000-4000-8000-000000000111',
          user_id: USER_ID,
          script_id: '00000000-0000-4000-8000-000000000222',
          devices_targeted: 14,
          created_at: new Date('2026-06-18T03:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([
        {
          user_id: USER_ID,
          session_count: 6,
          latest_at: new Date('2026-06-18T11:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([
        {
          user_id: USER_ID,
          request_count: 3,
          approved_count: 2,
          latest_at: new Date('2026-06-18T10:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await evaluateUserRiskSignalsForOrg(ORG_ID, { lookbackHours: 24 });

    expect(result).toMatchObject({
      orgId: ORG_ID,
      skipped: false,
      appended: 3,
      deduped: 0,
      candidates: {
        offHoursMassScripts: 1,
        remoteSessionBursts: 1,
        privilegeElevationBursts: 1,
      },
    });
    expect(mocks.appendUserRiskSignalEventMock).toHaveBeenCalledTimes(3);
    expect(mocks.appendUserRiskSignalEventMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'script.off_hours_mass_execution',
      severity: 'high',
      userId: USER_ID,
      details: expect.objectContaining({
        batchId: '00000000-0000-4000-8000-000000000111',
        devicesTargeted: 14,
      }),
    }));
    expect(mocks.appendUserRiskSignalEventMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'remote_session_burst',
      severity: 'medium',
      userId: USER_ID,
    }));
    expect(mocks.appendUserRiskSignalEventMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'privilege_elevation_burst',
      severity: 'medium',
      userId: USER_ID,
    }));
  });

  it('does not append an event when the same fingerprint already exists', async () => {
    mocks.executeMock
      .mockResolvedValueOnce([
        {
          batch_id: '00000000-0000-4000-8000-000000000111',
          user_id: USER_ID,
          script_id: '00000000-0000-4000-8000-000000000222',
          devices_targeted: 20,
          created_at: new Date('2026-06-18T02:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'existing-event' }]);

    const result = await evaluateUserRiskSignalsForOrg(ORG_ID);

    expect(result.appended).toBe(0);
    expect(result.deduped).toBe(1);
    expect(mocks.appendUserRiskSignalEventMock).not.toHaveBeenCalled();
  });
});
