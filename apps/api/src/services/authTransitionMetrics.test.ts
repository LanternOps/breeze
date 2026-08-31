import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  recordAuthTransitionLegacyIssuer,
  setAuthTransitionMetricsRecorder,
} from './authTransitionMetrics';

describe('auth transition rollout metrics', () => {
  afterEach(() => setAuthTransitionMetricsRecorder(null));

  it('records the exact legacy issuer and client class labels', () => {
    const legacyIssuer = vi.fn();
    setAuthTransitionMetricsRecorder({ legacyIssuer });

    recordAuthTransitionLegacyIssuer('recovery', 'native');

    expect(legacyIssuer).toHaveBeenCalledWith('recovery', 'native');
  });
});
