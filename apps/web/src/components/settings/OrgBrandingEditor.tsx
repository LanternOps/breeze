import { type ChangeEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { Eye, Globe, Image, Palette, Save, Wand2, X } from 'lucide-react';
import { sanitizeImageSrc } from '../../lib/safeImageSrc';
import { resolveUiColorToken, sanitizeHexColor } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, ActionError } from '@/lib/runAction';
import { showToast } from '../shared/Toast';
import { useStableT } from '@/lib/i18n/useStableT';

// customCss is intentionally NOT part of BrandingData: as of #5952 it is
// persisted via portal_branding (orgPortalSettings.ts), not
// organizations.settings.branding — this component loads/saves it through a
// dedicated PATCH /orgs/organizations/:id/portal-settings call so the two
// writes (this section's other branding fields vs. customCss) stay decoupled.
type BrandingData = {
  logoUrl?: string;
  primaryColor?: string;
  secondaryColor?: string;
  theme?: 'light' | 'dark' | 'system';
  portalSubdomain?: string;
};

type OrgBrandingEditorProps = {
  organizationName: string;
  /** Required to load/save customCss via portal-settings. Absent only in
   *  isolated tests that don't exercise the customCss round-trip. */
  orgId?: string;
  branding?: BrandingData;
  onDirty?: () => void;
  onSave?: (data: BrandingData) => boolean | void | Promise<boolean | void>;
  locked?: string[];
};

const defaultBranding: BrandingData = {
  logoUrl: '',
  primaryColor: '#2563eb',
  secondaryColor: '#14b8a6',
  theme: 'system',
  portalSubdomain: ''
};

const DEFAULT_CUSTOM_CSS = '/* Add custom portal styling here */\n.portal-header {\n  letter-spacing: 0.04em;\n}';

const themeOptions = [
  { value: 'light', labelKey: 'orgBrandingEditor.theme.options.light' },
  { value: 'dark', labelKey: 'orgBrandingEditor.theme.options.dark' },
  { value: 'system', labelKey: 'orgBrandingEditor.theme.options.system' },
] as const;

const portalDomain = (() => {
  try {
    const url = import.meta.env.PUBLIC_API_URL || '';
    return new URL(url).hostname;
  } catch {
    return 'breezermm.com';
  }
})();

export default function OrgBrandingEditor({ organizationName, orgId, branding, onDirty, onSave, locked }: OrgBrandingEditorProps) {
  const { t } = useTranslation('settings');
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
  const isLocked = (field: string) => locked?.includes(`branding.${field}`) ?? false;
  const initialData = { ...defaultBranding, ...branding };
  const [logoPreview, setLogoPreview] = useState(initialData.logoUrl || '');
  const [logoName, setLogoName] = useState('');
  const [primaryColor, setPrimaryColor] = useState(initialData.primaryColor || defaultBranding.primaryColor || '#2563eb');
  const [secondaryColor, setSecondaryColor] = useState(initialData.secondaryColor || defaultBranding.secondaryColor || '#14b8a6');
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>(initialData.theme || 'system');
  const [customCss, setCustomCss] = useState(DEFAULT_CUSTOM_CSS);
  const [savingCustomCss, setSavingCustomCss] = useState(false);
  // Tracks whether the initial customCss GET failed (network error, non-2xx,
  // or an unparsable body) — reviewed data-loss risk: without this, a failed
  // load silently leaves `customCss` at the placeholder default, and Save
  // would then overwrite the admin's real saved CSS with that placeholder
  // text, with a success toast telling them it worked. When true, Save skips
  // the customCss PATCH entirely rather than write an unverified value.
  const [customCssLoadFailed, setCustomCssLoadFailed] = useState(false);
  const [portalSubdomain, setPortalSubdomain] = useState(initialData.portalSubdomain || '');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const resolvedPrimaryColor = sanitizeHexColor(primaryColor, defaultBranding.primaryColor || '#2563eb');
  const resolvedSecondaryColor = sanitizeHexColor(secondaryColor, defaultBranding.secondaryColor || '#14b8a6');
  const primaryToken = resolveUiColorToken(resolvedPrimaryColor, defaultBranding.primaryColor || '#2563eb');
  const secondaryToken = resolveUiColorToken(resolvedSecondaryColor, defaultBranding.secondaryColor || '#14b8a6');

  useEffect(() => {
    if (!logoPreview || !logoPreview.startsWith('blob:')) {
      return;
    }

    return () => {
      URL.revokeObjectURL(logoPreview);
    };
  }, [logoPreview]);

  // customCss lives in portal_branding (#5952), not organizations.settings —
  // load its current persisted value independently of the `branding` prop.
  // A missing/null value keeps the seeded placeholder rather than blanking
  // the textarea, matching the pre-#5952 first-run UX. Any failure to load
  // (network error, non-2xx, unparsable body) is treated the same way and
  // flips customCssLoadFailed so Save refuses to clobber real data with the
  // placeholder — see the state declaration above.
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth(`/orgs/organizations/${orgId}/portal-settings`);
        if (res.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        if (!res.ok) {
          throw new Error(`portal-settings load failed: ${res.status}`);
        }
        const body = await res.json().catch(() => {
          throw new Error('portal-settings response was not valid JSON');
        });
        const loaded = body?.data?.customCss;
        if (!cancelled && typeof loaded === 'string') {
          setCustomCss(loaded);
        }
      } catch (err) {
        console.warn('[OrgBrandingEditor] failed to load portal custom CSS', err);
        if (!cancelled) {
          setCustomCssLoadFailed(true);
          showToast({ message: stableT('orgBrandingEditor.customCss.loadError'), type: 'error' });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [orgId, stableT]);

  const markDirty = () => {
    onDirty?.();
  };

  const handleLogoChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setLogoPreview(URL.createObjectURL(file));
    setLogoName(file.name);
    markDirty();
  };

  const handlePreview = () => {
    setIsPreviewOpen(true);
  };

  const handleSave = async () => {
    const data: BrandingData = {
      logoUrl: logoPreview,
      primaryColor: resolvedPrimaryColor,
      secondaryColor: resolvedSecondaryColor,
      theme,
      portalSubdomain
    };
    setStatusMessage(null);

    if (customCssLoadFailed) {
      // The initial load never confirmed what's actually persisted, so
      // `customCss` may still be the seeded placeholder rather than the
      // admin's real saved value — writing it now would silently clobber
      // their real CSS. Refuse and tell them, instead of "succeeding".
      showToast({ message: t('orgBrandingEditor.customCss.saveBlockedByLoadError'), type: 'error' });
      return;
    }

    setSavingCustomCss(true);
    try {
      // Validate/save CSS first, then await the remaining branding settings.
      // Neither individual write should announce success for a partial save.
      if (orgId) {
        await runAction({
          request: () => fetchWithAuth(`/orgs/organizations/${orgId}/portal-settings`, {
            method: 'PATCH',
            body: JSON.stringify({ customCss: customCss.trim() ? customCss : null })
          }),
          errorFallback: t('orgBrandingEditor.customCss.saveError'),
          onUnauthorized: () => void navigateTo('/login', { replace: true })
        });
      }
      if (await onSave?.(data) === false) return;
      showToast({ message: t('orgBrandingEditor.saved'), type: 'success' });
      setStatusMessage(t('orgBrandingEditor.saved'));
    } catch (err) {
      if (!(err instanceof ActionError)) {
        showToast({ message: t('orgBrandingEditor.customCss.saveError'), type: 'error' });
      }
    } finally {
      setSavingCustomCss(false);
    }
  };

  const previewUrl = `https://${portalSubdomain || 'your-org'}.${portalDomain}`;
  const isDarkTheme = theme === 'dark';
  const safeLogoPreview = sanitizeImageSrc(logoPreview);

  return (
    <section className="space-y-6 rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{t('orgBrandingEditor.title')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('orgBrandingEditor.description', { organization: organizationName })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handlePreview}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition hover:bg-muted"
          >
            <Eye className="h-4 w-4" />
            {t('orgBrandingEditor.preview.action')}
          </button>
          <button
            type="button"
            data-testid="branding-save"
            onClick={() => void handleSave()}
            disabled={savingCustomCss}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {t('orgBrandingEditor.save')}
          </button>
        </div>
      </div>

      {statusMessage ? (
        <div data-testid="branding-save-status" className="rounded-md border bg-muted/50 px-4 py-2 text-sm text-muted-foreground">
          {statusMessage}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        <div className="space-y-6">
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Image className="h-4 w-4" />
              {t('orgBrandingEditor.logo.title')}
            </div>
            <div className="flex flex-wrap items-center gap-4 rounded-lg border bg-muted/40 p-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-full border bg-background text-xs text-muted-foreground">
                {safeLogoPreview ? (
                  <img
                    src={safeLogoPreview}
                    alt={t('orgBrandingEditor.logo.previewAlt')}
                    className="h-16 w-16 rounded-full object-cover"
                  />
                ) : (
                  organizationName.slice(0, 2).toUpperCase()
                )}
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium">{t('orgBrandingEditor.logo.uploadNew')}</p>
                <p className="text-xs text-muted-foreground">
                  {t('orgBrandingEditor.logo.recommendation')}
                </p>
                {logoName ? (
                  <p className="text-xs text-muted-foreground">{t('orgBrandingEditor.logo.selected', { name: logoName })}</p>
                ) : null}
              </div>
              <label className={`ml-auto inline-flex cursor-pointer items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm font-medium transition hover:bg-muted ${isLocked('logoUrl') ? 'opacity-60 pointer-events-none' : ''}`}>
                <input type="file" accept="image/*" className="hidden" disabled={isLocked('logoUrl')} onChange={handleLogoChange} />
                {t('common:actions.upload')}
              </label>
              {isLocked('logoUrl') && (
                <span className="text-xs text-amber-600 dark:text-amber-400 italic">{t('orgBrandingEditor.managedByPartner')}</span>
              )}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 rounded-lg border bg-muted/40 p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Palette className="h-4 w-4" />
                {t('orgBrandingEditor.colors.primary')}
              </div>
              <div className={`flex items-center gap-3 ${isLocked('primaryColor') ? 'opacity-60' : ''}`}>
                <input
                  type="color"
                  value={resolvedPrimaryColor}
                  disabled={isLocked('primaryColor')}
                  onChange={event => {
                    setPrimaryColor(event.target.value);
                    markDirty();
                  }}
                  className="h-10 w-12 cursor-pointer rounded-md border bg-background"
                />
                <input
                  type="text"
                  value={primaryColor}
                  disabled={isLocked('primaryColor')}
                  onChange={event => {
                    setPrimaryColor(event.target.value);
                    markDirty();
                  }}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                />
              </div>
              {isLocked('primaryColor') && (
                <span className="text-xs text-amber-600 dark:text-amber-400 italic">{t('orgBrandingEditor.managedByPartner')}</span>
              )}
            </div>

            <div className="space-y-2 rounded-lg border bg-muted/40 p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Palette className="h-4 w-4" />
                {t('orgBrandingEditor.colors.secondary')}
              </div>
              <div className={`flex items-center gap-3 ${isLocked('secondaryColor') ? 'opacity-60' : ''}`}>
                <input
                  type="color"
                  value={resolvedSecondaryColor}
                  disabled={isLocked('secondaryColor')}
                  onChange={event => {
                    setSecondaryColor(event.target.value);
                    markDirty();
                  }}
                  className="h-10 w-12 cursor-pointer rounded-md border bg-background"
                />
                <input
                  type="text"
                  value={secondaryColor}
                  disabled={isLocked('secondaryColor')}
                  onChange={event => {
                    setSecondaryColor(event.target.value);
                    markDirty();
                  }}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                />
              </div>
              {isLocked('secondaryColor') && (
                <span className="text-xs text-amber-600 dark:text-amber-400 italic">{t('orgBrandingEditor.managedByPartner')}</span>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="space-y-2 rounded-lg border bg-muted/40 p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Wand2 className="h-4 w-4" />
              {t('orgBrandingEditor.theme.title')}
            </div>
            <select
              value={theme}
              disabled={isLocked('theme')}
              onChange={event => {
                setTheme(event.target.value as 'light' | 'dark' | 'system');
                markDirty();
              }}
              className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${isLocked('theme') ? 'opacity-60' : ''}`}
            >
              {themeOptions.map(option => (
                <option key={option.value} value={option.value}>
                  {t(/* i18n-dynamic */ option.labelKey)}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {t('orgBrandingEditor.theme.description')}
            </p>
            {isLocked('theme') && (
              <span className="text-xs text-amber-600 dark:text-amber-400 italic">{t('orgBrandingEditor.managedByPartner')}</span>
            )}
          </div>

          <div className="space-y-2 rounded-lg border bg-muted/40 p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Globe className="h-4 w-4" />
              {t('orgBrandingEditor.subdomain.title')}
            </div>
            <div className="flex items-center">
              <input
                type="text"
                value={portalSubdomain}
                onChange={event => {
                  setPortalSubdomain(event.target.value);
                  markDirty();
                }}
                className="h-10 w-full rounded-l-md border border-r-0 bg-background px-3 text-sm"
              />
              <span className="flex h-10 items-center rounded-r-md border bg-muted px-3 text-xs text-muted-foreground">
                .{portalDomain}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('orgBrandingEditor.subdomain.previewUrl', {
                url: `https://${portalSubdomain || 'your-org'}.${portalDomain}`,
              })}
            </p>
          </div>

          <div className="space-y-2 rounded-lg border bg-muted/40 p-4">
            <div className="text-sm font-medium">{t('orgBrandingEditor.customCss.title')}</div>
            <textarea
              data-testid="branding-custom-css"
              value={customCss}
              disabled={isLocked('customCss') || customCssLoadFailed}
              onChange={event => {
                setCustomCss(event.target.value);
                markDirty();
              }}
              rows={7}
              className={`w-full rounded-md border bg-background px-3 py-2 text-xs ${isLocked('customCss') || customCssLoadFailed ? 'opacity-60' : ''}`}
            />
            <p className="text-xs text-muted-foreground">
              {t('orgBrandingEditor.customCss.description')}
            </p>
            {isLocked('customCss') && (
              <span className="text-xs text-amber-600 dark:text-amber-400 italic">{t('orgBrandingEditor.managedByPartner')}</span>
            )}
            {customCssLoadFailed && (
              <span className="text-xs text-destructive italic">{t('orgBrandingEditor.customCss.loadError')}</span>
            )}
          </div>
        </div>
      </div>

      {isPreviewOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-3xl overflow-hidden rounded-xl border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b px-6 py-4">
              <div>
                <h3 className="text-base font-semibold">{t('orgBrandingEditor.preview.title')}</h3>
                <p className="text-xs text-muted-foreground">{t('orgBrandingEditor.preview.description')}</p>
              </div>
              <button
                type="button"
                onClick={() => setIsPreviewOpen(false)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border text-muted-foreground transition hover:text-foreground"
                aria-label={t('orgBrandingEditor.preview.close')}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4 p-6">
              <div className="overflow-hidden rounded-lg border">
                <div
                  className={`flex items-center justify-between px-5 py-4 ${primaryToken.bgClass} ${primaryToken.textOnClass}`}
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/20 text-xs font-semibold">
                      {safeLogoPreview ? (
                        <img src={safeLogoPreview} alt={t('orgBrandingEditor.preview.logoAlt')} className="h-9 w-9 rounded-full object-cover" />
                      ) : (
                        organizationName.slice(0, 2).toUpperCase()
                      )}
                    </div>
                    <div>
                      <p className="text-sm font-semibold">{t('orgBrandingEditor.preview.portalName', { organization: organizationName })}</p>
                      <p className="text-xs opacity-90">{previewUrl}</p>
                    </div>
                  </div>
                  <span className="rounded-full bg-white/20 px-2 py-1 text-xs uppercase tracking-wide">
                    {t(/* i18n-dynamic */ themeOptions.find(option => option.value === theme)?.labelKey ?? 'orgBrandingEditor.theme.options.system')}
                  </span>
                </div>

                <div className={isDarkTheme ? 'space-y-4 bg-slate-950 p-5 text-slate-100' : 'space-y-4 bg-white p-5 text-slate-900'}>
                  <h4 className="text-sm font-semibold">{t('orgBrandingEditor.preview.welcome')}</h4>
                  <p className={isDarkTheme ? 'text-sm text-slate-300' : 'text-sm text-slate-600'}>
                    {t('orgBrandingEditor.preview.body')}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={`rounded-md px-3 py-2 text-xs font-semibold ${secondaryToken.bgClass} ${secondaryToken.textOnClass}`}
                    >
                      {t('orgBrandingEditor.preview.openTicket')}
                    </button>
                    <button
                      type="button"
                      className={isDarkTheme ? 'rounded-md border border-slate-700 px-3 py-2 text-xs' : 'rounded-md border px-3 py-2 text-xs'}
                    >
                      {t('orgBrandingEditor.preview.viewDevices')}
                    </button>
                  </div>
                </div>
              </div>

              <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                {t('orgBrandingEditor.preview.urlLabel')}: <span className="font-medium text-foreground">{previewUrl}</span>
              </div>

              <div className="rounded-md border bg-muted/30 p-3">
                <p className="text-xs font-medium">{t('orgBrandingEditor.preview.cssPayload')}</p>
                <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap chart-legend-xs text-muted-foreground">{customCss || t('orgBrandingEditor.preview.noCustomCss')}</pre>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
