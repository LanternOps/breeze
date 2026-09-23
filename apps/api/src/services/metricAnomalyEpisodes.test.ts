import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeMock, captureExceptionMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  captureExceptionMock: vi.fn(),
}));

vi.mock('../db', () => ({ db: { execute: executeMock } }));
vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));

import {
  closeEpisodesForDisabledDetection,
  notifyEpisodesClosed,
  resolveMetricAnomalyEpisodes,
  setEpisodeCloseHandler,
  type EpisodeCloseResult,
} from './metricAnomalyEpisodes';

const ORG = '11111111-1111-1111-1111-111111111111';
const CLOSED: EpisodeCloseResult[] = [
  { episodeId: 'ep-1', deviceId: 'dev-1', linkedAlertId: 'alert-1', closeReason: 'cleared' },
];

describe('episode close handler (W01 hook, W02 wires alert resolve)', () => {
  beforeEach(() => {
    setEpisodeCloseHandler(null);
    captureExceptionMock.mockReset();
  });

  it('is a no-op by default', async () => {
    await expect(notifyEpisodesClosed(ORG, CLOSED)).resolves.toBeUndefined();
  });

  it('hands the closed episodes to the registered handler', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    setEpisodeCloseHandler(handler);
    await notifyEpisodesClosed(ORG, CLOSED);
    expect(handler).toHaveBeenCalledWith(ORG, CLOSED);
  });

  it('does not call the handler for an empty batch', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    setEpisodeCloseHandler(handler);
    await notifyEpisodesClosed(ORG, []);
    expect(handler).not.toHaveBeenCalled();
  });

  it('never lets a handler failure fail the detection job', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setEpisodeCloseHandler(vi.fn().mockRejectedValue(new Error('alert service down')));
    await expect(notifyEpisodesClosed(ORG, CLOSED)).resolves.toBeUndefined();
    expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(Error), undefined, expect.objectContaining({ org_id: ORG }));
  });

  it('restores the no-op when given null', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    setEpisodeCloseHandler(handler);
    setEpisodeCloseHandler(null);
    await notifyEpisodesClosed(ORG, CLOSED);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('resolveMetricAnomalyEpisodes (spec §7)', () => {
  beforeEach(() => {
    executeMock.mockReset();
  });

  it('maps closed rows, drops malformed ones, and binds the supplied now', async () => {
    executeMock.mockResolvedValue([
      { episodeId: 'ep-1', deviceId: 'dev-1', linkedAlertId: null, closeReason: 'cleared' },
      { episodeId: 'ep-2', deviceId: 'dev-2', linkedAlertId: 'alert-2', closeReason: 'expired_offline' },
      { episodeId: 'ep-3', deviceId: 'dev-3', linkedAlertId: null, closeReason: 'user' },
      { acquired: true },
    ]);

    const result = await resolveMetricAnomalyEpisodes(
      ORG,
      new Date('2026-09-22T11:50:00.000Z'), // detection range `to` (A4)
      new Date('2026-09-22T12:00:00.000Z'), // now (expiry)
    );

    expect(result).toEqual([
      { episodeId: 'ep-1', deviceId: 'dev-1', linkedAlertId: null, closeReason: 'cleared' },
      { episodeId: 'ep-2', deviceId: 'dev-2', linkedAlertId: 'alert-2', closeReason: 'expired_offline' },
    ]);
    const text = JSON.stringify(executeMock.mock.calls[0]);
    expect(text).toContain('2026-09-22T11:50:00.000Z'); // eligibility is bounded by the range end
    expect(text).toContain('2026-09-22T12:00:00.000Z'); // expiry stays now-relative
    expect(text).toContain("interval '5 minutes'");
    expect(text).toContain('expired_offline');
    expect(text).toContain('expired_no_data');
    expect(text).toContain("SET status = 'cleared'");
    expect(text).toContain("ma.status = 'open'"); // promoted members are never touched
    expect(text).toContain('mr.sample_count > 0');
  });
});

describe('closeEpisodesForDisabledDetection (A5)', () => {
  beforeEach(() => {
    executeMock.mockReset();
  });

  it('closes every open episode as detection_off without reading rollups', async () => {
    executeMock.mockResolvedValue([
      { episodeId: 'ep-1', deviceId: 'dev-1', linkedAlertId: 'alert-1', closeReason: 'detection_off' },
    ]);

    const result = await closeEpisodesForDisabledDetection(ORG, new Date('2026-09-22T12:00:00.000Z'));

    expect(result).toEqual([{ episodeId: 'ep-1', deviceId: 'dev-1', linkedAlertId: 'alert-1', closeReason: 'detection_off' }]);
    const text = JSON.stringify(executeMock.mock.calls[0]);
    expect(text).toContain("close_reason = 'detection_off'");
    expect(text).toContain("e.status = 'open'");
    expect(text).toContain("ma.status = 'open'");
    expect(text).not.toContain('metric_rollups');
  });
});
