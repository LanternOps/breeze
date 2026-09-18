import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Options for the Identity & Access Review report (#5784 W06). Four exports in
 * the same shape as `ThreatDetectionOptionsForm.tsx` and
 * `HardwareLifecycleOptionsForm.tsx`, so `ReportEditPage` and `ReportTemplates`
 * wire it identically.
 *
 * THERE IS NO SITE SELECTOR, and that is the point. Microsoft 365 identity data
 * has no site dimension, so a site picker would promise a filter the data cannot
 * deliver. The report is org-wide, and a site-restricted account is refused it
 * outright rather than shown a subset (OD-8 = A) — the org-wide note below says
 * so, because a technician who cannot run it deserves to know why before they
 * try.
 */
export type IdentityAccessOptions = {
  dormantDays: number;
  homeCountries: string[];
  adminDetail: boolean;
};

export const DEFAULT_IDENTITY_ACCESS_OPTIONS: IdentityAccessOptions = {
  dormantDays: 45,
  homeCountries: [],
  adminDetail: true,
};

const MIN_DORMANT_DAYS = 1;
const MAX_DORMANT_DAYS = 365;
const MAX_HOME_COUNTRIES = 50;
/** The server's own rule (`identityAccessConfigSchema`): ISO-3166 alpha-2. */
const COUNTRY_CODE = /^[A-Z]{2}$/;

/** Split a free-text field into normalised country codes, dropping anything the
 *  API would reject rather than sending it and 400-ing on save. */
export function parseHomeCountries(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(/[\s,]+/)) {
    const code = part.trim().toUpperCase();
    if (COUNTRY_CODE.test(code)) seen.add(code);
    if (seen.size >= MAX_HOME_COUNTRIES) break;
  }
  return [...seen];
}

/** Read the persisted config back into option state (edit page). Mirrors the
 *  server's `identityAccessConfigSchema` bounds, so a hand-edited or legacy
 *  config can never seed the input with a value the API would reject. */
export function identityAccessOptionsFromConfig(
  config: Record<string, unknown>,
): IdentityAccessOptions {
  const raw = config.dormantDays;
  const dormantDays = typeof raw === 'number' && Number.isFinite(raw)
    ? Math.min(MAX_DORMANT_DAYS, Math.max(MIN_DORMANT_DAYS, Math.round(raw)))
    : DEFAULT_IDENTITY_ACCESS_OPTIONS.dormantDays;
  const countries = Array.isArray(config.homeCountries)
    ? parseHomeCountries(config.homeCountries.filter((v) => typeof v === 'string').join(' '))
    : DEFAULT_IDENTITY_ACCESS_OPTIONS.homeCountries;
  return {
    dormantDays,
    homeCountries: countries,
    // "On unless explicitly false" — a legacy non-boolean value reads as on
    // rather than silently dropping the section a reader relies on.
    adminDetail: config.adminDetail !== false,
  };
}

type FieldProps = {
  value: IdentityAccessOptions;
  onChange: (value: IdentityAccessOptions) => void;
};

type Props = FieldProps & {
  busy?: boolean;
  submitLabel: string;
  onSubmit: () => void;
  onCancel: () => void;
};

/** The options on their own, for composing beside another form's controls. */
export function IdentityAccessOptionsFields({ value, onChange }: FieldProps) {
  const { t } = useTranslation('reports');
  // Draft text so both fields can be cleared or partially typed; only a valid
  // value reaches the parent (the edit page seeds `value` asynchronously).
  const [daysDraft, setDaysDraft] = useState(String(value.dormantDays));
  const [countriesDraft, setCountriesDraft] = useState(value.homeCountries.join(', '));

  useEffect(() => {
    setDaysDraft((current) => (
      Number.parseInt(current, 10) === value.dormantDays ? current : String(value.dormantDays)
    ));
  }, [value.dormantDays]);

  return (
    <div className="space-y-4">
      <p
        data-testid="identity-access-org-wide-note"
        className="rounded-md border border-dashed p-3 text-xs text-muted-foreground"
      >
        {t('reports.identityAccessOptions.orgWideNote')}
      </p>

      <label className="block rounded-md border p-4">
        <span className="block text-sm font-medium">{t('reports.identityAccessOptions.dormantDays')}</span>
        <input
          data-testid="identity-access-dormant-days"
          type="number"
          min={MIN_DORMANT_DAYS}
          max={MAX_DORMANT_DAYS}
          step={1}
          value={daysDraft}
          onChange={(event) => {
            setDaysDraft(event.target.value);
            const next = Number.parseInt(event.target.value, 10);
            if (Number.isFinite(next)) {
              onChange({
                ...value,
                dormantDays: Math.min(MAX_DORMANT_DAYS, Math.max(MIN_DORMANT_DAYS, next)),
              });
            }
          }}
          onBlur={() => setDaysDraft(String(value.dormantDays))}
          className="mt-2 w-28 rounded-md border bg-background px-3 py-2 text-sm"
        />
        <span className="mt-1 block text-xs text-muted-foreground">
          {t('reports.identityAccessOptions.dormantDaysHelp')}
        </span>
      </label>

      <label className="block rounded-md border p-4">
        <span className="block text-sm font-medium">{t('reports.identityAccessOptions.homeCountries')}</span>
        <input
          data-testid="identity-access-home-countries"
          type="text"
          value={countriesDraft}
          onChange={(event) => {
            setCountriesDraft(event.target.value);
            onChange({ ...value, homeCountries: parseHomeCountries(event.target.value) });
          }}
          className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
          placeholder="US, CA"
        />
        <span className="mt-1 block text-xs text-muted-foreground">
          {t('reports.identityAccessOptions.homeCountriesHelp')}
        </span>
      </label>

      <label className="flex items-start gap-3 rounded-md border p-4">
        <input
          data-testid="identity-access-admin-detail"
          type="checkbox"
          checked={value.adminDetail}
          onChange={(event) => onChange({ ...value, adminDetail: event.target.checked })}
          className="mt-1 h-4 w-4"
        />
        <span>
          <span className="block text-sm font-medium">{t('reports.identityAccessOptions.adminDetail')}</span>
          <span className="block text-xs text-muted-foreground">{t('reports.identityAccessOptions.adminDetailHelp')}</span>
        </span>
      </label>

      <p className="text-xs text-muted-foreground">
        {t('reports.identityAccessOptions.coverageNote')}
      </p>
    </div>
  );
}

export function IdentityAccessOptionsForm({
  value,
  onChange,
  busy = false,
  submitLabel,
  onSubmit,
  onCancel,
}: Props) {
  const { t } = useTranslation('reports');

  return (
    <div className="space-y-5">
      <IdentityAccessOptionsFields value={value} onChange={onChange} />
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded-md border px-4 py-2 text-sm" onClick={onCancel}>
          {t('reports.identityAccessOptions.cancel')}
        </button>
        <button
          type="button"
          data-testid="identity-access-create-report"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          disabled={busy}
          onClick={onSubmit}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
