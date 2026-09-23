import { beforeEach, describe, expect, it, vi } from 'vitest';

const { withSystemDbAccessContextMock, setEpisodeCloseHandlerMock, captureExceptionMock, resolveAlertMock } = vi.hoisted(() => ({
  withSystemDbAccessContextMock: vi.fn(),
  setEpisodeCloseHandlerMock: vi.fn(),
  captureExceptionMock: vi.fn(),
  resolveAlertMock: vi.fn(),
}));

vi.mock('../db', () => ({ db: {}, withSystemDbAccessContext: withSystemDbAccessContextMock }));
vi.mock('./alertService', () => ({ resolveAlert: resolveAlertMock }));
vi.mock('./metricAnomalyEpisodes', () => ({ setEpisodeCloseHandler: setEpisodeCloseHandlerMock }));
vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));

import {
  AUTO_CLOSE_REASONS,
  autoResolveNoteFor,
  handleEpisodesClosed,
  registerEpisodeCloseAlertHandler,
} from './metricAnomalyEpisodeAlerts';

describe('metricAnomalyEpisodeAlerts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the exact spec §7 notes', () => {
    expect(autoResolveNoteFor('cleared')).toBe('Auto-resolved: anomaly episode cleared');
    expect(autoResolveNoteFor('expired_offline')).toBe('Auto-resolved: anomaly episode expired');
    expect(autoResolveNoteFor('expired_no_data')).toBe('Auto-resolved: anomaly episode expired');
  });

  it('never auto-resolves on a detection_off close (A5)', () => {
    expect(AUTO_CLOSE_REASONS).toEqual(['cleared', 'expired_offline', 'expired_no_data']);
    expect(AUTO_CLOSE_REASONS).not.toContain('detection_off');
  });

  it('registers handleEpisodesClosed as the W01 close hook', () => {
    registerEpisodeCloseAlertHandler();
    expect(setEpisodeCloseHandlerMock).toHaveBeenCalledWith(handleEpisodesClosed);
  });

  it('never throws out of the hook: logs and captures instead', async () => {
    withSystemDbAccessContextMock.mockRejectedValue(new Error('db down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(handleEpisodesClosed('org-1', [])).resolves.toBeUndefined();
    expect(captureExceptionMock).toHaveBeenCalledWith(expect.objectContaining({ message: 'db down' }));
    errorSpy.mockRestore();
  });
});
