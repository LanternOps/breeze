// Regional step of the first-run setup wizard (issue #3204).
//
// Before this step existed the wizard collected none of language, currency or
// time zone, so every fresh install landed on partner/site timezone 'UTC',
// currency 'USD' and English — and the settings that fix that are scattered
// across three different pages (Settings -> Partner -> Regional, Theming, and
// Billing settings), none of which a first-run user has any reason to visit.
//
// Everything here is UI plumbing over existing endpoints; there is no API or
// schema work. The four writes and why each one exists:
//   1. PATCH /orgs/partners/me  {settings:{timezone,language}} — partner default.
//      The route shallow-merges top-level settings keys and mirrors
//      `settings.timezone` into the first-class `partners.timezone` column
//      (see orgs.ts, issue #1318), so this single call covers both.
//   2. PATCH /orgs/sites/:id    {timezone} — the site created one step earlier
//      defaults to 'UTC' independently of the partner, so it needs its own write.
//   3. PATCH /users/me          {preferences:{locale}} — the per-user console
//      language. Server-side preferences are shallow-merged.
//   4. PATCH /partner/billing-settings — currency. `currencyCode`,
//      `invoiceNumberPrefix` and `invoiceTermsDays` are all REQUIRED by
//      `partnerBillingSettingsSchema`, so the two we are not changing are echoed
//      back from the load; every other field is omitted and left untouched.
//
// Failure handling is deliberately non-advancing: a write that fails names
// itself in an inline error and the user stays on the step. Advancing on a
// partial save would silently ship the exact defaults this step exists to
// replace. The Skip button is the escape hatch for a user whose role lacks
// `invoices:write` (call 4 is permission-gated) or who simply does not care.
import { useEffect, useState } from 'react';
import { Coins, Globe, Loader2, ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SupportedLocale } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { extractApiError } from '@/lib/apiError';
import { currencyLabel, currencyOptions } from '@/lib/currencies';
import { applyLocale, i18n } from '@/lib/i18n';
import { writeLocalePreference } from '@/lib/appearance';
import TimezoneSelect from '@/components/shared/TimezoneSelect';

interface RegionalSetupStepProps {
  /** Site created in the Organization step; null when it could not be resolved. */
  siteId: string | null;
  onNext: () => void;
  onBack?: () => void;
}

// Self-names, so the option for a language always reads in that language rather
// than in whatever the console currently renders. Mirrors PartnerRegionalTab.
const LANGUAGE_OPTIONS: { value: SupportedLocale; labelKey: string }[] = [
  { value: 'en', labelKey: 'settings:language.englishLabel' },
  { value: 'pt-BR', labelKey: 'settings:language.ptBRLabel' },
  { value: 'es-419', labelKey: 'settings:language.es419Label' },
  { value: 'fr-FR', labelKey: 'settings:language.frFRLabel' },
  { value: 'fr-CA', labelKey: 'settings:language.frCALabel' },
  { value: 'de-DE', labelKey: 'settings:language.deDELabel' },
  { value: 'it-IT', labelKey: 'settings:language.itITLabel' },
  { value: 'tr-TR', labelKey: 'settings:language.trTRLabel' },
];

const SUPPORTED_LOCALES = new Set<string>(LANGUAGE_OPTIONS.map((option) => option.value));

/** Browser zone, used only when the partner is still on the 'UTC' default. */
function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Nearest supported console locale for the browser language, else English. */
function detectLanguage(): SupportedLocale {
  if (typeof navigator === 'undefined') return 'en';
  for (const candidate of navigator.languages ?? [navigator.language]) {
    if (!candidate) continue;
    if (SUPPORTED_LOCALES.has(candidate)) return candidate as SupportedLocale;
    // 'fr' / 'fr-BE' -> the first supported catalog for that base language.
    const base = candidate.split('-')[0];
    const match = LANGUAGE_OPTIONS.find((option) => option.value.split('-')[0] === base);
    if (match) return match.value;
  }
  return 'en';
}

interface PartnerRegional {
  settings?: { timezone?: string; language?: SupportedLocale } | null;
  currencyCode?: string | null;
  invoiceNumberPrefix?: string | null;
  invoiceTermsDays?: number | null;
}

export default function RegionalSetupStep({ siteId, onNext, onBack }: RegionalSetupStepProps) {
  const { t } = useTranslation(['auth', 'settings']);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();

  const [timezone, setTimezone] = useState('UTC');
  const [language, setLanguage] = useState<SupportedLocale>('en');
  const [currency, setCurrency] = useState('USD');
  // Echoed back on the billing PATCH because the schema requires them; not edited here.
  const [invoicePrefix, setInvoicePrefix] = useState('INV');
  const [invoiceTermsDays, setInvoiceTermsDays] = useState(30);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      // Detected values are the starting point, so a load failure still leaves
      // the form on the user's real region rather than back on UTC/USD/English.
      const detectedTimezone = detectTimezone();
      const detectedLanguage = detectLanguage();
      let next = { timezone: detectedTimezone, language: detectedLanguage, currency: 'USD' };
      let loadFailed = false;

      try {
        const res = await fetchWithAuth('/orgs/partners/me');
        if (res.ok) {
          const partner = (await res.json()) as PartnerRegional;
          const storedTimezone = partner.settings?.timezone;
          const storedLanguage = partner.settings?.language;
          next = {
            // 'UTC' here is indistinguishable from "never configured" (it is the
            // column default), so prefer the detected zone over it. Any other
            // stored zone is a real choice and wins.
            timezone: storedTimezone && storedTimezone !== 'UTC' ? storedTimezone : detectedTimezone,
            language: storedLanguage && SUPPORTED_LOCALES.has(storedLanguage) ? storedLanguage : detectedLanguage,
            currency: partner.currencyCode?.trim().toUpperCase() || 'USD',
          };
          if (!cancelled) {
            setInvoicePrefix(partner.invoiceNumberPrefix?.trim() || 'INV');
            setInvoiceTermsDays(
              typeof partner.invoiceTermsDays === 'number' ? partner.invoiceTermsDays : 30,
            );
          }
        } else {
          loadFailed = true;
        }
      } catch {
        loadFailed = true;
      }

      if (cancelled) return;
      setTimezone(next.timezone);
      setLanguage(next.language);
      setCurrency(next.currency);
      // Surfaced rather than swallowed: the form is usable, but the values shown
      // are guesses instead of what is actually stored, and the billing PATCH
      // will be echoing default prefix/terms it could not read.
      if (loadFailed) setError(t('auth:setup.regional.errors.loadFailed'));
      setLoading(false);
    };

    void load();
    return () => { cancelled = true; };
  }, [t]);

  // Switch the console immediately so the rest of the wizard renders in the
  // language just chosen. Persisting the choice happens on submit; this is the
  // local preview, and a chunk-load failure falls back to English inside
  // applyLocale rather than breaking the step.
  const handleLanguageChange = (value: SupportedLocale) => {
    setLanguage(value);
    writeLocalePreference(value);
    void applyLocale(value);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setSuccess(undefined);
    setSaving(true);

    // Each entry is (request, failure message). Run in order and stop at the
    // first failure so the message names the write that actually broke.
    const writes: { run: () => Promise<Response>; errorKey: string }[] = [
      {
        run: () => fetchWithAuth('/orgs/partners/me', {
          method: 'PATCH',
          body: JSON.stringify({ settings: { timezone, language } }),
        }),
        errorKey: 'auth:setup.regional.errors.savePartnerFailed',
      },
      {
        run: () => fetchWithAuth('/users/me', {
          method: 'PATCH',
          body: JSON.stringify({ preferences: { locale: language } }),
        }),
        errorKey: 'auth:setup.regional.errors.saveLanguageFailed',
      },
      {
        run: () => fetchWithAuth('/partner/billing-settings', {
          method: 'PATCH',
          body: JSON.stringify({
            currencyCode: currency,
            invoiceNumberPrefix: invoicePrefix,
            invoiceTermsDays,
          }),
        }),
        errorKey: 'auth:setup.regional.errors.saveCurrencyFailed',
      },
    ];

    if (siteId) {
      writes.splice(1, 0, {
        run: () => fetchWithAuth(`/orgs/sites/${siteId}`, {
          method: 'PATCH',
          body: JSON.stringify({ timezone }),
        }),
        errorKey: 'auth:setup.regional.errors.saveSiteFailed',
      });
    }

    try {
      for (const write of writes) {
        const res = await write.run();
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          setError(extractApiError(data, t(/* i18n-dynamic */ write.errorKey)));
          setSaving(false);
          return;
        }
      }
      setSuccess(t('auth:setup.regional.success'));
      setTimeout(onNext, 600);
    } catch {
      setError(t('auth:setup.common.unexpectedError'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t('auth:setup.regional.loading')}</p>
      </div>
    );
  }

  const options = currencyOptions(currency);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">{t('auth:setup.regional.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('auth:setup.regional.description')}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="setup-language" className="flex items-center gap-2 text-sm font-medium">
            <Globe className="h-4 w-4 text-muted-foreground" />
            {t('auth:setup.regional.language')}
          </label>
          <select
            id="setup-language"
            value={language}
            onChange={(e) => handleLanguageChange(e.target.value as SupportedLocale)}
            data-testid="setup-language"
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-primary"
          >
            {LANGUAGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(/* i18n-dynamic */ option.labelKey)}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">{t('auth:setup.regional.languageHint')}</p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="setup-timezone" className="flex items-center gap-2 text-sm font-medium">
            {t('auth:setup.regional.timezone')}
          </label>
          <TimezoneSelect
            id="setup-timezone"
            label={t('auth:setup.regional.timezone')}
            value={timezone}
            onChange={setTimezone}
            testId="setup-timezone"
          />
          <p className="text-xs text-muted-foreground">{t('auth:setup.regional.timezoneHint')}</p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="setup-currency" className="flex items-center gap-2 text-sm font-medium">
            <Coins className="h-4 w-4 text-muted-foreground" />
            {t('auth:setup.regional.currency')}
          </label>
          <select
            id="setup-currency"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            data-testid="setup-currency"
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-primary"
          >
            {options.map((code) => (
              <option key={code} value={code}>{currencyLabel(code, i18n.language)}</option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">{t('auth:setup.regional.currencyHint')}</p>
        </div>

        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {success && (
          <div className="rounded-md border border-emerald-500/50 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
            {success}
          </div>
        )}

        <div className="flex items-center justify-between pt-2">
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              <ArrowLeft className="h-4 w-4" />
              {t('auth:setup.common.back')}
            </button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onNext}
              disabled={saving}
              className="rounded-md px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {t('auth:setup.common.skip')}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90 disabled:opacity-50"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('auth:setup.common.saveAndContinue')}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
