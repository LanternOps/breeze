import { describe, it, expect, afterEach } from 'vitest';
import {
  DEFAULT_REEVAL_HORIZON_MINUTES,
  resolveReevalHorizonMinutes,
} from './offlineDuration';

afterEach(() => {
  delete process.env.OFFLINE_DETECTOR_REEVAL_HORIZON_MINUTES;
});

describe('resolveReevalHorizonMinutes', () => {
  it('defaults to 24h (1440 min)', () => {
    expect(DEFAULT_REEVAL_HORIZON_MINUTES).toBe(1440);
    expect(resolveReevalHorizonMinutes()).toBe(1440);
  });

  it('honors the env override', () => {
    process.env.OFFLINE_DETECTOR_REEVAL_HORIZON_MINUTES = '10080';
    expect(resolveReevalHorizonMinutes()).toBe(10080);
  });

  it('clamps to at least 1', () => {
    process.env.OFFLINE_DETECTOR_REEVAL_HORIZON_MINUTES = '0';
    expect(resolveReevalHorizonMinutes()).toBe(1);
  });
});
