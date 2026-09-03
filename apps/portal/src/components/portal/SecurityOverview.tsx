import type { SecurityOverviewDto } from '@breeze/shared';
import { Sparkline } from './Sparkline';
import { WeeklyBars } from './WeeklyBars';

export function SecurityOverview({ overview }: { overview: SecurityOverviewDto }) {
  if (overview.dataStatus === 'no_data') {
    return <p data-testid="portal-security-empty">No security observations are available yet.</p>;
  }

  return (
    <section data-testid="portal-security-overview">
      <h1>Security</h1>
      <Sparkline
        values={overview.scoreHistory.map((point) => point.score)}
        label="Security score history"
      />
      <p>{overview.score} · {overview.band}</p>
      <h2>{overview.threatEvents.label}</h2>
      <WeeklyBars
        label={overview.threatEvents.label}
        weeks={overview.threatEvents.weeks}
      />
      <div data-testid="portal-security-vulnerabilities">
        <h2>Open vulnerabilities</h2>
        <p>{overview.vulnerabilities.openBySeverity.critical} critical</p>
        <p>{overview.vulnerabilities.openBySeverity.high} high</p>
        <p>{overview.vulnerabilities.kevCount} KEV</p>
      </div>
    </section>
  );
}
