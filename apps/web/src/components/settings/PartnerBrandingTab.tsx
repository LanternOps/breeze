import { useState } from 'react';
import type { InheritableBrandingSettings } from '@breeze/shared';
import { sanitizeImageSrc } from '../../lib/safeImageSrc';

type Props = {
  data: InheritableBrandingSettings;
  onChange: (data: InheritableBrandingSettings) => void;
};

const PLACEHOLDER = 'Not set — orgs configure individually';

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
  const set = (patch: Partial<InheritableBrandingSettings>) =>
    onChange({ ...data, ...patch });

  const [logoError, setLogoError] = useState<string | null>(null);

  const handleLogoFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setLogoError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await resizeToDataUrl(file);
      if (dataUrl.length > MAX_LOGO_BYTES) {
        setLogoError('Image too large after encoding (max 400 KB). Try a smaller or simpler image.');
        e.target.value = '';
        return;
      }
      set({ logoUrl: dataUrl });
    } catch {
      setLogoError('Could not read image. Please try a different file.');
      e.target.value = '';
    }
  };

  const safeLogo = sanitizeImageSrc(data.logoUrl);

  return (
    <div className="space-y-6">
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-2">
          <label className="text-sm font-medium">Primary Color</label>
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
              placeholder={PLACEHOLDER}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Secondary Color</label>
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
              placeholder={PLACEHOLDER}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Theme</label>
          <select
            value={data.theme ?? ''}
            onChange={e => set({ theme: (e.target.value || undefined) as InheritableBrandingSettings['theme'] })}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="">{PLACEHOLDER}</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="system">System</option>
          </select>
        </div>

        <div className="space-y-2 col-span-full">
          <label htmlFor="logo-file-input" className="text-sm font-medium">Logo</label>
          <div className="rounded-lg border bg-muted/40 p-4 space-y-3">
            <div className="flex items-center gap-4">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border bg-background overflow-hidden">
                {safeLogo ? (
                  <img
                    src={safeLogo}
                    alt="Logo preview"
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <span className="text-xs text-muted-foreground text-center px-1">No logo</span>
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
                  Upload image
                </label>
                {data.logoUrl && (
                  <button
                    type="button"
                    onClick={() => { set({ logoUrl: undefined }); setLogoError(null); }}
                    className="text-xs text-destructive hover:underline text-left"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              PNG, JPEG, or WebP · max 400 KB after encoding · resized to fit 256×256
            </p>
            {logoError && (
              <p className="text-xs text-destructive">{logoError}</p>
            )}
            {!data.logoUrl?.startsWith('data:') && (
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Or paste an image URL</label>
                <input
                  type="url"
                  value={data.logoUrl ?? ''}
                  onChange={e => {
                    const val = e.target.value;
                    if (!val) {
                      setLogoError(null);
                      set({ logoUrl: undefined });
                      return;
                    }
                    if (val.startsWith('blob:')) {
                      setLogoError('Blob URLs are temporary and cannot be saved. Upload the file instead.');
                      return;
                    }
                    if (!sanitizeImageSrc(val)) {
                      setLogoError('URL not supported. Use an https:// URL or upload a file.');
                      return;
                    }
                    setLogoError(null);
                    set({ logoUrl: val });
                  }}
                  placeholder={PLACEHOLDER}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                />
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">Custom CSS</label>
        <textarea
          value={data.customCss ?? ''}
          onChange={e => set({ customCss: e.target.value || undefined })}
          rows={5}
          className="w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
          placeholder="/* Custom CSS applied to all child organizations */"
        />
        <p className="text-xs text-muted-foreground">
          CSS overrides applied to the portal for all child organizations.
        </p>
      </div>
    </div>
  );
}
