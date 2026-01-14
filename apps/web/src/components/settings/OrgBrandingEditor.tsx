import { type ChangeEvent, useEffect, useState } from 'react';
import { Eye, Image, Palette, Save, Wand2, Globe } from 'lucide-react';

type OrgBrandingEditorProps = {
  onDirty?: () => void;
  onSave?: () => void;
};

const mockBranding = {
  organizationName: 'Breeze Labs',
  logoUrl: '',
  primaryColor: '#2563eb',
  secondaryColor: '#14b8a6',
  theme: 'system' as const,
  customCss: '/* Add custom portal styling here */\n.portal-header {\n  letter-spacing: 0.04em;\n}',
  portalSubdomain: 'breeze'
};

const themeOptions = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' }
];

export default function OrgBrandingEditor({ onDirty, onSave }: OrgBrandingEditorProps) {
  const [logoPreview, setLogoPreview] = useState(mockBranding.logoUrl);
  const [logoName, setLogoName] = useState('');
  const [primaryColor, setPrimaryColor] = useState(mockBranding.primaryColor);
  const [secondaryColor, setSecondaryColor] = useState(mockBranding.secondaryColor);
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>(mockBranding.theme);
  const [customCss, setCustomCss] = useState(mockBranding.customCss);
  const [portalSubdomain, setPortalSubdomain] = useState(mockBranding.portalSubdomain);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

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
    setStatusMessage('Preview opened in a mock window.');
  };

  const handleSave = () => {
    setStatusMessage('Branding settings saved.');
    onSave?.();
  };

  return (
    <section className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Branding</h2>
          <p className="text-sm text-muted-foreground">
            Customize the portal experience for {mockBranding.organizationName}.
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
                {logoPreview ? (
                  <img
                    src={logoPreview}
                    alt="Organization logo preview"
                    className="h-16 w-16 rounded-full object-cover"
                  />
                ) : (
                  mockBranding.organizationName.slice(0, 2).toUpperCase()
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
    </section>
  );
}
