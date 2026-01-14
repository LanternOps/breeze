import { type ChangeEvent, type DragEvent, useEffect, useState } from 'react';
import { FileCode, Globe, Image, Mail, Palette, RefreshCcw, Save } from 'lucide-react';

type BrandingEditorProps = {
  onDirty?: () => void;
  onSave?: () => void;
};

type StatusMessage = {
  type: 'success' | 'error';
  message: string;
};

type UploadTarget = 'logoLight' | 'logoDark' | 'favicon';

type SavedBranding = {
  primaryColor: string;
  secondaryColor: string;
  customCss: string;
  logoLightUrl: string;
  logoDarkUrl: string;
  faviconUrl: string;
  logoLightName: string;
  logoDarkName: string;
  faviconName: string;
};

const mockBranding = {
  organizationName: 'Breeze Labs',
  portalName: 'Breeze Portal',
  portalUrl: 'portal.breeze.app',
  supportEmail: 'support@breeze.io',
  primaryColor: '#2563eb',
  secondaryColor: '#f97316',
  customCss:
    '/* Example: .portal-card { border-radius: 18px; } */\n.portal-header {\n  letter-spacing: 0.04em;\n}',
  logoLightUrl: '',
  logoDarkUrl: '',
  faviconUrl: ''
};

const getInitials = (value: string) =>
  value
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase() ?? '')
    .join('');

const isValidHex = (value: string) => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);

const normalizeHex = (value: string) => {
  if (!isValidHex(value)) {
    return null;
  }

  const hex = value.slice(1);
  if (hex.length === 3) {
    return `#${hex
      .split('')
      .map(char => char + char)
      .join('')}`;
  }

  return value;
};

const getContrastColor = (value: string, fallback: string) => {
  const normalized = normalizeHex(value);
  if (!normalized) {
    return fallback;
  }

  const hex = normalized.slice(1);
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;

  return luminance > 0.6 ? '#0f172a' : '#f8fafc';
};

type UploadDropzoneProps = {
  title: string;
  description: string;
  helper?: string;
  preview: string;
  fileName: string;
  placeholder: string;
  previewClassName?: string;
  previewSizeClassName?: string;
  accept?: string;
  onFileSelect: (file: File) => void;
};

function UploadDropzone({
  title,
  description,
  helper,
  preview,
  fileName,
  placeholder,
  previewClassName,
  previewSizeClassName = 'h-16 w-16',
  accept = 'image/*',
  onFileSelect
}: UploadDropzoneProps) {
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) {
      return;
    }
    onFileSelect(file);
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    onFileSelect(file);
    event.target.value = '';
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`rounded-lg border border-dashed p-4 transition ${
        isDragging ? 'border-primary bg-primary/5' : 'bg-muted/40'
      }`}
    >
      <div className="flex flex-wrap items-center gap-4">
        <div
          className={`flex items-center justify-center rounded-md border ${previewSizeClassName} ${previewClassName ?? 'bg-background'}`}
        >
          {preview ? (
            <img src={preview} alt={`${title} preview`} className="h-full w-full rounded-md object-contain" />
          ) : (
            <span className="text-xs font-medium text-muted-foreground">{placeholder}</span>
          )}
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
          {fileName ? <p className="text-xs text-muted-foreground">Selected: {fileName}</p> : null}
        </div>
        <label className="ml-auto inline-flex cursor-pointer items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm font-medium transition hover:bg-muted">
          <input type="file" accept={accept} className="hidden" onChange={handleChange} />
          Upload
        </label>
      </div>
      {helper ? <p className="mt-3 text-xs text-muted-foreground">{helper}</p> : null}
    </div>
  );
}

export default function BrandingEditor({ onDirty, onSave }: BrandingEditorProps) {
  const [logoLightPreview, setLogoLightPreview] = useState(mockBranding.logoLightUrl);
  const [logoDarkPreview, setLogoDarkPreview] = useState(mockBranding.logoDarkUrl);
  const [faviconPreview, setFaviconPreview] = useState(mockBranding.faviconUrl);
  const [logoLightName, setLogoLightName] = useState('');
  const [logoDarkName, setLogoDarkName] = useState('');
  const [faviconName, setFaviconName] = useState('');
  const [logoLightFile, setLogoLightFile] = useState<File | null>(null);
  const [logoDarkFile, setLogoDarkFile] = useState<File | null>(null);
  const [faviconFile, setFaviconFile] = useState<File | null>(null);
  const [primaryColor, setPrimaryColor] = useState(mockBranding.primaryColor);
  const [secondaryColor, setSecondaryColor] = useState(mockBranding.secondaryColor);
  const [customCss, setCustomCss] = useState(mockBranding.customCss);
  const [statusMessage, setStatusMessage] = useState<StatusMessage | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [savedBranding, setSavedBranding] = useState<SavedBranding>({
    primaryColor: mockBranding.primaryColor,
    secondaryColor: mockBranding.secondaryColor,
    customCss: mockBranding.customCss,
    logoLightUrl: mockBranding.logoLightUrl,
    logoDarkUrl: mockBranding.logoDarkUrl,
    faviconUrl: mockBranding.faviconUrl,
    logoLightName: '',
    logoDarkName: '',
    faviconName: ''
  });

  useEffect(() => {
    if (!logoLightPreview || !logoLightPreview.startsWith('blob:')) {
      return;
    }
    return () => URL.revokeObjectURL(logoLightPreview);
  }, [logoLightPreview]);

  useEffect(() => {
    if (!logoDarkPreview || !logoDarkPreview.startsWith('blob:')) {
      return;
    }
    return () => URL.revokeObjectURL(logoDarkPreview);
  }, [logoDarkPreview]);

  useEffect(() => {
    if (!faviconPreview || !faviconPreview.startsWith('blob:')) {
      return;
    }
    return () => URL.revokeObjectURL(faviconPreview);
  }, [faviconPreview]);

  const markDirty = () => {
    setHasChanges(true);
    setStatusMessage(null);
    onDirty?.();
  };

  const handleFileSelect = (target: UploadTarget, file: File) => {
    const previewUrl = URL.createObjectURL(file);

    if (target === 'logoLight') {
      setLogoLightPreview(previewUrl);
      setLogoLightName(file.name);
      setLogoLightFile(file);
    } else if (target === 'logoDark') {
      setLogoDarkPreview(previewUrl);
      setLogoDarkName(file.name);
      setLogoDarkFile(file);
    } else {
      setFaviconPreview(previewUrl);
      setFaviconName(file.name);
      setFaviconFile(file);
    }

    markDirty();
  };

  const handleSave = async () => {
    setIsSaving(true);
    setStatusMessage(null);

    try {
      const formData = new FormData();
      formData.append('primaryColor', primaryColor);
      formData.append('secondaryColor', secondaryColor);
      formData.append('customCss', customCss);

      if (logoLightFile) {
        formData.append('logoLight', logoLightFile);
      }
      if (logoDarkFile) {
        formData.append('logoDark', logoDarkFile);
      }
      if (faviconFile) {
        formData.append('favicon', faviconFile);
      }

      const response = await fetch('/api/settings/branding', {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        throw new Error('Failed to save branding');
      }

      setSavedBranding({
        primaryColor,
        secondaryColor,
        customCss,
        logoLightUrl: logoLightPreview,
        logoDarkUrl: logoDarkPreview,
        faviconUrl: faviconPreview,
        logoLightName,
        logoDarkName,
        faviconName
      });
      setHasChanges(false);
      setStatusMessage({ type: 'success', message: 'Branding settings saved.' });
      onSave?.();
    } catch (error) {
      setStatusMessage({
        type: 'error',
        message: error instanceof Error ? error.message : 'Something went wrong saving branding.'
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    setLogoLightPreview(savedBranding.logoLightUrl);
    setLogoDarkPreview(savedBranding.logoDarkUrl);
    setFaviconPreview(savedBranding.faviconUrl);
    setLogoLightName(savedBranding.logoLightName);
    setLogoDarkName(savedBranding.logoDarkName);
    setFaviconName(savedBranding.faviconName);
    setLogoLightFile(null);
    setLogoDarkFile(null);
    setFaviconFile(null);
    setPrimaryColor(savedBranding.primaryColor);
    setSecondaryColor(savedBranding.secondaryColor);
    setCustomCss(savedBranding.customCss);
    setHasChanges(false);
    setStatusMessage({ type: 'success', message: 'Changes reset to the last saved state.' });
    onSave?.();
  };

  const resolvedPrimary = isValidHex(primaryColor) ? primaryColor : mockBranding.primaryColor;
  const resolvedSecondary = isValidHex(secondaryColor) ? secondaryColor : mockBranding.secondaryColor;
  const primarySwatch = normalizeHex(resolvedPrimary) ?? mockBranding.primaryColor;
  const secondarySwatch = normalizeHex(resolvedSecondary) ?? mockBranding.secondaryColor;
  const primaryText = getContrastColor(resolvedPrimary, '#f8fafc');
  const secondaryText = getContrastColor(resolvedSecondary, '#0f172a');
  const initials = getInitials(mockBranding.organizationName);

  return (
    <section className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Branding editor</h2>
          <p className="text-sm text-muted-foreground">
            Customize logos, colors, and styling for {mockBranding.organizationName}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleReset}
            disabled={!hasChanges}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RefreshCcw className="h-4 w-4" />
            Reset
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-70"
          >
            <Save className="h-4 w-4" />
            {isSaving ? 'Saving...' : 'Save branding'}
          </button>
        </div>
      </div>

      {statusMessage ? (
        <div
          className={`rounded-md border px-4 py-2 text-sm ${
            statusMessage.type === 'error'
              ? 'border-destructive/40 bg-destructive/10 text-destructive'
              : 'border-emerald-200 bg-emerald-50 text-emerald-900'
          }`}
        >
          {statusMessage.message}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        <div className="space-y-6">
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Image className="h-4 w-4" />
              Logos
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <UploadDropzone
                title="Light mode logo"
                description="Displayed on light backgrounds in emails and portal."
                helper="SVG or PNG, recommended 512x512."
                preview={logoLightPreview}
                fileName={logoLightName}
                placeholder={initials}
                onFileSelect={file => handleFileSelect('logoLight', file)}
              />
              <UploadDropzone
                title="Dark mode logo"
                description="Displayed on dark backgrounds and in dark mode."
                helper="SVG or PNG, recommended 512x512."
                preview={logoDarkPreview}
                fileName={logoDarkName}
                placeholder={initials}
                previewClassName="bg-slate-950 text-white"
                onFileSelect={file => handleFileSelect('logoDark', file)}
              />
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Image className="h-4 w-4" />
              Favicon
            </div>
            <UploadDropzone
              title="Browser icon"
              description="Used in browser tabs and bookmarks."
              helper="ICO, PNG, or SVG (at least 32x32)."
              preview={faviconPreview}
              fileName={faviconName}
              placeholder="ICO"
              previewSizeClassName="h-10 w-10"
              accept="image/png,image/svg+xml,image/x-icon"
              onFileSelect={file => handleFileSelect('favicon', file)}
            />
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
                  value={primarySwatch}
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
                  value={secondarySwatch}
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

          <div className="space-y-2 rounded-lg border bg-muted/40 p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <FileCode className="h-4 w-4" />
              Custom CSS (advanced)
            </div>
            <textarea
              value={customCss}
              onChange={event => {
                setCustomCss(event.target.value);
                markDirty();
              }}
              rows={7}
              className="w-full rounded-md border bg-background px-3 py-2 text-xs font-mono"
            />
            <p className="text-xs text-muted-foreground">
              CSS is injected into your portal and email templates after saving.
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Globe className="h-4 w-4" />
            Live preview
          </div>

          <div className="space-y-4 rounded-lg border bg-muted/30 p-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Mail className="h-4 w-4" />
                Email template preview
              </div>
              <div className="overflow-hidden rounded-lg border bg-background">
                <div
                  className="flex items-center justify-between px-4 py-3"
                  style={{ backgroundColor: resolvedPrimary, color: primaryText }}
                >
                  <div className="flex items-center gap-2">
                    {logoLightPreview ? (
                      <img
                        src={logoLightPreview}
                        alt="Light logo preview"
                        className="h-8 w-8 rounded-full bg-white/20 object-cover"
                      />
                    ) : (
                      <div className="flex h-8 w-8 items-center justify-center rounded-full border border-white/30 bg-white/20 text-xs font-semibold uppercase">
                        {initials}
                      </div>
                    )}
                    <div>
                      <p className="text-sm font-semibold">{mockBranding.organizationName}</p>
                      <p className="text-xs opacity-80">Weekly activity summary</p>
                    </div>
                  </div>
                  <span className="text-xs font-semibold uppercase tracking-wide">Breeze</span>
                </div>
                <div className="space-y-3 p-4 text-sm">
                  <p>Hello Priya,</p>
                  <p className="text-muted-foreground">
                    You closed 12 tickets this week. Your average response time was 23 minutes.
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      className="rounded-md px-3 py-2 text-xs font-semibold"
                      style={{ backgroundColor: resolvedSecondary, color: secondaryText }}
                    >
                      View dashboard
                    </button>
                    <span className="text-xs text-muted-foreground">
                      Questions? {mockBranding.supportEmail}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Globe className="h-4 w-4" />
                Portal branding preview
              </div>
              <div className="space-y-4 rounded-lg border bg-background p-4">
                <div
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2"
                  style={{ borderColor: resolvedPrimary }}
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-md border bg-muted text-xs font-semibold">
                      {faviconPreview ? (
                        <img
                          src={faviconPreview}
                          alt="Favicon preview"
                          className="h-6 w-6 rounded-sm object-contain"
                        />
                      ) : (
                        initials[0] ?? 'B'
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      {logoLightPreview ? (
                        <img
                          src={logoLightPreview}
                          alt="Portal logo preview"
                          className="h-8 w-8 rounded-md object-cover"
                        />
                      ) : (
                        <div className="flex h-8 w-8 items-center justify-center rounded-md border bg-muted text-xs font-semibold">
                          {initials}
                        </div>
                      )}
                      <div>
                        <p className="text-sm font-semibold">{mockBranding.portalName}</p>
                        <p className="text-xs text-muted-foreground">{mockBranding.portalUrl}</p>
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="rounded-md px-3 py-2 text-xs font-semibold"
                    style={{ backgroundColor: resolvedSecondary, color: secondaryText }}
                  >
                    New request
                  </button>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-md border p-3" style={{ borderColor: resolvedSecondary }}>
                    <p className="text-xs text-muted-foreground">Open requests</p>
                    <p className="text-xl font-semibold">12</p>
                  </div>
                  <div className="rounded-md border p-3">
                    <p className="text-xs text-muted-foreground">CSAT score</p>
                    <p className="text-xl font-semibold">94%</p>
                  </div>
                </div>

                <div className="rounded-md border border-slate-800 bg-slate-950 p-3 text-slate-100">
                  <div className="flex items-center gap-3">
                    {logoDarkPreview ? (
                      <img
                        src={logoDarkPreview}
                        alt="Dark logo preview"
                        className="h-7 w-7 rounded-md object-cover"
                      />
                    ) : (
                      <div className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-700 bg-slate-900 text-xs font-semibold">
                        {initials}
                      </div>
                    )}
                    <div>
                      <p className="text-xs font-semibold">Dark mode header</p>
                      <p className="text-[11px] text-slate-400">Preview of dark assets</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
