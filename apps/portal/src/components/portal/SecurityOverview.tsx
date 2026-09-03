import type { ReactNode } from 'react';
import type { SecurityOverviewDto, SecurityScoreBand } from '@breeze/shared';
import { ShieldCheck } from 'lucide-react';
import { cn, formatDateTime } from '@/lib/utils';
import { PageHeader, StatusMark, EmptyState, type MarkTone } from './ui';
import { Sparkline } from './Sparkline';
import { WeeklyBars } from './WeeklyBars';

/**
 * The page a worried customer opens. It answers three questions in the
 * reader's own words — how are we doing, what did you find, what are you still
 * working on — and it keeps its title in every state, including the one where
 * we have nothing to show yet.
 */

const LEDE = "How well your machines are looked after, and what we're watching.";

const BAND: Record<SecurityScoreBand, { label: string; tone: MarkTone }> = {
  strong: { label: 'Strong', tone: 'success' },
  good: { label: 'Good', tone: 'success' },
  fair: { label: 'Fair', tone: 'warning' },
  at_risk: { label: 'Needs attention', tone: 'destructive' },
};

const SEVERITIES: { key: string; label: string; testId?: string }[] = [
  { key: 'critical', label: 'Critical' },
  { key: 'high', label: 'High' },
  { key: 'medium', label: 'Medium', testId: 'portal-security-vulnerabilities-medium' },
  { key: 'low', label: 'Low', testId: 'portal-security-vulnerabilities-low' },
  { key: 'unknown', label: 'Not yet rated', testId: 'portal-security-vulnerabilities-unknown' },
];

function LedgerLine({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5" data-testid={testId}>
      <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </dt>
      <dd className="text-figures text-sm font-semibold text-foreground">{children}</dd>
    </div>
  );
}

/** A bar-chart key, drawn as the bars are drawn — squares, not status dots. */
function ThreatKey() {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
      <li className="flex items-center gap-2">
        <span aria-hidden="true" className="h-2 w-2 rounded-[2px] bg-warning" />
        Found
      </li>
      <li className="flex items-center gap-2">
        <span aria-hidden="true" className="h-2 w-2 rounded-[2px] bg-success" />
        Cleared
      </li>
    </ul>
  );
}

export function SecurityOverview({
  overview,
  timezone,
}: {
  overview: SecurityOverviewDto;
  timezone?: string;
}) {
  if (overview.dataStatus === 'no_data') {
    return (
      <section>
        <PageHeader title="Security" lede={LEDE} />
        <EmptyState
          data-testid="portal-security-empty"
          icon={<ShieldCheck className="h-10 w-10" strokeWidth={1.5} />}
          title="Nothing to report yet"
        >
          <p className="mx-auto mt-1 max-w-[42ch] text-sm text-muted-foreground">
            We haven't scored your machines yet. A score appears after the first check runs,
            and your machines are being watched in the meantime.
          </p>
        </EmptyState>
      </section>
    );
  }

  const band = overview.band ? BAND[overview.band] : null;
  // A single captured point draws no line — `Sparkline` emits a one-vertex
  // polyline and nothing is visible — so reserving the trend column for it
  // left the caption stranded mid-row on desktop and under ~80px of dead
  // space on a phone. Below two points the band carries the caption itself.
  const trendDrawable = overview.score != null && overview.scoreHistory.length > 1;
  const trendNoted = overview.score != null && overview.scoreHistory.length > 0;
  const weeks = overview.threatEvents.weeks;
  const threatsCharted = weeks.some((week) => week.detected + week.resolved > 0);
  const openBySeverity = overview.vulnerabilities.openBySeverity;

  return (
    <section data-testid="portal-security-overview">
      <PageHeader title="Security" lede={LEDE} />

      <div
        className={cn(
          'border-y border-border/70 py-5',
          trendDrawable && 'sm:flex sm:items-end sm:justify-between sm:gap-10',
        )}
      >
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Security score
          </p>
          {overview.score != null ? (
            <p className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span
                className="font-display text-figures text-[2.5rem] font-semibold leading-none text-foreground"
                data-testid="portal-security-score"
              >
                {overview.score}
              </span>
              {band && (
                <StatusMark tone={band.tone} data-testid="portal-security-band">
                  {band.label}
                </StatusMark>
              )}
            </p>
          ) : (
            <p
              className="mt-2 max-w-[46ch] text-sm text-muted-foreground"
              data-testid="portal-security-score-unavailable"
            >
              We haven't scored your machines yet. A score appears after the first check runs.
            </p>
          )}
          {trendNoted && !trendDrawable && (
            <p className="mt-1.5 text-xs text-muted-foreground">Last 30 days</p>
          )}
        </div>
        {trendDrawable && (
          <div className="mt-5 w-full sm:mt-0 sm:max-w-[16rem]">
            <Sparkline
              values={overview.scoreHistory.map((point) => point.score)}
              label="Your security score over the last 30 days"
            />
            <p className="mt-1.5 text-xs text-muted-foreground">Last 30 days</p>
          </div>
        )}
      </div>

      <section className="mt-10">
        <h2 className="font-display text-lg font-semibold text-foreground">
          Threats we found and cleared
        </h2>
        <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
          Harmful software found on your machines week by week, and how much of it we cleared.
        </p>
        <div className="mt-4">
          <WeeklyBars label="Threats found and cleared, week by week" weeks={weeks} />
        </div>
        {threatsCharted && <ThreatKey />}
      </section>

      <section className="mt-10" data-testid="portal-security-vulnerabilities">
        <h2 className="font-display text-lg font-semibold text-foreground">
          Weaknesses we're tracking
        </h2>
        <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
          Known problems in the software on your machines. Your IT team works through these in
          order of urgency.
        </p>
        <dl className="mt-4 divide-y divide-border/70 border-y border-border/70">
          {SEVERITIES.map((severity) => (
            <LedgerLine key={severity.key} label={severity.label} testId={severity.testId}>
              {openBySeverity[severity.key] ?? 0}
            </LedgerLine>
          ))}
          <LedgerLine label="Known to be actively exploited">
            {overview.vulnerabilities.kevCount}
          </LedgerLine>
        </dl>
        <p className="mt-3 max-w-[62ch] text-xs text-muted-foreground">
          "Known to be actively exploited" means attackers are already using that weakness against
          other businesses, so those are fixed first.
        </p>
        {overview.vulnerabilities.lastDetectedAt && (
          <p
            className="mt-1 text-xs text-muted-foreground"
            data-testid="portal-security-vulnerabilities-last-detected"
          >
            Last found {formatDateTime(overview.vulnerabilities.lastDetectedAt, timezone)}
          </p>
        )}
      </section>

      <p
        className="mt-8 text-xs text-muted-foreground"
        data-testid="portal-security-overview-as-of"
      >
        As of {formatDateTime(overview.asOf, timezone)}
      </p>
    </section>
  );
}

export default SecurityOverview;
