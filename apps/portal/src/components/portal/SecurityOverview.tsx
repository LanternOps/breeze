import type { SecurityOverviewDto } from '@breeze/shared';
import { formatDateTime } from '@/lib/utils';
import { Sparkline } from './Sparkline';
import { WeeklyBars } from './WeeklyBars';

export function SecurityOverview({
  overview,
  timezone,
}: {
  overview: SecurityOverviewDto;
  timezone?: string;
}) {
  if (overview.dataStatus === 'no_data') {
    return <p data-testid="portal-security-empty">No security observations are available yet.</p>;
  }

  return (
    <section data-testid="portal-security-overview">
      <h1>Security</h1>
      {overview.score != null ? (
        <>
          <Sparkline
            values={overview.scoreHistory.map((point) => point.score)}
            label="Security score history"
          />
          <p data-testid="portal-security-score">
            {overview.score} · {overview.band ?? 'Band not available'}
          </p>
        </>
      ) : (
        <p data-testid="portal-security-score-unavailable">
          No security score has been calculated for this organization yet.
        </p>
      )}
      <h2>{overview.threatEvents.label}</h2>
      <WeeklyBars
        label={overview.threatEvents.label}
        weeks={overview.threatEvents.weeks}
      />
      <div data-testid="portal-security-vulnerabilities">
        <h2>Open vulnerabilities</h2>
        <p>{overview.vulnerabilities.openBySeverity.critical} critical</p>
        <p>{overview.vulnerabilities.openBySeverity.high} high</p>
        <p data-testid="portal-security-vulnerabilities-medium">
          {overview.vulnerabilities.openBySeverity.medium} medium
        </p>
        <p data-testid="portal-security-vulnerabilities-low">
          {overview.vulnerabilities.openBySeverity.low} low
        </p>
        <p data-testid="portal-security-vulnerabilities-unknown">
          {overview.vulnerabilities.openBySeverity.unknown} unknown
        </p>
        <p>{overview.vulnerabilities.kevCount} KEV</p>
        {overview.vulnerabilities.lastDetectedAt && (
          <p data-testid="portal-security-vulnerabilities-last-detected">
            Last detected {formatDateTime(overview.vulnerabilities.lastDetectedAt, timezone)}
          </p>
        )}
      </div>
    </section>
  );
}
