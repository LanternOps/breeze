// @vitest-environment jsdom
import type { SecurityOverviewDto } from '@breeze/shared';
import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { formatDateTime } from '@/lib/utils';
import { SecurityOverview } from './SecurityOverview';

function overviewFixture(patch: Partial<SecurityOverviewDto> = {}): SecurityOverviewDto {
  return {
    asOf: '2026-09-02T12:00:00Z',
    dataStatus: 'ok',
    score: 82,
    band: 'strong',
    scoreHistory: [{ capturedAt: '2026-09-01', score: 82 }],
    threatEvents: {
      label: 'Endpoint threat events',
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
    ...patch,
  };
}

it('opens with the serif page title in the ordinary state', () => {
  render(<SecurityOverview overview={overviewFixture()} />);

  const heading = screen.getByRole('heading', { level: 1 });
  expect(heading.textContent).toBe('Security');
  expect(heading.className).toContain('font-display');
});

it('keeps the page title and reassures when nothing has been scored yet', () => {
  render(<SecurityOverview overview={overviewFixture({ dataStatus: 'no_data' })} />);

  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Security');
  const empty = screen.getByTestId('portal-security-empty');
  expect(empty.textContent).toContain('Nothing to report yet');
  expect(empty.textContent).toContain('being watched');
  // A ruled band, not a bare paragraph.
  expect(empty.className).toContain('border-y');
});

it('speaks the reader language instead of technician vocabulary', () => {
  const text = render(<SecurityOverview overview={overviewFixture()} />).container.textContent ?? '';

  for (const jargon of [
    'KEV',
    'Endpoint threat events',
    'Definitions age',
    'Real-time protection',
    'Observed at',
  ]) {
    expect(text).not.toContain(jargon);
  }
  expect(text).toContain('actively exploited');
});

it('shows the score with its band as the single status mark', () => {
  render(<SecurityOverview overview={overviewFixture({ band: 'at_risk', score: 41 })} />);

  expect(screen.getByTestId('portal-security-score').textContent).toContain('41');
  expect(screen.getByTestId('portal-security-band').textContent).toContain('Needs attention');
});

it('explains when observations exist but no security score has been calculated', () => {
  render(<SecurityOverview overview={overviewFixture({ score: null, band: null, scoreHistory: [] })} />);

  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Security');
  expect(screen.getByTestId('portal-security-score-unavailable').textContent).toContain(
    "We haven't scored your machines yet",
  );
  expect(screen.queryByTestId('portal-sparkline')).toBeNull();
  expect(screen.getByTestId('portal-security-overview').textContent).not.toContain('null');
});

it('renders medium, low, and unknown vulnerability counts plus the last-detected timestamp', () => {
  render(<SecurityOverview
    timezone="America/Denver"
    overview={overviewFixture({
      vulnerabilities: {
        openBySeverity: { critical: 1, high: 2, medium: 3, low: 4, unknown: 5 },
        kevCount: 1,
        lastDetectedAt: '2026-09-01T14:30:00Z',
      },
    })}
  />);

  expect(screen.getByTestId('portal-security-vulnerabilities-medium').textContent).toContain('3');
  expect(screen.getByTestId('portal-security-vulnerabilities-low').textContent).toContain('4');
  expect(screen.getByTestId('portal-security-vulnerabilities-unknown').textContent).toContain('5');
  expect(screen.getByTestId('portal-security-vulnerabilities-last-detected').textContent).toContain(
    formatDateTime('2026-09-01T14:30:00Z', 'America/Denver'),
  );
});

it('omits the last-detected line when no vulnerability has ever been observed', () => {
  render(<SecurityOverview overview={overviewFixture({
    vulnerabilities: {
      openBySeverity: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
      kevCount: 0,
      lastDetectedAt: null,
    },
  })} />);

  expect(screen.queryByTestId('portal-security-vulnerabilities-last-detected')).toBeNull();
});

it('does not reserve the trend column when there is too little history to draw', () => {
  // One captured point draws no polyline: the reserved 16rem column used to
  // hold nothing but the caption — a gap mid-row on desktop, ~80px of dead
  // space above it on a phone.
  render(<SecurityOverview overview={overviewFixture({
    scoreHistory: [{ capturedAt: '2026-09-01', score: 82 }],
  })} />);

  expect(screen.queryByTestId('portal-sparkline')).toBeNull();

  const band = screen.getByTestId('portal-security-score').closest('div');
  expect(band).not.toBeNull();
  expect(band?.textContent).toContain('Last 30 days');
});

it('sets the trend against the right rule when there is history to draw', () => {
  render(<SecurityOverview overview={overviewFixture({
    scoreHistory: [
      { capturedAt: '2026-08-25', score: 74 },
      { capturedAt: '2026-09-01', score: 82 },
    ],
  })} />);

  const column = screen.getByTestId('portal-sparkline').parentElement;
  expect(column?.textContent).toContain('Last 30 days');
  // The figure stays on the left of the band, never inside the trend column.
  expect(column?.querySelector('[data-testid="portal-security-score"]')).toBeNull();
});

it('keeps the score figure on the documented type ramp, not an arbitrary size', () => {
  render(<SecurityOverview overview={overviewFixture()} />);

  const figure = screen.getByTestId('portal-security-score');
  expect(figure.className).toContain('text-3xl');
  expect(figure.className).not.toMatch(/text-\[/);
});

it('reserves amber for a state the customer can act on — Fair is not one', () => {
  render(<SecurityOverview overview={overviewFixture({ band: 'fair', score: 62 })} />);

  const band = screen.getByTestId('portal-security-band');
  expect(band.textContent).toContain('Fair');
  expect(band.className).not.toContain('warning');
  expect(band.className).toContain('text-muted-foreground');
});

it('offers the customer a next step beside the weaknesses, in the concierge voice', () => {
  render(<SecurityOverview overview={overviewFixture()} />);

  const step = screen.getByTestId('portal-security-vulnerabilities-next-step');
  expect(step.textContent).toContain('Your IT team works through these in order of urgency.');
  const ask = within(step).getByText('Ask about this');
  expect(ask.getAttribute('href')).toBe('/tickets/new');
  expect(ask.className).toContain('text-primary-on-tint');
  // Body text, not a label or a heading.
  expect(step.className).toContain('text-sm');
  // The section lede must not repeat the same sentence back at the reader.
  expect(
    screen.getByTestId('portal-security-vulnerabilities').querySelectorAll(
      '[data-testid="portal-security-vulnerabilities-next-step"]',
    ),
  ).toHaveLength(1);
  const lede = screen.getByText(/Known problems in the software on your machines/);
  expect(lede.textContent).not.toContain('order of urgency');
});

it.each(['fair', 'at_risk'] as const)('offers the same next step under a %s score band', (band) => {
  render(<SecurityOverview overview={overviewFixture({ band, score: 41 })} />);

  const step = screen.getByTestId('portal-security-score-next-step');
  expect(step.textContent).toContain('Your IT team is working to bring this score up.');
  expect(within(step).getByText('Ask about this').getAttribute('href')).toBe('/tickets/new');
});

it.each(['strong', 'good'] as const)('leaves a %s score band without a next step', (band) => {
  render(<SecurityOverview overview={overviewFixture({ band, score: 91 })} />);

  expect(screen.queryByTestId('portal-security-score-next-step')).toBeNull();
});
