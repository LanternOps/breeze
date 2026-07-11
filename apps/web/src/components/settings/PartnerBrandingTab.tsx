import { useState, useEffect } from 'react';
import type { InheritableBrandingSettings } from '@breeze/shared';
import { sanitizeImageSrc } from '../../lib/safeImageSrc';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

type Props = {
  data: InheritableBrandingSettings;
  onChange: (data: InheritableBrandingSettings) => void;
};

const MAX_LOGO_BYTES = 400_000;
const LOGO_ACCEPT = 'image/png,image/jpeg,image/webp';

function resizeToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const MAX = 256;
      let { width, height } = img;
      if (width > MAX || height > MAX) {
        const ratio = Math.min(MAX / width, MAX / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('Canvas unavailable')); return; }
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Invalid image file'));
    };
    img.src = objectUrl;
  });
}

export default function PartnerBrandingTab({ data, onChange }: Props) {
  const { t } = useTranslation('settings');
  const set = (patch: Partial<InheritableBrandingSettings>) =>
    onChange({ ...data, ...patch });

  const [logoError, setLogoError] = useState<string | null>(null);

  // Separate draft state for the URL input so users can type intermediate values without
  // each keystroke being rejected by sanitizeImageSrc (which rejects partial URLs like "htt").
  const [urlDraft, setUrlDraft] = useState<string>(() =>
    data.logoUrl?.startsWith('data:') ? '' : (data.logoUrl ?? '')
  );

  // When the logo is cleared externally (Remove button) or replaced by a file upload,
  // reset the URL draft so the input reflects the new state.
  useEffect(() => {
    if (!data.logoUrl || data.logoUrl.startsWith('data:')) {
      setUrlDraft('');
    }
  }, [data.logoUrl]);

  const handleLogoFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setLogoError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await resizeToDataUrl(file);
      if (dataUrl.length > MAX_LOGO_BYTES) {
        setLogoError(t('partnerBranding.imageTooLarge'));
        e.target.value = '';
        return;
      }
      set({ logoUrl: dataUrl });
    } catch (err) {
      console.error('[PartnerBrandingTab] Logo file processing failed:', err);
      setLogoError(t('partnerBranding.readError'));
      e.target.value = '';
    }
  };

  const handleUrlBlur = () => {
    const val = urlDraft.trim();
    if (!val) {
      setLogoError(null);
      set({ logoUrl: undefined });
      return;
    }
    if (val.startsWith('blob:')) {
      setLogoError(t('partnerBranding.blobError'));
      return;
    }
    if (!sanitizeImageSrc(val)) {
      setLogoError(t('partnerBranding.urlError'));
      return;
    }
    setLogoError(null);
    set({ logoUrl: val });
  };

  const safeLogo = sanitizeImageSrc(data.logoUrl);
  // A data URI was saved but fails sanitization (e.g., corrupted or truncated in DB).
  const hasInvalidDataUri = !!data.logoUrl?.startsWith('data:') && !safeLogo;
  // Show the URL fallback input when there's no uploaded data URI, or when the saved one is invalid.
  const showUrlField = !data.logoUrl?.startsWith('data:') || hasInvalidDataUri;

  return (
    <div className="space-y-6">
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-2">
          <label className="text-sm font-medium">{t('partnerBranding.primaryColor')}</label>
          <div className="flex gap-2">
            <input
              type="color"
              value={data.primaryColor || '#3b82f6'}
              onChange={e => set({ primaryColor: e.target.value })}
              className="h-10 w-12 cursor-pointer rounded-md border bg-background p-1"
            />
            <input
              type="text"
              value={data.primaryColor ?? ''}
              onChange={e => set({ primaryColor: e.target.value || undefined })}
              placeholder={t('partnerBranding.notSet')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">{t('partnerBranding.secondaryColor')}</label>
          <div className="flex gap-2">
            <input
              type="color"
              value={data.secondaryColor || '#64748b'}
              onChange={e => set({ secondaryColor: e.target.value })}
              className="h-10 w-12 cursor-pointer rounded-md border bg-background p-1"
            />
            <input
              type="text"
              value={data.secondaryColor ?? ''}
              onChange={e => set({ secondaryColor: e.target.value || undefined })}
              placeholder={t('partnerBranding.notSet')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">{t('partnerBranding.theme')}</label>
          <select
            value={data.theme ?? ''}
            onChange={e => set({ theme: (e.target.value || undefined) as InheritableBrandingSettings['theme'] })}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="">{t('partnerBranding.notSet')}</option>
            <option value="light">{t('partnerBranding.themes.light')}</option>
            <option value="dark">{t('partnerBranding.themes.dark')}</option>
            <option value="system">{t('partnerBranding.themes.system')}</option>
          </select>
        </div>

        <div className="space-y-2 col-span-full">
          <label htmlFor="logo-file-input" className="text-sm font-medium">{t('partnerBranding.logo')}</label>
          <div className="rounded-lg border bg-muted/40 p-4 space-y-3">
            <div className="flex items-center gap-4">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border bg-background overflow-hidden">
                {safeLogo ? (
                  <img
                    src={safeLogo}
                    alt={t('partnerBranding.logoPreview')}
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <span className="text-xs text-muted-foreground text-center px-1">{t('partnerBranding.noLogo')}</span>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm font-medium transition hover:bg-muted">
                  <input
                    id="logo-file-input"
                    type="file"
                    accept={LOGO_ACCEPT}
                    className="hidden"
                    onChange={handleLogoFile}
                  />
                  {t('partnerBranding.uploadImage')}
                </label>
                {data.logoUrl && (
                  <button
                    type="button"
                    onClick={() => { set({ logoUrl: undefined }); setLogoError(null); }}
                    className="text-xs text-destructive hover:underline text-left"
                  >
                    {t('common:actions.remove')}
                  </button>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('partnerBranding.imageHelp')}
            </p>
            {hasInvalidDataUri && (
              <p className="text-xs text-destructive">{t('partnerBranding.invalidSavedLogo')}</p>
            )}
            {logoError && (
              <p className="text-xs text-destructive">{logoError}</p>
            )}
            {showUrlField && (
              <div className="space-y-1">
                <label htmlFor="logo-url-input" className="text-xs text-muted-foreground">{t('partnerBranding.pasteUrl')}</label>
                <input
                  id="logo-url-input"
                  type="url"
                  value={urlDraft}
                  onChange={e => { setUrlDraft(e.target.value); setLogoError(null); }}
                  onBlur={handleUrlBlur}
                  placeholder={t('partnerBranding.notSet')}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                />
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">{t('partnerBranding.customCss')}</label>
        <textarea
          value={data.customCss ?? ''}
          onChange={e => set({ customCss: e.target.value || undefined })}
          rows={5}
          className="w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
          placeholder={t('partnerBranding.customCssPlaceholder')}
        />
        <p className="text-xs text-muted-foreground">
          {t('partnerBranding.customCssHelp')}
        </p>
      </div>
    </div>
  );
}
