import { type ChangeEvent, useEffect, useState } from 'react';
import { Eye, Globe, Image, Palette, Save, Wand2, X } from 'lucide-react';

type BrandingData = {
  logoUrl?: string;
  primaryColor?: string;
  secondaryColor?: string;
  theme?: 'light' | 'dark' | 'system';
  customCss?: string;
  portalSubdomain?: string;
};

type OrgBrandingEditorProps = {
  organizationName: string;
  branding?: BrandingData;
  onDirty?: () => void;
  onSave?: (data: BrandingData) => void;
};

const defaultBranding: BrandingData = {
  logoUrl: '',
  primaryColor: '#2563eb',
  secondaryColor: '#14b8a6',
  theme: 'system',
  customCss: '/* Add custom portal styling here */\n.portal-header {\n  letter-spacing: 0.04em;\n}',
  portalSubdomain: ''
};

const themeOptions = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' }
];

export default function OrgBrandingEditor({ organizationName, branding, onDirty, onSave }: OrgBrandingEditorProps) {
  const initialData = { ...defaultBranding, ...branding };
  const [logoPreview, setLogoPreview] = useState(initialData.logoUrl || '');
  const [logoName, setLogoName] = useState('');
  const [primaryColor, setPrimaryColor] = useState(initialData.primaryColor || '#2563eb');
  const [secondaryColor, setSecondaryColor] = useState(initialData.secondaryColor || '#14b8a6');
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>(initialData.theme || 'system');
  const [customCss, setCustomCss] = useState(initialData.customCss || '');
  const [portalSubdomain, setPortalSubdomain] = useState(initialData.portalSubdomain || '');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);

  useEffect(() => {
    if (!logoPreview || !logoPreview.startsWith('blob:')) {
      return;
    }

    return () => {
      URL.revokeObjectURL(logoPreview);
    };
  }, [logoPreview]);

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

  const handleSave = () => {
    const data: BrandingData = {
      logoUrl: logoPreview,
      primaryColor,
      secondaryColor,
      theme,
      customCss,
      portalSubdomain
    };
    setStatusMessage('Branding settings saved.');
    onSave?.(data);
  };

  const previewUrl = `https://${portalSubdomain || 'your-org'}.breeze.app`;
  const isDarkTheme = theme === 'dark';
  const hasSafeLogoPreview =
    !!logoPreview &&
    (logoPreview.startsWith('blob:') ||
      logoPreview.startsWith('https://') ||
      logoPreview.startsWith('http://') ||
      (logoPreview.startsWith('/') && !logoPreview.startsWith('//') && !logoPreview.startsWith('/\\')));

  return (
    <section className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Branding</h2>
          <p className="text-sm text-muted-foreground">
            Customize the portal experience for {organizationName}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handlePreview}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition hover:bg-muted"
          >
            <Eye className="h-4 w-4" />
            Preview
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            <Save className="h-4 w-4" />
            Save branding
          </button>
        </div>
      </div>

      {statusMessage ? (
        <div className="rounded-md border bg-muted/50 px-4 py-2 text-sm text-muted-foreground">
          {statusMessage}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        <div className="space-y-6">
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Image className="h-4 w-4" />
              Logo
            </div>
            <div className="flex flex-wrap items-center gap-4 rounded-lg border bg-muted/40 p-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-full border bg-background text-xs text-muted-foreground">
                {hasSafeLogoPreview ? (
                  <img
                    src={logoPreview}
                    alt="Organization logo preview"
                    className="h-16 w-16 rounded-full object-cover"
                  />
                ) : (
                  organizationName.slice(0, 2).toUpperCase()
                )}
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium">Upload a new logo</p>
                <p className="text-xs text-muted-foreground">
                  SVG or PNG, recommended 512x512
                </p>
                {logoName ? (
                  <p className="text-xs text-muted-foreground">Selected: {logoName}</p>
                ) : null}
              </div>
              <label className="ml-auto inline-flex cursor-pointer items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm font-medium transition hover:bg-muted">
                <input type="file" accept="image/*" className="hidden" onChange={handleLogoChange} />
                Upload
              </label>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 rounded-lg border bg-muted/40 p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Palette className="h-4 w-4" />
                Primary color
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={primaryColor}
                  onChange={event => {
                    setPrimaryColor(event.target.value);
                    markDirty();
                  }}
                  className="h-10 w-12 cursor-pointer rounded-md border bg-background"
                />
                <input
                  type="text"
                  value={primaryColor}
                  onChange={event => {
                    setPrimaryColor(event.target.value);
                    markDirty();
                  }}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                />
              </div>
            </div>

            <div className="space-y-2 rounded-lg border bg-muted/40 p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Palette className="h-4 w-4" />
                Secondary color
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={secondaryColor}
                  onChange={event => {
                    setSecondaryColor(event.target.value);
                    markDirty();
                  }}
                  className="h-10 w-12 cursor-pointer rounded-md border bg-background"
                />
                <input
                  type="text"
                  value={secondaryColor}
                  onChange={event => {
                    setSecondaryColor(event.target.value);
                    markDirty();
                  }}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="space-y-2 rounded-lg border bg-muted/40 p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Wand2 className="h-4 w-4" />
              Theme
            </div>
            <select
              value={theme}
              onChange={event => {
                setTheme(event.target.value as 'light' | 'dark' | 'system');
                markDirty();
              }}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              {themeOptions.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              System respects user OS preference when available.
            </p>
          </div>

          <div className="space-y-2 rounded-lg border bg-muted/40 p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Globe className="h-4 w-4" />
              Portal subdomain
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
                .breeze.app
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Available preview URL: https://{portalSubdomain || 'your-org'}.breeze.app
            </p>
          </div>

          <div className="space-y-2 rounded-lg border bg-muted/40 p-4">
            <div className="text-sm font-medium">Custom CSS (advanced)</div>
            <textarea
              value={customCss}
              onChange={event => {
                setCustomCss(event.target.value);
                markDirty();
              }}
              rows={7}
              className="w-full rounded-md border bg-background px-3 py-2 text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Use custom styles to fine tune spacing, typography, or layout.
            </p>
          </div>
        </div>
      </div>

      {isPreviewOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-3xl overflow-hidden rounded-xl border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b px-6 py-4">
              <div>
                <h3 className="text-base font-semibold">Portal preview</h3>
                <p className="text-xs text-muted-foreground">Live draft based on current branding inputs</p>
              </div>
              <button
                type="button"
                onClick={() => setIsPreviewOpen(false)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border text-muted-foreground transition hover:text-foreground"
                aria-label="Close preview"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4 p-6">
              <div className="overflow-hidden rounded-lg border">
                <div
                  className="flex items-center justify-between px-5 py-4"
                  style={{ backgroundColor: primaryColor, color: '#ffffff' }}
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/20 text-xs font-semibold">
                      {hasSafeLogoPreview ? (
                        <img src={logoPreview} alt="Preview logo" className="h-9 w-9 rounded-full object-cover" />
                      ) : (
                        organizationName.slice(0, 2).toUpperCase()
                      )}
                    </div>
                    <div>
                      <p className="text-sm font-semibold">{organizationName} Portal</p>
                      <p className="text-xs opacity-90">{previewUrl}</p>
                    </div>
                  </div>
                  <span className="rounded-full bg-white/20 px-2 py-1 text-xs uppercase tracking-wide">{theme}</span>
                </div>

                <div className={isDarkTheme ? 'space-y-4 bg-slate-950 p-5 text-slate-100' : 'space-y-4 bg-white p-5 text-slate-900'}>
                  <h4 className="text-sm font-semibold">Welcome back</h4>
                  <p className={isDarkTheme ? 'text-sm text-slate-300' : 'text-sm text-slate-600'}>
                    This preview reflects your current portal branding draft, including colors and logo choices.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="rounded-md px-3 py-2 text-xs font-semibold text-white"
                      style={{ backgroundColor: secondaryColor }}
                    >
                      Open support ticket
                    </button>
                    <button
                      type="button"
                      className={isDarkTheme ? 'rounded-md border border-slate-700 px-3 py-2 text-xs' : 'rounded-md border px-3 py-2 text-xs'}
                    >
                      View device list
                    </button>
                  </div>
                </div>
              </div>

              <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                Preview URL: <span className="font-medium text-foreground">{previewUrl}</span>
              </div>

              <div className="rounded-md border bg-muted/30 p-3">
                <p className="text-xs font-medium">Custom CSS payload</p>
                <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground">{customCss || '/* No custom CSS */'}</pre>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
