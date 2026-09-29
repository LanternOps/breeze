import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useDefaultReportOwnerScope } from '../ReportOwnerScopeField';
import { isBusinessReportType } from '../businessReportAccess';
import { SeriesRecipientsSection } from './SeriesRecipientsSection';
import { SeriesTargetingFields } from './SeriesTargetingFields';
import { availableCoversModes, DEFAULT_RECIPIENT_RULE, isSeriesEligibleReportType } from './seriesConfig';
import type { CoversMode, CoversValue, SeriesCoversFields } from './types';

const DEFAULT_SERIES_FIELDS: SeriesCoversFields = {
  targetMode: 'all',
  orgIds: [],
  recipientRule: DEFAULT_RECIPIENT_RULE,
  internalCc: [],
};

function seriesFieldsOf(value: CoversValue): SeriesCoversFields | null {
  if (value.mode !== 'series') return null;
  return { targetMode: value.targetMode, orgIds: value.orgIds, recipientRule: value.recipientRule, internalCc: value.internalCc };
}

/**
 * "Covers" — the first field of every create surface (spec §3.7): one org, one
 * report per org (series), or all orgs combined (the partner-owned aggregate).
 * The series and combined choices appear only for users past the partner-wide
 * gate, and only for types that support them (`availableCoversModes`).
 * Controlled. Which org a single-org report targets stays with W01's
 * `useReportTargetOrg` in the host; its picker arrives through `orgField`.
 */
export function CoversControl({
  reportType,
  value,
  onChange,
  orgField,
  lockMode = false,
  withSeriesRecipients = false,
  seriesExtra,
}: {
  reportType: string | undefined;
  value: CoversValue;
  onChange: (next: CoversValue) => void;
  orgField?: ReactNode;
  lockMode?: boolean;
  withSeriesRecipients?: boolean;
  seriesExtra?: ReactNode;
}) {
  const { t } = useTranslation('reports');
  const { canChoose } = useDefaultReportOwnerScope();
  const modes: CoversMode[] = lockMode ? [value.mode] : availableCoversModes(reportType, canChoose);
  const lastSeries = useRef<SeriesCoversFields>(DEFAULT_SERIES_FIELDS);
  const modeAllowed = modes.includes(value.mode);

  // The type (or the gate) changed under a chosen mode: fall back to one org
  // rather than submit a mode the type can't use (Review Focus 3).
  useEffect(() => {
    if (!modeAllowed) onChange({ mode: 'org' });
  }, [modeAllowed, onChange]);

  const select = (mode: CoversMode) => {
    if (mode === value.mode) return;
    const current = seriesFieldsOf(value);
    if (current) lastSeries.current = current;
    if (mode === 'series') onChange({ mode: 'series', ...lastSeries.current });
    else if (mode === 'combined') onChange({ mode: 'combined' });
    else onChange({ mode: 'org' });
  };

  const seriesFields = value.mode === 'series' && (
    <div className="space-y-4">
      {seriesExtra && <div data-testid="covers-series-extra">{seriesExtra}</div>}
      <SeriesTargetingFields
        value={{ targetMode: value.targetMode, orgIds: value.orgIds }}
        onChange={(targets) => onChange({ ...value, ...targets })}
      />
      {withSeriesRecipients && (
        <SeriesRecipientsSection
          value={{ recipientRule: value.recipientRule, internalCc: value.internalCc }}
          onChange={(recipients) => onChange({ ...value, ...recipients })}
          targets={{ targetMode: value.targetMode, orgIds: value.orgIds }}
        />
      )}
    </div>
  );
  const orgSlot = value.mode === 'org' ? orgField : null;
  // Past the gate but this type can't fan out: say so instead of silently
  // offering one org only (business types show Combined instead).
  const seriesUnavailable =
    !lockMode && canChoose && !isBusinessReportType(reportType) && !isSeriesEligibleReportType(reportType);

  if (modes.length === 1) {
    return (
      <div data-testid="covers-control" data-mode={value.mode} className="space-y-3">
        {orgSlot}
        {seriesFields}
        {seriesUnavailable && (
          <p data-testid="covers-series-unavailable" className="text-xs text-muted-foreground">
            {t('reports.series.covers.seriesUnavailableType')}
          </p>
        )}
      </div>
    );
  }

  return (
    <fieldset data-testid="covers-control" data-mode={value.mode} className="space-y-3">
      <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">{t('reports.series.covers.legend')}</legend>
      {modes.map((mode) => (
        <label key={mode} className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="report-covers-mode"
            className="mt-1"
            data-testid={`covers-mode-${mode}`}
            checked={value.mode === mode}
            onChange={() => select(mode)}
          />
          <span>
            <span className="font-medium">{t(/* i18n-dynamic */ `reports.series.covers.${mode}`)}</span>
            <span className="block text-xs text-muted-foreground">{t(/* i18n-dynamic */ `reports.series.covers.${mode}Hint`)}</span>
          </span>
        </label>
      ))}
      <div className="pl-6">
        {orgSlot}
        {seriesFields}
      </div>
    </fieldset>
  );
}
