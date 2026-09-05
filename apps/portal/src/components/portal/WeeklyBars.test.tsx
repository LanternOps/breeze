// @vitest-environment jsdom
import type { ThreatWeekDto } from '@breeze/shared';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { WeeklyBars } from './WeeklyBars';

function week(patch: Partial<ThreatWeekDto> & { weekStart: string }): ThreatWeekDto {
  return {
    detected: 0,
    resolved: 0,
    detectedBySource: { native: 0, sentinelOne: 0, huntress: 0 },
    resolvedBySource: { native: 0, sentinelOne: 0, huntress: 0 },
    ...patch,
  };
}

it('renders detected and resolved bars as inline SVG', () => {
  render(
    <WeeklyBars
      label="Threats found and cleared"
      weeks={[
        week({ weekStart: '2026-08-24', detected: 3, resolved: 2 }),
        week({ weekStart: '2026-08-31', detected: 1, resolved: 1 }),
      ]}
    />,
  );
  expect(screen.getByTestId('portal-weekly-bars').tagName.toLowerCase()).toBe('svg');
  expect(screen.getAllByTestId('portal-weekly-detected')).toHaveLength(2);
  expect(screen.getAllByTestId('portal-weekly-resolved')).toHaveLength(2);
});

it('rules a quiet band instead of an empty chart when every week is zero', () => {
  render(
    <WeeklyBars
      label="Threats found and cleared"
      weeks={[
        week({ weekStart: '2026-08-24' }),
        week({ weekStart: '2026-08-31' }),
      ]}
    />,
  );

  expect(screen.queryByTestId('portal-weekly-bars')).toBeNull();
  const band = screen.getByTestId('portal-weekly-bars-empty');
  expect(band.className).toContain('border-y');
  expect(band.textContent).toBe('Nothing harmful found in the last 2 weeks.');
});

it('says there is no history at all when no week has been recorded', () => {
  render(<WeeklyBars label="Threats found and cleared" weeks={[]} />);

  expect(screen.getByTestId('portal-weekly-bars-empty').textContent).toBe(
    'No history yet.',
  );
});
