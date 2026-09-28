import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateMock = vi.fn();

vi.mock('../db', () => ({
  db: {
    update: (...args: unknown[]) => updateMock(...(args as [])),
  },
  runOutsideDbContext: <T>(fn: () => T) => fn(),
  withSystemDbAccessContext: <T>(fn: () => T) => fn(),
}));

import {
  COMMAND_PROGRESS_STAGES,
  applyCommandProgress,
  commandProgressStagesBefore,
  isCommandProgressStage,
} from './commandProgress';

const COMMAND_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '33333333-3333-4333-8333-333333333333';

function riggedUpdate(rows: unknown[]) {
  const returningMock = vi.fn().mockResolvedValue(rows);
  const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
  const setMock = vi.fn().mockReturnValue({ where: whereMock });
  updateMock.mockReturnValue({ set: setMock });
  return { setMock, whereMock, returningMock };
}

describe('command progress stages', () => {
  it('orders download before install', () => {
    expect(COMMAND_PROGRESS_STAGES).toEqual(['downloading', 'installing']);
    expect(commandProgressStagesBefore('downloading')).toEqual([]);
    expect(commandProgressStagesBefore('installing')).toEqual(['downloading']);
  });

  it('recognises only known stages', () => {
    expect(isCommandProgressStage('installing')).toBe(true);
    expect(isCommandProgressStage('rebooting')).toBe(false);
    expect(isCommandProgressStage(undefined)).toBe(false);
  });
});

describe('applyCommandProgress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stamps the stage and time on a sent command owned by the device', async () => {
    const { setMock, whereMock } = riggedUpdate([{ id: COMMAND_ID }]);
    const now = new Date('2026-09-28T12:00:00Z');

    const result = await applyCommandProgress({
      deviceId: DEVICE_ID,
      commandId: COMMAND_ID,
      stage: 'downloading',
      now,
    });

    expect(result).toEqual({ applied: true });
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledWith({ progressStage: 'downloading', progressAt: now });
    expect(whereMock).toHaveBeenCalledTimes(1);
  });

  it('drops a non-uuid command id before touching the database', async () => {
    const result = await applyCommandProgress({
      deviceId: DEVICE_ID,
      commandId: 'sw-install-abc-def-0',
      stage: 'installing',
    });

    expect(result).toEqual({ applied: false, reason: 'invalid-command-id' });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('drops an unknown stage before touching the database', async () => {
    const result = await applyCommandProgress({
      deviceId: DEVICE_ID,
      commandId: COMMAND_ID,
      stage: 'rebooting',
    });

    expect(result).toEqual({ applied: false, reason: 'unknown-stage' });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('reports not-applicable when no sent row matched (terminal, other device, or a stage regression)', async () => {
    riggedUpdate([]);

    const result = await applyCommandProgress({
      deviceId: DEVICE_ID,
      commandId: COMMAND_ID,
      stage: 'downloading',
    });

    expect(result).toEqual({ applied: false, reason: 'not-applicable' });
  });
});
