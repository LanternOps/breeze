import { type ChangeEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { Image, Palette, Save } from 'lucide-react';
import { sanitizeImageSrc } from '../../lib/safeImageSrc';
import { MAX_LOGO_BYTES, LOGO_ACCEPT, resizeToDataUrl } from '@/lib/logoDataUrl';
import { sanitizeHexColor } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, ActionError } from '@/lib/runAction';
import { showToast } from '../shared/Toast';
import { useStableT } from '@/lib/i18n/useStableT';
import { PORTAL_PRIMARY_COLOR_PATTERN, isPortalLogoUrl } from '@breeze/shared';
import InheritedField from '../shared/InheritedField';

// Everything on this tab lives in portal_branding and is saved through
// PATCH /orgs/organizations/:id/portal-settings (orgPortalSettings.ts): customCss
// since #5952, primaryColor since #9962, the logo and secondaryColor since #9673.
// That row is what the portal and every customer document read
// (resolveDocumentBrand), with the partner's Branding as the fallback.
//
// organizations.settings.branding is retired: nothing reads it. The tab's theme
// and portal subdomain fields, which only ever saved there, are gone (custom
// domains are #3282).
type OrgBrandingEditorProps = {
  organizationName: string;
  /** Required to load/save through portal-settings. Absent only in isolated
   *  tests that don't exercise that round-trip. */
  orgId?: string;
  /** A logo in the retired organizations.settings.branding. Offered for the org
   *  to apply, because it is a real upload (the colours there are the editor's
   *  old hard-coded defaults, so they are not carried over). */
  legacyLogoUrl?: string;
  onDirty?: () => void;
  /** Called, with no data, after portal-settings saved. Return false if the
   *  page could not finish the save, so no success is reported. */
  onSave?: () => boolean | void | Promise<boolean | void>;
  locked?: string[];
  /** When set, Save is refused with this message before anything is written
   *  (an archived org). */
  saveBlockedMessage?: string;
};

// The accent quote/invoice renderers use when neither the org nor the partner
// has a colour (quotePdf/invoicePdf `hexToColor(..., '#2563eb')`).
const DEFAULT_PRIMARY_COLOR = '#2563eb';
// Only what a colour picker shows when neither level has a secondary colour: a
// picker cannot be empty. Nothing is saved unless the admin picks a value.
const DEFAULT_SECONDARY_COLOR = '#14b8a6';

const CUSTOM_CSS_PLACEHOLDER = '/* Add custom portal styling here */\n.portal-header {\n  letter-spacing: 0.04em;\n}';

export default function OrgBrandingEditor({ organizationName, orgId, legacyLogoUrl, onDirty, onSave, locked, saveBlockedMessage }: OrgBrandingEditorProps) {
  const { t } = useTranslation('settings');
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
  const isLocked = (field: string) => locked?.includes(`branding.${field}`) ?? false;
  const [customCss, setCustomCss] = useState('');
  const [savingCustomCss, setSavingCustomCss] = useState(false);
  // Tracks whether the initial portal-settings GET failed (network error,
  // non-2xx, or an unparsable body) — reviewed data-loss risk: without this, a
  // failed load silently leaves `customCss` at the placeholder default, and
  // Save would then overwrite the admin's real saved CSS with that placeholder
  // text, with a success toast telling them it worked. When true, Save skips
  // the portal-settings PATCH entirely rather than write an unverified value.
  const [customCssLoadFailed, setCustomCssLoadFailed] = useState(false);
  // #9962: the org's own document accent (portal_branding.primary_color);
  // '' = inherit the partner's Branding colour (partnerPrimaryColor).
  const [primaryColor, setPrimaryColor] = useState('');
  const [partnerPrimaryColor, setPartnerPrimaryColor] = useState<string | null>(null);
  // Only a colour the admin actually edited is written: an untouched stored
  // value is never re-sent, so a legacy value the strict schema would reject
  // cannot block an unrelated Save.
  const [primaryColorTouched, setPrimaryColorTouched] = useState(false);
  // #9673: the same chain for portal_branding.secondary_color.
  const [secondaryColor, setSecondaryColor] = useState('');
  const [partnerSecondaryColor, setPartnerSecondaryColor] = useState<string | null>(null);
  const [secondaryColorTouched, setSecondaryColorTouched] = useState(false);
  // #9673: portal_branding.logo_url as last loaded or saved. logoEdit is the
  // admin's unsaved change: null = untouched, '' = removed (inherit the partner).
  const [storedLogoUrl, setStoredLogoUrl] = useState('');
  const [partnerLogoUrl, setPartnerLogoUrl] = useState<string | null>(null);
  const [logoEdit, setLogoEdit] = useState<string | null>(null);
  const [logoName, setLogoName] = useState('');
  // These fields stay disabled until portal-settings has loaded, so a slow GET
  // can never overwrite what the admin has already typed. Without an orgId
  // (isolated tests) there is nothing to load.
  const [portalSettingsLoaded, setPortalSettingsLoaded] = useState(!orgId);
  const brandingFieldsDisabled = customCssLoadFailed || !portalSettingsLoaded;
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const trimmedPrimaryColor = primaryColor.trim();
  const primaryColorInvalid = trimmedPrimaryColor !== '' && !PORTAL_PRIMARY_COLOR_PATTERN.test(trimmedPrimaryColor);
  const trimmedSecondaryColor = secondaryColor.trim();
  const secondaryColorInvalid = trimmedSecondaryColor !== '' && !PORTAL_PRIMARY_COLOR_PATTERN.test(trimmedSecondaryColor);
  // What the org's documents print: its own colour, else the partner's, else
  // the app default the renderers fall back to.
  const resolvedPrimaryColor = sanitizeHexColor(
    trimmedPrimaryColor,
    sanitizeHexColor(partnerPrimaryColor ?? '', DEFAULT_PRIMARY_COLOR),
  );
  const resolvedSecondaryColor = sanitizeHexColor(
    trimmedSecondaryColor,
    sanitizeHexColor(partnerSecondaryColor ?? '', DEFAULT_SECONDARY_COLOR),
  );
  // Offered only once portal-settings has confirmed the org has no logo of its
  // own, and only if the write schema would accept it (old rows can hold a
  // session-local blob: URL, #8017). Save applies it, Remove discards it.
  const legacyLogoOffered = portalSettingsLoaded
    && !customCssLoadFailed
    && !storedLogoUrl
    && logoEdit === null
    && Boolean(legacyLogoUrl && isPortalLogoUrl(legacyLogoUrl));
  const orgLogoUrl = logoEdit ?? (legacyLogoOffered ? legacyLogoUrl! : storedLogoUrl);
  const safeLogoPreview = sanitizeImageSrc(orgLogoUrl || partnerLogoUrl);
  const logoInheritanceKey = orgLogoUrl
    ? 'common:inheritedField.overriding'
    : partnerLogoUrl
      ? 'common:inheritedField.inheritsFrom'
      : 'common:inheritedField.noneConfigured';

  // Load the portal_branding values this tab edits (see the note at the top).
  // A missing/null value leaves the textarea empty (the sample CSS is only a
  // placeholder, never a saved value). Any failure to load
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
        const asString = (value: unknown) => (typeof value === 'string' ? value : null);
        if (!cancelled) {
          setPrimaryColor(asString(body?.data?.primaryColor) ?? '');
          setPartnerPrimaryColor(asString(body?.data?.partnerPrimaryColor));
          setSecondaryColor(asString(body?.data?.secondaryColor) ?? '');
          setPartnerSecondaryColor(asString(body?.data?.partnerSecondaryColor));
          setStoredLogoUrl(asString(body?.data?.logoUrl) ?? '');
          setPartnerLogoUrl(asString(body?.data?.partnerLogoUrl));
          setPortalSettingsLoaded(true);
        }
      } catch (err) {
        console.warn('[OrgBrandingEditor] failed to load portal settings', err);
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

  // The logo is persisted inline (portal_branding.logo_url, 400 KB cap) — there
  // is no upload endpoint. Encode the file to a data URI; a blob: URL only
  // resolves in this tab and breaks on reload (#8017).
  const handleLogoChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) {
      return;
    }

    try {
      const dataUrl = await resizeToDataUrl(file);
      if (dataUrl.length > MAX_LOGO_BYTES) {
        showToast({ message: t('partnerBranding.imageTooLarge'), type: 'error' });
        input.value = '';
        return;
      }
      setLogoEdit(dataUrl);
      setLogoName(file.name);
      // Without this, picking the same file again after Remove fires no change.
      input.value = '';
      markDirty();
    } catch (err) {
      console.error('[OrgBrandingEditor] Logo file processing failed:', err);
      showToast({ message: t('partnerBranding.readError'), type: 'error' });
      input.value = '';
    }
  };

  const handleLogoRemove = () => {
    setLogoEdit('');
    setLogoName('');
    markDirty();
  };

  const handleSave = async () => {
    setStatusMessage(null);

    if (saveBlockedMessage) {
      showToast({ message: saveBlockedMessage, type: 'error' });
      return;
    }

    if (customCssLoadFailed) {
      // The initial load never confirmed what's actually persisted, so
      // `customCss` may still be the empty initial state rather than the
      // admin's real saved value — writing it now would silently clobber
      // their real CSS. Refuse and tell them, instead of "succeeding".
      showToast({ message: t('orgBrandingEditor.customCss.saveBlockedByLoadError'), type: 'error' });
      return;
    }

    // An untouched value is not sent (see primaryColorTouched), so only an
    // edited one can block the save.
    if (primaryColorTouched && primaryColorInvalid) {
      showToast({ message: t('orgBrandingEditor.colors.primaryInvalid'), type: 'error' });
      return;
    }

    if (secondaryColorTouched && secondaryColorInvalid) {
      showToast({ message: t('orgBrandingEditor.colors.primaryInvalid'), type: 'error' });
      return;
    }

    setSavingCustomCss(true);
    try {
      // portal-settings first, then the page's own step (onSave). Neither
      // should announce success for a partial save.
      if (orgId) {
        // An offered legacy logo counts as an edit: Save is what applies it.
        const logoToSend = logoEdit ?? (legacyLogoOffered ? legacyLogoUrl! : null);
        await runAction({
          request: () => fetchWithAuth(`/orgs/organizations/${orgId}/portal-settings`, {
            method: 'PATCH',
            body: JSON.stringify({
              customCss: customCss.trim() ? customCss : null,
              ...(primaryColorTouched ? { primaryColor: trimmedPrimaryColor || null } : {}),
              ...(secondaryColorTouched ? { secondaryColor: trimmedSecondaryColor || null } : {}),
              ...(logoToSend !== null ? { logoUrl: logoToSend || null } : {})
            })
          }),
          errorFallback: t('orgBrandingEditor.saveError'),
          onUnauthorized: () => void navigateTo('/login', { replace: true })
        });
        // Saved: the next Save must not re-send it, and an offered legacy logo
        // is now the org's own (or, if removed, must not be offered again).
        if (logoToSend !== null) {
          setStoredLogoUrl(logoToSend);
          setLogoEdit(logoToSend === '' ? '' : null);
        }
      }
      if (await onSave?.() === false) return;
      showToast({ message: t('orgBrandingEditor.saved'), type: 'success' });
      setStatusMessage(t('orgBrandingEditor.saved'));
    } catch (err) {
      if (!(err instanceof ActionError)) {
        showToast({ message: t('orgBrandingEditor.saveError'), type: 'error' });
      }
    } finally {
      setSavingCustomCss(false);
    }
  };

  return (
    <section className="space-y-6 rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{t('orgBrandingEditor.title')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('orgBrandingEditor.description', { organization: organizationName })}
          </p>
        </div>
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
            {/* #9673 (settings rules 3 + 4): the ORG level of the logo chain
                (resolveDocumentBrand). Shows the inherited partner logo and its
                source while the org has none. Not partner-locked: the `locked`
                list describes the retired organizations.settings.branding keys. */}
            <div className="space-y-3 rounded-lg border bg-muted/40 p-4">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex h-16 w-16 items-center justify-center rounded-full border bg-background text-xs text-muted-foreground">
                  {safeLogoPreview ? (
                    <img
                      data-testid="branding-logo-preview"
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
                    {t('partnerBranding.imageHelp')}
                  </p>
                  {logoName ? (
                    <p className="text-xs text-muted-foreground">{t('orgBrandingEditor.logo.selected', { name: logoName })}</p>
                  ) : null}
                  {portalSettingsLoaded ? (
                    <p className="text-xs text-muted-foreground">
                      {t(/* i18n-dynamic */ logoInheritanceKey, { source: t('orgBrandingEditor.logo.inheritedSource') })}
                    </p>
                  ) : null}
                </div>
                <div className="ml-auto flex items-center gap-2">
                  {orgLogoUrl ? (
                    <button
                      type="button"
                      data-testid="branding-logo-remove"
                      onClick={handleLogoRemove}
                      className="inline-flex items-center rounded-md border bg-background px-3 py-2 text-sm font-medium transition hover:bg-muted"
                    >
                      {t('orgBrandingEditor.logo.remove')}
                    </button>
                  ) : null}
                  <label className={`inline-flex cursor-pointer items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm font-medium transition hover:bg-muted ${brandingFieldsDisabled ? 'opacity-60 pointer-events-none' : ''}`}>
                    <input type="file" accept={LOGO_ACCEPT} className="hidden" disabled={brandingFieldsDisabled} onChange={handleLogoChange} />
                    {t('common:actions.upload')}
                  </label>
                </div>
              </div>
              {legacyLogoOffered && (
                <p data-testid="branding-logo-legacy-notice" className="text-xs text-amber-600 dark:text-amber-400">
                  {t('orgBrandingEditor.logo.legacyNotice')}
                </p>
              )}
              {customCssLoadFailed && (
                <p className="text-xs text-destructive italic">{t('orgBrandingEditor.logo.loadError')}</p>
              )}
              <p className="text-xs text-muted-foreground">{t('orgBrandingEditor.logo.help')}</p>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {/* #9962 (settings rules 3 + 4): the ORG level of the one document
                accent chain (resolveDocumentBrand) — it overrides the partner's
                Branding colour on this org's quotes and invoices, and while
                blank shows the inherited partner value and its source. Not
                partner-locked: the `locked` list describes the retired
                organizations.settings.branding.primaryColor key, which no
                document ever read. */}
            <div className="space-y-2 rounded-lg border bg-muted/40 p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Palette className="h-4 w-4" />
                {t('orgBrandingEditor.colors.primary')}
              </div>
              <div className="flex items-start gap-3">
                <input
                  type="color"
                  value={resolvedPrimaryColor}
                  disabled={brandingFieldsDisabled}
                  aria-label={t('orgBrandingEditor.colors.primary')}
                  data-testid="branding-primary-color-picker"
                  onChange={event => {
                    setPrimaryColor(event.target.value);
                    setPrimaryColorTouched(true);
                    markDirty();
                  }}
                  className="mt-1 h-10 w-12 shrink-0 cursor-pointer rounded-md border bg-background disabled:opacity-60"
                />
                <div className="min-w-0 flex-1">
                  <InheritedField
                    id="org-branding-primary-color"
                    label={t('orgBrandingEditor.colors.primary')}
                    hideLabel
                    value={primaryColor}
                    onChange={(value) => {
                      setPrimaryColor(value);
                      setPrimaryColorTouched(true);
                      markDirty();
                    }}
                    inheritedValue={partnerPrimaryColor}
                    inheritedSource={t('orgBrandingEditor.colors.primaryInheritedSource')}
                    disabled={brandingFieldsDisabled}
                    ariaInvalid={primaryColorInvalid}
                    ariaDescribedBy="org-branding-primary-color-help"
                    data-testid="branding-primary-color"
                  />
                </div>
              </div>
              {primaryColorInvalid && (
                <p className="text-xs text-destructive">{t('orgBrandingEditor.colors.primaryInvalid')}</p>
              )}
              {customCssLoadFailed && (
                <p className="text-xs text-destructive italic">{t('orgBrandingEditor.colors.primaryLoadError')}</p>
              )}
              <p id="org-branding-primary-color-help" className="text-xs text-muted-foreground">
                {t('orgBrandingEditor.colors.primaryHelp')}
              </p>
            </div>

            {/* #9673: the ORG level of the secondary colour, same rules as above. */}
            <div className="space-y-2 rounded-lg border bg-muted/40 p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Palette className="h-4 w-4" />
                {t('orgBrandingEditor.colors.secondary')}
              </div>
              <div className="flex items-start gap-3">
                <input
                  type="color"
                  value={resolvedSecondaryColor}
                  disabled={brandingFieldsDisabled}
                  aria-label={t('orgBrandingEditor.colors.secondary')}
                  data-testid="branding-secondary-color-picker"
                  onChange={event => {
                    setSecondaryColor(event.target.value);
                    setSecondaryColorTouched(true);
                    markDirty();
                  }}
                  className="mt-1 h-10 w-12 shrink-0 cursor-pointer rounded-md border bg-background disabled:opacity-60"
                />
                <div className="min-w-0 flex-1">
                  <InheritedField
                    id="org-branding-secondary-color"
                    label={t('orgBrandingEditor.colors.secondary')}
                    hideLabel
                    value={secondaryColor}
                    onChange={(value) => {
                      setSecondaryColor(value);
                      setSecondaryColorTouched(true);
                      markDirty();
                    }}
                    inheritedValue={partnerSecondaryColor}
                    inheritedSource={t('orgBrandingEditor.colors.secondaryInheritedSource')}
                    disabled={brandingFieldsDisabled}
                    ariaInvalid={secondaryColorInvalid}
                    ariaDescribedBy="org-branding-secondary-color-help"
                    data-testid="branding-secondary-color"
                  />
                </div>
              </div>
              {secondaryColorInvalid && (
                <p className="text-xs text-destructive">{t('orgBrandingEditor.colors.primaryInvalid')}</p>
              )}
              {customCssLoadFailed && (
                <p className="text-xs text-destructive italic">{t('orgBrandingEditor.colors.secondaryLoadError')}</p>
              )}
              <p id="org-branding-secondary-color-help" className="text-xs text-muted-foreground">
                {t('orgBrandingEditor.colors.secondaryHelp')}
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="space-y-2 rounded-lg border bg-muted/40 p-4">
            <div className="text-sm font-medium">{t('orgBrandingEditor.customCss.title')}</div>
            <textarea
              data-testid="branding-custom-css"
              value={customCss}
              placeholder={CUSTOM_CSS_PLACEHOLDER}
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
    </section>
  );
}
