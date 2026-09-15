/**
 * AI Scorecard W04 (#5761, refs #4182) — the MEASURED band of
 * `/ai-agents/impact`, beneath the estimate band and visually separated from it.
 *
 * ## The copy rules are load-bearing
 *
 * The band is worthless — worse than worthless — if the labelling is wrong:
 *
 * - It is **correlational**: AI-touched versus untouched work *of the same kind,
 *   in the same window*. Never a before/after comparison, never a causal claim.
 *   The standing caption names the selection bias out loud: the AI generally
 *   reaches the easier items first.
 * - Every cohort shows its `n` per arm. A cohort below the display gate is not
 *   rendered at all (the API already withholds it).
 * - The primary figure is "resolved within 24 h" / "first response within 4 h".
 *   Any p50/p90 shown is labelled as a right-censored refinement.
 * - Technician minutes are **recorded** minutes, never "time spent", and the
 *   logging-coverage percentage sits beside them.
 * - The word "saved" never appears in this band. That word belongs to the
 *   estimate band above, which is honest about being an estimate.
 *
 * A test in `ImpactMeasuredBand.test.tsx` asserts the rendered text never
 * contains "saved", does contain "correlational", and mentions "before/after"
 * exactly once — in the caption's disclaiming form and nowhere else.
 *
 * The component fetches its own data so a slow measured query never blocks the
 * estimate band.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { formatNumber, formatPercent } from '@/lib/i18n/format';
import { fetchWithAuth } from '../../stores/auth';
import type {
  AiAgentImpactMeasuredDto,
  MeasuredArm,
  MeasuredCohort,
  MeasuredOmissionReason,
  MeasuredSignal,
  MeasuredTechnicianMinutes,
} from '@breeze/shared';

export interface ImpactMeasuredBandProps {
  window: number;
}

const OMISSION_KEY: Record<MeasuredOmissionReason, string> = {
  insufficient_data: 'aiAgentsPage.impact.measured.omitted.insufficientData',
  insufficient_followup: 'aiAgentsPage.impact.measured.omitted.insufficientFollowup',
  insufficient_authority: 'aiAgentsPage.impact.measured.omitted.insufficientAuthority',
  site_restricted: 'aiAgentsPage.impact.measured.omitted.siteRestricted',
};

/** A cohort key can contain anything; keep it safe for a `data-testid`. */
function testIdFor(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unnamed';
}

/**
 * The right-censored p50/p90, as one refinement line -- or `null` when the DTO
 * gave neither (survival never reached that quantile). No extra n-gate is
 * applied here: `buildArm` (apps/api impactStatistics.ts) already withholds the
 * whole arm below `MEASURED_MIN_COHORT_N`, so any arm reaching this component
 * has already cleared that gate (#5879).
 */
function formatPercentiles(
  arm: MeasuredArm,
  t: (key: string) => string,
): string | null {
  const parts: string[] = [];
  if (arm.censoredP50Minutes !== null) {
    parts.push(t('aiAgentsPage.impact.measured.percentileP50').replace('{minutes}', formatNumber(arm.censoredP50Minutes)));
  }
  if (arm.censoredP90Minutes !== null) {
    parts.push(t('aiAgentsPage.impact.measured.percentileP90').replace('{minutes}', formatNumber(arm.censoredP90Minutes)));
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function ArmFigure({
  label,
  n,
  proportion,
  cohortSizeLabel,
  percentileText,
  armTestId,
}: {
  label: string;
  n: number;
  proportion: number;
  cohortSizeLabel: string;
  percentileText: string | null;
  /** Distinguishes the two arms' otherwise-identical `data-testid`s (one per cohort row). */
  armTestId: 'ai-touched' | 'untouched';
}) {
  return (
    <div className="flex-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{formatPercent(proportion)}</p>
      {percentileText !== null && (
        <p data-testid={`measured-percentiles-${armTestId}`} className="text-xs text-muted-foreground">
          {percentileText}
        </p>
      )}
      {/* The cohort size travels WITH the figure, never as a footnote: a
          proportion without its n invites a comparison the data cannot bear. */}
      <p className="text-xs text-muted-foreground">{cohortSizeLabel.replace('{n}', formatNumber(n))}</p>
    </div>
  );
}

function CohortRow({ cohort, t }: { cohort: MeasuredCohort; t: (key: string) => string }) {
  const cohortSizeLabel = t('aiAgentsPage.impact.measured.cohortSize');
  return (
    <div
      data-testid={`measured-cohort-${testIdFor(cohort.key)}`}
      className="flex flex-col gap-2 rounded-md border px-4 py-3 sm:flex-row sm:items-center"
    >
      <p className="flex-1 text-sm font-medium">{cohort.label}</p>
      <div className="flex flex-1 gap-4">
        <ArmFigure
          label={t('aiAgentsPage.impact.measured.armAiTouched')}
          n={cohort.aiTouched.n}
          proportion={cohort.aiTouched.proportionWithinHorizon}
          cohortSizeLabel={cohortSizeLabel}
          percentileText={formatPercentiles(cohort.aiTouched, t)}
          armTestId="ai-touched"
        />
        <ArmFigure
          label={t('aiAgentsPage.impact.measured.armUntouched')}
          n={cohort.untouched.n}
          proportion={cohort.untouched.proportionWithinHorizon}
          cohortSizeLabel={cohortSizeLabel}
          percentileText={formatPercentiles(cohort.untouched, t)}
          armTestId="untouched"
        />
      </div>
    </div>
  );
}

function SignalSection({
  testId,
  omittedTestId,
  heading,
  withinHorizonLabel,
  signal,
  t,
}: {
  testId: string;
  omittedTestId: string;
  heading: string;
  withinHorizonLabel: string;
  signal: MeasuredSignal;
  t: (key: string) => string;
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">{heading}</h3>
      {signal.omitted !== null ? (
        <p data-testid={omittedTestId} className="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground">
          {t(/* i18n-dynamic */ OMISSION_KEY[signal.omitted])}
        </p>
      ) : (
        <div data-testid={testId} className="space-y-2">
          <p className="text-xs text-muted-foreground">{withinHorizonLabel}</p>
          {signal.cohorts.map((cohort) => (
            <CohortRow key={cohort.key} cohort={cohort} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function TechnicianMinutesSection({
  technicianMinutes,
  t,
}: {
  technicianMinutes: MeasuredTechnicianMinutes;
  t: (key: string) => string;
}) {
  const heading = t('aiAgentsPage.impact.measured.technicianMinutes');

  if (technicianMinutes.omitted !== null) {
    return (
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">{heading}</h3>
        <p
          data-testid="measured-technician-minutes-omitted"
          className="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground"
        >
          {t(/* i18n-dynamic */ OMISSION_KEY[technicianMinutes.omitted])}
        </p>
      </div>
    );
  }

  const cohortSizeLabel = t('aiAgentsPage.impact.measured.cohortSize');
  return (
    <div className="space-y-2" data-testid="measured-technician-minutes">
      <h3 className="text-sm font-semibold">{heading}</h3>
      {/* Coverage is NOT a footnote. A median over 30 %-logged tickets is not a
          median of the labour, and the reader must be able to see that. */}
      <p data-testid="measured-logging-coverage" className="text-xs text-muted-foreground">
        {t('aiAgentsPage.impact.measured.loggingCoverage')
          .replace('{ai}', formatPercent(technicianMinutes.loggingCoverage.aiTouched))
          .replace('{untouched}', formatPercent(technicianMinutes.loggingCoverage.untouched))}
      </p>
      {technicianMinutes.cohorts.map((cohort) => (
        <div
          key={cohort.key}
          data-testid={`measured-minutes-cohort-${testIdFor(cohort.key)}`}
          className="flex flex-col gap-2 rounded-md border px-4 py-3 sm:flex-row sm:items-center"
        >
          <p className="flex-1 text-sm font-medium">{cohort.label}</p>
          <div className="flex flex-1 gap-4">
            {[
              { label: t('aiAgentsPage.impact.measured.armAiTouched'), armData: cohort.aiTouched },
              { label: t('aiAgentsPage.impact.measured.armUntouched'), armData: cohort.untouched },
            ].map(({ label, armData }) => (
              <div key={label} className="flex-1">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="text-lg font-semibold">
                  {armData.medianRecordedMinutes === null
                    ? '—'
                    : t('aiAgentsPage.impact.measured.recordedMinutesValue')
                        .replace('{minutes}', formatNumber(armData.medianRecordedMinutes))}
                </p>
                <p className="text-xs text-muted-foreground">
                  {cohortSizeLabel.replace('{n}', formatNumber(armData.n))}
                </p>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Whether ANY arm across either signal actually shows a censored percentile.
 * The note disclaims a number that must be on screen for the disclaimer to
 * mean anything (#5879) -- unconditionally showing it over a band with no
 * percentiles at all attaches a caveat to values the reader never sees.
 */
function hasAnyPercentile(dto: AiAgentImpactMeasuredDto): boolean {
  return [dto.alertResolution, dto.ticketFirstResponse].some((signal) =>
    signal.cohorts.some(
      (cohort) =>
        cohort.aiTouched.censoredP50Minutes !== null ||
        cohort.aiTouched.censoredP90Minutes !== null ||
        cohort.untouched.censoredP50Minutes !== null ||
        cohort.untouched.censoredP90Minutes !== null,
    ),
  );
}

export default function ImpactMeasuredBand({ window: windowDays }: ImpactMeasuredBandProps) {
  const { t } = useTranslation('settings');
  const [dto, setDto] = useState<AiAgentImpactMeasuredDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);

    void (async () => {
      try {
        const res = await fetchWithAuth(`/ai/agents/impact/measured?window=${windowDays}`);
        if (cancelled) return;
        if (!res.ok) {
          setFailed(true);
          return;
        }
        const body = (await res.json()) as { data: AiAgentImpactMeasuredDto };
        if (cancelled) return;
        setDto(body.data);
      } catch {
        // A read failure must be VISIBLE. Rendering nothing would be
        // indistinguishable from "there is nothing to measure", which is the
        // one thing this band must never imply by accident.
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [windowDays]);

  if (loading) {
    return (
      <p data-testid="measured-loading" className="text-sm text-muted-foreground">
        {t('aiAgentsPage.impact.measured.loading')}
      </p>
    );
  }

  if (failed || !dto) {
    return (
      <p data-testid="measured-error" className="text-sm text-destructive">
        {t('aiAgentsPage.impact.measured.error')}
      </p>
    );
  }

  return (
    <section data-testid="measured-band" className="space-y-4 border-t pt-6">
      <div>
        <h2 className="text-sm font-semibold">{t('aiAgentsPage.impact.measured.heading')}</h2>
        <p data-testid="measured-caption" className="mt-1 text-xs text-muted-foreground">
          {t('aiAgentsPage.impact.measured.caption')}
        </p>
      </div>

      <SignalSection
        testId="measured-alert-resolution"
        omittedTestId="measured-alert-omitted"
        heading={t('aiAgentsPage.impact.measured.alertResolution')}
        withinHorizonLabel={t('aiAgentsPage.impact.measured.withinHorizonAlerts')}
        signal={dto.alertResolution}
        t={t}
      />

      <SignalSection
        testId="measured-ticket-first-response"
        omittedTestId="measured-ticket-omitted"
        heading={t('aiAgentsPage.impact.measured.ticketFirstResponse')}
        withinHorizonLabel={t('aiAgentsPage.impact.measured.withinHorizonTickets')}
        signal={dto.ticketFirstResponse}
        t={t}
      />

      <TechnicianMinutesSection technicianMinutes={dto.technicianMinutes} t={t} />

      {hasAnyPercentile(dto) && (
        <p data-testid="measured-censored-note" className="text-xs text-muted-foreground">
          {t('aiAgentsPage.impact.measured.censoredNote')}
        </p>
      )}
    </section>
  );
}
