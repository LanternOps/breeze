import { Loader2 } from 'lucide-react';
import { sanitizeImageSrc } from '../../lib/safeImageSrc';
import { useLoginBrandingDraft, type LoginBrandingValue } from './partnerSettings/units/loginBrandingUnit';
import { Trans, useTranslation } from 'react-i18next';
import '@/lib/i18n';

// Fallback swatch when no accent has been set yet, so the color picker and the
// preview have something sensible to render. Not persisted unless the user saves.
const DEFAULT_ACCENT = '#2563eb';
const HEADLINE_MAX = 120;

const inputClass = 'h-10 w-full rounded-md border bg-background px-3 text-sm';

/**
 * Partner "Login Branding" settings card (#2183). Lets a partner admin brand
 * the technician login screen (logo, accent color, headline). The shared
 * /login page shows the branding automatically when the instance resolves to
 * exactly one partner (typical self-hosted setup); every partner also has its
 * own /login/<partner-slug> page that shows it on any deployment (#4017), and
 * this card displays that URL. The fields are a form card of the partner
 * settings page: the header Save sends them (full-replace PUT
 * /api/v1/partners/me/login-branding, see loginBrandingUnit.ts).
 */
export default function LoginBrandingCard({ partnerSlug }: { partnerSlug?: string } = {}) {
  const { t } = useTranslation('settings');
  // The draft lives in the page-scoped store (W2), so it survives a tab switch;
  // the header Save sends it through the loginBranding unit.
  const { slice, setDraft, retry } = useLoginBrandingDraft();
  const draft = slice.draft;
  const set = (patch: Partial<LoginBrandingValue>) => setDraft(prev => ({ ...prev, ...patch }));

  if (slice.status === 'error') {
    return (
      <section className="rounded-lg border bg-card p-6 shadow-xs" data-testid="login-branding-card">
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {t('loginBranding.loadFailed')}
          <button type="button" onClick={retry} className="underline">{t('common:actions.retry')}</button>
        </div>
      </section>
    );
  }

  if (!draft) {
    return (
      <section className="rounded-lg border bg-card p-6 shadow-xs" data-testid="login-branding-card">
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </section>
    );
  }

  const { logoUrl, accentColor, headline } = draft;
  const previewAccent = accentColor.trim() || DEFAULT_ACCENT;
  const previewLogo = sanitizeImageSrc(logoUrl.trim() || null);

  return (
    <section className="rounded-lg border bg-card p-6 shadow-xs" data-testid="login-branding-card">
      <p className="mb-6 max-w-prose text-sm text-muted-foreground">
        {t('loginBranding.description')}
      </p>

      {partnerSlug && (
        <div className="mb-6 space-y-2">
          <label htmlFor="login-branding-signin-url" className="text-sm font-medium">
            {t('loginBranding.signInPage')}
          </label>
          <input
            id="login-branding-signin-url"
            data-testid="login-branding-signin-url"
            type="text"
            readOnly
            value={`${window.location.origin}/login/${encodeURIComponent(partnerSlug)}`}
            onFocus={(e) => e.currentTarget.select()}
            className={`${inputClass} font-mono`}
          />
          <p className="text-xs text-muted-foreground">{t('loginBranding.signInPageHelp')}</p>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Fields */}
        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="login-branding-logo-url" className="text-sm font-medium">
              {t('loginBranding.logoUrl')}
            </label>
            <input
              id="login-branding-logo-url"
              data-testid="login-branding-logo-url"
              type="url"
              value={logoUrl}
              onChange={(e) => set({ logoUrl: e.target.value })}
              placeholder={t('loginBranding.logoPlaceholder')}
              className={inputClass}
            />
            <p className="text-xs text-muted-foreground">
              <Trans i18nKey="loginBranding.logoHelp" t={t} components={{ code: <code /> }} />
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="login-branding-accent-hex" className="text-sm font-medium">
              {t('loginBranding.accentColor')}
            </label>
            <div className="flex items-center gap-3">
              <input
                aria-label={t('loginBranding.colorPicker')}
                data-testid="login-branding-accent-color"
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(accentColor) ? accentColor : DEFAULT_ACCENT}
                onChange={(e) => set({ accentColor: e.target.value })}
                className="h-10 w-14 shrink-0 cursor-pointer rounded-md border bg-background"
              />
              <input
                id="login-branding-accent-hex"
                data-testid="login-branding-accent-hex"
                type="text"
                value={accentColor}
                onChange={(e) => set({ accentColor: e.target.value })}
                placeholder="#2563eb"
                maxLength={7}
                className={inputClass}
              />
            </div>
            <p className="text-xs text-muted-foreground"><Trans i18nKey="loginBranding.colorHelp" t={t} components={{ code: <code /> }} /></p>
          </div>

          <div className="space-y-2">
            <label htmlFor="login-branding-headline" className="text-sm font-medium">
              {t('loginBranding.headline')}
            </label>
            <input
              id="login-branding-headline"
              data-testid="login-branding-headline"
              type="text"
              value={headline}
              onChange={(e) => set({ headline: e.target.value })}
              placeholder={t('loginBranding.headlinePlaceholder')}
              maxLength={HEADLINE_MAX}
              className={inputClass}
            />
            <p className="text-xs text-muted-foreground">
              {t('loginBranding.characterCount', { current: headline.length, max: HEADLINE_MAX })}
            </p>
          </div>
        </div>

        {/* Live preview */}
        <div className="space-y-2">
          <span className="text-sm font-medium">{t('loginBranding.preview')}</span>
          <div
            data-testid="login-branding-preview"
            data-preview
            className="flex min-h-40 flex-col items-center justify-center gap-4 rounded-lg border p-6 text-center"
            style={{ backgroundColor: previewAccent }}
          >
            {previewLogo && (
              <img
                src={previewLogo}
                alt={t('loginBranding.logoPreview')}
                className="max-h-16 max-w-[70%] object-contain"
              />
            )}
            <div className="rounded-md bg-white/90 px-4 py-3 shadow-sm">
              <p className="text-base font-semibold text-gray-900">
                {headline.trim() || t('loginBranding.previewHeadline')}
              </p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('loginBranding.previewDescription')}
          </p>
        </div>
      </div>

    </section>
  );
}
