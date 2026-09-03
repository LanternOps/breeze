// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SecurityOverview } from './SecurityOverview';

it('labels threats honestly and displays severity and KEV totals', () => {
  render(<SecurityOverview overview={{
    asOf: '2026-09-02T12:00:00Z',
    dataStatus: 'ok',
    score: 82,
    band: 'strong',
    scoreHistory: [{ capturedAt: '2026-09-01', score: 82 }],
    threatEvents: {
      label: 'endpoint threat events',
      weeks: [{
        weekStart: '2026-08-31',
        detected: 3,
        resolved: 2,
        detectedBySource: { native: 1, sentinelOne: 1, huntress: 1 },
        resolvedBySource: { native: 1, sentinelOne: 1, huntress: 0 },
      }],
    },
    vulnerabilities: {
      openBySeverity: { critical: 1, high: 2, medium: 3, low: 4, unknown: 0 },
      kevCount: 1,
      lastDetectedAt: '2026-09-01T00:00:00Z',
    },
  }} />);

  expect(screen.getByTestId('portal-security-overview').textContent).toContain(
    'endpoint threat events',
  );
  expect(screen.getByTestId('portal-security-vulnerabilities').textContent).toContain(
    '1 KEV',
  );
});

it('explains when observations exist but no security score has been calculated', () => {
  render(<SecurityOverview overview={{
    asOf: '2026-09-02T12:00:00Z',
    dataStatus: 'ok',
    score: null,
    band: null,
    scoreHistory: [],
    threatEvents: {
      label: 'endpoint threat events',
      weeks: [],
    },
    vulnerabilities: {
      openBySeverity: { critical: 1, high: 0, medium: 0, low: 0, unknown: 0 },
      kevCount: 0,
      lastDetectedAt: '2026-09-01T00:00:00Z',
    },
  }} />);

  expect(screen.getByTestId('portal-security-score-unavailable').textContent).toBe(
    'No security score has been calculated for this organization yet.',
  );
  expect(screen.queryByTestId('portal-sparkline')).toBeNull();
  expect(screen.getByTestId('portal-security-overview').textContent).not.toContain('null');
});
