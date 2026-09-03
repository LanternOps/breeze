// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { WeeklyBars } from './WeeklyBars';

it('renders detected and resolved bars as inline SVG', () => {
  render(
    <WeeklyBars
      label="Endpoint threat events"
      weeks={[
        {
          weekStart: '2026-08-24', detected: 3, resolved: 2,
          detectedBySource: { native: 1, sentinelOne: 1, huntress: 1 },
          resolvedBySource: { native: 1, sentinelOne: 1, huntress: 0 },
        },
        {
          weekStart: '2026-08-31', detected: 1, resolved: 1,
          detectedBySource: { native: 1, sentinelOne: 0, huntress: 0 },
          resolvedBySource: { native: 1, sentinelOne: 0, huntress: 0 },
        },
      ]}
    />,
  );
  expect(screen.getByTestId('portal-weekly-bars').tagName.toLowerCase()).toBe('svg');
  expect(screen.getAllByTestId('portal-weekly-detected')).toHaveLength(2);
  expect(screen.getAllByTestId('portal-weekly-resolved')).toHaveLength(2);
});
