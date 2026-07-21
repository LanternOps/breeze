# Sidebar Partner Branding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let partners upload a logo via the Partner Settings → Branding tab (stored as a base64 data URI in the existing `partner.settings` JSONB column), then render that logo + partner name in the admin sidebar top-left in place of the hard-coded Breeze SVG / "Breeze" text.

**Architecture:** Three layers of work. (1) Extend `sanitizeImageSrc` to accept safe `data:image/…` URIs (PNG/JPEG/WebP only, size-capped). (2) Add a file-upload UI to `PartnerBrandingTab` — canvas-resize client-side to ≤256×256, encode to PNG base64, store in `branding.logoUrl` via the existing `PATCH /orgs/partners/me` endpoint; add a server-side length cap. (3) Build a `BrandHeader` component and wire it into `Sidebar`, which fetches `/orgs/partners/me` on mount to pull branding.

**Tech Stack:** React (Astro Islands), TypeScript, Tailwind, Vitest + React Testing Library, `fetchWithAuth` + `sanitizeImageSrc`, Canvas API (client-side resize), Zod (server-side cap), Hono (`apps/api/src/routes/orgs.ts`).

---

## File Map

- **Modify** `apps/web/src/lib/safeImageSrc.ts` — extend to allow `data:image/(png|jpeg|webp);base64,…` URIs up to 400 000 chars; reject SVG and other MIME types.
- **Modify** `apps/web/src/lib/safeImageSrc.test.ts` — add data URI test cases.
- **Modify** `apps/web/src/components/settings/PartnerBrandingTab.tsx` — replace the `<input type="url">` logo field with a file-picker (canvas resize → PNG base64) + preview + remove button + URL fallback.
- **Modify** `apps/api/src/routes/orgs.ts` — add `.max(400_000)` to the `branding.logoUrl` Zod field (line 359).
- **Create** `apps/web/src/components/layout/BrandHeader.tsx` — presentational component: renders sanitized `<img>` or Breeze SVG fallback + optional label.
- **Create** `apps/web/src/components/layout/BrandHeader.test.tsx` — unit tests covering fallback, branded HTTPS URL, data URI, and unsafe URL rejection.
- **Modify** `apps/web/src/components/layout/Sidebar.tsx` — add branding fetch effect + state; replace desktop + mobile brand blocks with `<BrandHeader />`.

---

## Task 1: Extend `sanitizeImageSrc` to allow safe data URIs (TDD)

**Files:**
- Modify: `apps/web/src/lib/safeImageSrc.ts`
- Modify: `apps/web/src/lib/safeImageSrc.test.ts`

- [ ] **Step 1: Write the failing tests**

Open `apps/web/src/lib/safeImageSrc.test.ts` and append these cases to the existing `sanitizeImageSrc` describe block:

```ts
// Data URI cases
it('accepts a valid PNG data URI within the size limit', () => {
  const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  expect(sanitizeImageSrc(dataUri)).toBe(dataUri);
});

it('accepts a valid JPEG data URI', () => {
  const dataUri = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARC';
  expect(sanitizeImageSrc(dataUri)).toBe(dataUri);
});

it('accepts a valid WebP data URI', () => {
  const dataUri = 'data:image/webp;base64,UklGRlYAAABXRUJQVlA4IEoAAADQAQCdASoBAAEAAkA4JYgCdAEO/gHOAAA=';
  expect(sanitizeImageSrc(dataUri)).toBe(dataUri);
});

it('rejects SVG data URI (XSS risk)', () => {
  expect(sanitizeImageSrc('data:image/svg+xml;base64,PHN2Zy8+')).toBeNull();
});

it('rejects HTML data URI', () => {
  expect(sanitizeImageSrc('data:text/html;base64,PGh0bWwv>')).toBeNull();
});

it('rejects a data URI that exceeds the size limit', () => {
  const oversized = 'data:image/png;base64,' + 'A'.repeat(400_001);
  expect(sanitizeImageSrc(oversized)).toBeNull();
});

it('rejects a data URI without the base64 marker', () => {
  expect(sanitizeImageSrc('data:image/png,rawbytes')).toBeNull();
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm --filter=@breeze/web test safeImageSrc -- --run`
Expected: FAIL — the data URI cases return `null` instead of the URI (because the current code rejects `data:` protocol).

- [ ] **Step 3: Implement the change**

Open `apps/web/src/lib/safeImageSrc.ts`. Add the data URI guard immediately before the existing `blob:` check (currently line 25):

```ts
const DATA_IMAGE_PATTERN = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
const MAX_DATA_URI_LENGTH = 400_000; // ~300 KB file after base64 inflation

export function sanitizeImageSrc(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const candidate = value.trim();
  if (!candidate || CONTROL_CHARS_PATTERN.test(candidate)) {
    return null;
  }

  // Safe raster data URIs (PNG, JPEG, WebP only — SVG rejected for XSS risk)
  if (candidate.startsWith('data:')) {
    if (candidate.length > MAX_DATA_URI_LENGTH) return null;
    return DATA_IMAGE_PATTERN.test(candidate) ? candidate : null;
  }

  if (candidate.startsWith('blob:')) {
    return candidate;
  }

  // … rest of function unchanged
```

The full updated file should look like this (replace the entire file contents):

```ts
const CONTROL_CHARS_PATTERN = /[\u0000-\u001F\u007F]/;
const DATA_IMAGE_PATTERN = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
const MAX_DATA_URI_LENGTH = 400_000;

function isSafeRelativePath(value: string): boolean {
  if (!value.startsWith('/')) {
    return false;
  }

  if (value.startsWith('//') || value.startsWith('/\\')) {
    return false;
  }

  return !CONTROL_CHARS_PATTERN.test(value);
}

export function sanitizeImageSrc(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const candidate = value.trim();
  if (!candidate || CONTROL_CHARS_PATTERN.test(candidate)) {
    return null;
  }

  if (candidate.startsWith('data:')) {
    if (candidate.length > MAX_DATA_URI_LENGTH) return null;
    return DATA_IMAGE_PATTERN.test(candidate) ? candidate : null;
  }

  if (candidate.startsWith('blob:')) {
    return candidate;
  }

  if (isSafeRelativePath(candidate)) {
    return candidate;
  }

  try {
    const parsed = new URL(candidate);
    const protocol = parsed.protocol.toLowerCase();

    if (protocol === 'https:' || protocol === 'http:') {
      return parsed.toString();
    }

    return null;
  } catch {
    return null;
  }
}

export function isSafeImageSrc(value: string | null | undefined): boolean {
  return sanitizeImageSrc(value) !== null;
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `pnpm --filter=@breeze/web test safeImageSrc -- --run`
Expected: PASS — all existing tests plus the 7 new data URI cases are green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/safeImageSrc.ts apps/web/src/lib/safeImageSrc.test.ts
git commit -m "feat(web): allow safe raster data URIs in sanitizeImageSrc"
```

---

## Task 2: Add server-side size cap to `logoUrl`

**Files:**
- Modify: `apps/api/src/routes/orgs.ts:359`

- [ ] **Step 1: Update the Zod schema**

In `apps/api/src/routes/orgs.ts`, find line 359 (inside `updatePartnerSettingsSchema`):

```ts
    logoUrl: z.string().optional(),
```

Replace with:

```ts
    logoUrl: z.string().max(400_000, 'Logo data exceeds maximum size (400 KB)').optional(),
```

- [ ] **Step 2: Type-check the API**

Run: `pnpm --filter=@breeze/api exec tsc --noEmit`
Expected: PASS — no new errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/orgs.ts
git commit -m "feat(api): enforce 400 KB size cap on partner branding logoUrl"
```

---

## Task 3: Upload UI in `PartnerBrandingTab`

**Files:**
- Modify: `apps/web/src/components/settings/PartnerBrandingTab.tsx`

Replaces the plain URL `<input>` with a file-picker that resizes the image client-side to fit 256×256, encodes it as a PNG data URI, and stores it in `data.logoUrl`. A URL text input is still shown as a fallback when no file has been uploaded (i.e. `logoUrl` is empty or an HTTPS URL).

- [ ] **Step 1: Add imports**

At the top of `apps/web/src/components/settings/PartnerBrandingTab.tsx`, replace:

```ts
import type { InheritableBrandingSettings } from '@breeze/shared';
```

with:

```ts
import { useState } from 'react';
import type { InheritableBrandingSettings } from '@breeze/shared';
import { sanitizeImageSrc } from '../../lib/safeImageSrc';
```

- [ ] **Step 2: Add the resize helper and constants above the component**

After the imports, before `const PLACEHOLDER = …`, insert:

```ts
const MAX_LOGO_BYTES = 300_000; // 300 KB raw file; base64 will be ≤400 KB
const LOGO_ACCEPT = 'image/png,image/jpeg,image/webp';

/** Resize `file` to fit within 256×256 and return a PNG data URI. */
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
```

- [ ] **Step 3: Add local error state to the component**

Inside `PartnerBrandingTab`, immediately after the `const set = …` line, add:

```ts
  const [logoError, setLogoError] = useState<string | null>(null);
```

- [ ] **Step 4: Add the upload handler**

Immediately after the `logoError` state line, add:

```ts
  const handleLogoFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setLogoError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError(`File too large (${Math.round(file.size / 1024)} KB). Maximum is 300 KB.`);
      e.target.value = '';
      return;
    }
    try {
      const dataUrl = await resizeToDataUrl(file);
      set({ logoUrl: dataUrl });
    } catch {
      setLogoError('Could not read image. Please try a different file.');
      e.target.value = '';
    }
  };
```

- [ ] **Step 5: Replace the logo URL JSX**

Find the existing Logo URL section in the JSX:

```tsx
        <div className="space-y-2">
          <label className="text-sm font-medium">Logo URL</label>
          <input
            type="url"
            value={data.logoUrl ?? ''}
            onChange={e => set({ logoUrl: e.target.value || undefined })}
            placeholder={PLACEHOLDER}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          />
        </div>
```

Replace it with:

```tsx
        <div className="space-y-2 col-span-full">
          <label className="text-sm font-medium">Logo</label>
          <div className="rounded-lg border bg-muted/40 p-4 space-y-3">
            <div className="flex items-center gap-4">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border bg-background overflow-hidden">
                {sanitizeImageSrc(data.logoUrl) ? (
                  <img
                    src={sanitizeImageSrc(data.logoUrl)!}
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
              PNG, JPEG, or WebP · max 300 KB · resized to fit 256×256
            </p>
            {logoError && (
              <p className="text-xs text-destructive">{logoError}</p>
            )}
            {/* URL fallback — only shown when no uploaded data URI is set */}
            {!data.logoUrl?.startsWith('data:') && (
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Or paste an image URL</label>
                <input
                  type="url"
                  value={data.logoUrl ?? ''}
                  onChange={e => set({ logoUrl: e.target.value || undefined })}
                  placeholder={PLACEHOLDER}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                />
              </div>
            )}
          </div>
        </div>
```

- [ ] **Step 6: Type-check**

Run: `pnpm --filter=@breeze/web exec tsc --noEmit`
Expected: PASS — no new errors.

- [ ] **Step 7: Visual smoke test (manual)**

1. Open `/settings/partner` → Branding tab.
2. Click **Upload image** and select a PNG > 300 KB. Expect error message "File too large".
3. Select a PNG < 300 KB. Expect a preview to appear in the 56×56 box; "Or paste an image URL" input disappears.
4. Click **Remove**. Preview clears; URL input reappears.
5. Paste `https://placehold.co/64x64/png?text=A` in the URL input. Preview shows the placeholder.
6. Click **Save Settings**. Reload; branding should persist.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/settings/PartnerBrandingTab.tsx
git commit -m "feat(web): add logo upload UI to PartnerBrandingTab (base64 via canvas resize)"
```

---

## Task 4: Create `BrandHeader` component (TDD)

**Files:**
- Create: `apps/web/src/components/layout/BrandHeader.tsx`
- Create: `apps/web/src/components/layout/BrandHeader.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/layout/BrandHeader.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import BrandHeader from './BrandHeader';

const PNG_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('BrandHeader', () => {
  it('renders the Breeze SVG fallback when logoUrl is null', () => {
    const { container } = render(<BrandHeader logoUrl={null} name={null} showLabel />);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders "Breeze" when name is null and showLabel is true', () => {
    render(<BrandHeader logoUrl={null} name={null} showLabel />);
    expect(screen.getByText('Breeze')).toBeInTheDocument();
  });

  it('renders the partner name when provided and showLabel is true', () => {
    render(<BrandHeader logoUrl={null} name="Acme MSP" showLabel />);
    expect(screen.getByText('Acme MSP')).toBeInTheDocument();
    expect(screen.queryByText('Breeze')).not.toBeInTheDocument();
  });

  it('hides the label when showLabel is false', () => {
    render(<BrandHeader logoUrl={null} name="Acme MSP" showLabel={false} />);
    expect(screen.queryByText('Acme MSP')).not.toBeInTheDocument();
  });

  it('renders an <img> for a valid HTTPS URL', () => {
    render(<BrandHeader logoUrl="https://cdn.example.com/logo.png" name="Acme MSP" showLabel />);
    const img = screen.getByRole('img', { name: /acme msp logo/i }) as HTMLImageElement;
    expect(img.src).toBe('https://cdn.example.com/logo.png');
  });

  it('renders an <img> for a valid PNG data URI', () => {
    render(<BrandHeader logoUrl={PNG_DATA_URI} name="Acme MSP" showLabel />);
    expect(screen.getByRole('img', { name: /acme msp logo/i })).toBeInTheDocument();
  });

  it('falls back to the SVG for an unsafe URL', () => {
    const { container } = render(
      <BrandHeader logoUrl="javascript:alert(1)" name="Acme MSP" showLabel />
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('falls back to the SVG for an SVG data URI', () => {
    const { container } = render(
      <BrandHeader logoUrl="data:image/svg+xml;base64,PHN2Zy8+" name="Acme MSP" showLabel />
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm --filter=@breeze/web test BrandHeader -- --run`
Expected: FAIL — `Cannot find module './BrandHeader'`.

- [ ] **Step 3: Implement the component**

Create `apps/web/src/components/layout/BrandHeader.tsx`:

```tsx
import { sanitizeImageSrc } from '../../lib/safeImageSrc';

interface BrandHeaderProps {
  /** Partner logo. Sanitized before render; falls back to the Breeze SVG when null/unsafe. */
  logoUrl: string | null | undefined;
  /** Partner name. Falls back to "Breeze" when null/empty. */
  name: string | null | undefined;
  /** Whether to render the text label (hidden in collapsed sidebar mode). */
  showLabel: boolean;
}

const BREEZE_SVG = (
  <svg width="14" height="14" viewBox="0 0 64 64" fill="none" className="text-primary">
    <path
      d="M12 22C12 22 20 22 28 22C36 22 40 16 48 16C52 16 54 18 54 20C54 22 52 24 48 24C44 24 42 22 42 22"
      stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
    />
    <path
      d="M8 34C8 34 18 34 30 34C42 34 46 28 52 28C55 28 57 30 57 32C57 34 55 36 52 36C48 36 46 34 46 34"
      stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
    />
    <path
      d="M14 46C14 46 22 46 32 46C40 46 44 40 50 40C53 40 55 42 55 44C55 46 53 48 50 48C46 48 44 46 44 46"
      stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
    />
  </svg>
);

export default function BrandHeader({ logoUrl, name, showLabel }: BrandHeaderProps) {
  const safeLogoUrl = sanitizeImageSrc(logoUrl);
  const label = name?.trim() || 'Breeze';

  return (
    <div className="flex items-center gap-2">
      <div className="flex h-[22px] w-[22px] shrink-0 items-center justify-center overflow-hidden rounded-[6px] bg-primary/15">
        {safeLogoUrl ? (
          <img src={safeLogoUrl} alt={`${label} logo`} className="h-full w-full object-contain" />
        ) : (
          BREEZE_SVG
        )}
      </div>
      {showLabel && (
        <span className="text-lg font-bold tracking-tight text-foreground truncate">{label}</span>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `pnpm --filter=@breeze/web test BrandHeader -- --run`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Type-check**

Run: `pnpm --filter=@breeze/web exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/layout/BrandHeader.tsx apps/web/src/components/layout/BrandHeader.test.tsx
git commit -m "feat(web): add BrandHeader component for partner-branded sidebar logo"
```

---

## Task 5: Wire `BrandHeader` into `Sidebar`

**Files:**
- Modify: `apps/web/src/components/layout/Sidebar.tsx`

- [ ] **Step 1: Add the `BrandHeader` import**

In `Sidebar.tsx`, add after the `import { WEB_VERSION } from '../../lib/version';` line (line 43):

```tsx
import BrandHeader from './BrandHeader';
```

- [ ] **Step 2: Add partner-branding state**

Find the `// Fetch API version once` comment (~line 232) and insert the two state declarations immediately above it:

```tsx
  const [brandName, setBrandName] = useState<string | null>(null);
  const [brandLogoUrl, setBrandLogoUrl] = useState<string | null>(null);
```

- [ ] **Step 3: Add the partner-branding fetch effect**

Immediately after the existing `useEffect` that fetches `/system/version` (its closing `}, []);`), add:

```tsx
  // Fetch partner branding for the top-left header. Silently falls back on 403/404 (system-scoped users).
  useEffect(() => {
    let cancelled = false;
    fetchWithAuth('/orgs/partners/me')
      .then((r) => {
        if (!r.ok) return null;
        return r.json() as Promise<{ name?: string; settings?: { branding?: { logoUrl?: string } } }>;
      })
      .then((data) => {
        if (cancelled || !data) return;
        setBrandName(data.name ?? null);
        setBrandLogoUrl(data.settings?.branding?.logoUrl ?? null);
      })
      .catch((err) => {
        console.warn('[Sidebar] Failed to fetch partner branding:', err);
      });
    return () => { cancelled = true; };
  }, []);
```

- [ ] **Step 4: Replace the desktop sidebar brand block**

Find (lines 442–453):

```tsx
        <div className="flex items-center gap-2">
          <div className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px] bg-primary/15">
            <svg width="14" height="14" viewBox="0 0 64 64" fill="none" className="text-primary">
              <path d="M12 22C12 22 20 22 28 22C36 22 40 16 48 16C52 16 54 18 54 20C54 22 52 24 48 24C44 24 42 22 42 22" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M8 34C8 34 18 34 30 34C42 34 46 28 52 28C55 28 57 30 57 32C57 34 55 36 52 36C48 36 46 34 46 34" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M14 46C14 46 22 46 32 46C40 46 44 40 50 40C53 40 55 42 55 44C55 46 53 48 50 48C46 48 44 46 44 46" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          {showLabels && (
            <span className="text-lg font-bold tracking-tight text-foreground">Breeze</span>
          )}
        </div>
```

Replace with:

```tsx
        <BrandHeader logoUrl={brandLogoUrl} name={brandName} showLabel={showLabels} />
```

- [ ] **Step 5: Replace the mobile overlay brand block**

Find (lines 492–501):

```tsx
          <div className="flex items-center gap-2">
            <div className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px] bg-primary/15">
              <svg width="14" height="14" viewBox="0 0 64 64" fill="none" className="text-primary">
                <path d="M12 22C12 22 20 22 28 22C36 22 40 16 48 16C52 16 54 18 54 20C54 22 52 24 48 24C44 24 42 22 42 22" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M8 34C8 34 18 34 30 34C42 34 46 28 52 28C55 28 57 30 57 32C57 34 55 36 52 36C48 36 46 34 46 34" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M14 46C14 46 22 46 32 46C40 46 44 40 50 40C53 40 55 42 55 44C55 46 53 48 50 48C46 48 44 46 44 46" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <span className="text-lg font-bold tracking-tight text-foreground">Breeze</span>
          </div>
```

Replace with:

```tsx
          <BrandHeader logoUrl={brandLogoUrl} name={brandName} showLabel />
```

- [ ] **Step 6: Type-check and test**

Run both:
```bash
pnpm --filter=@breeze/web exec tsc --noEmit
pnpm --filter=@breeze/web test -- --run
```
Expected: both PASS.

- [ ] **Step 7: Visual smoke test (manual)**

1. Start dev server.
2. Log in as a partner-scoped user.
3. Go to `/settings/partner` → Branding → upload a small PNG. Save.
4. Hard-refresh any page. Top-left of the sidebar shows the partner logo + name instead of the Breeze SVG.
5. Collapse the sidebar — label hides, logo box stays.
6. Mobile overlay (< 768px) also shows the branded header.
7. Log in as a system-scoped user — sidebar falls back silently to Breeze defaults.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/layout/Sidebar.tsx
git commit -m "feat(web): render partner branding logo + name in sidebar header"
```

---

## Notes / Decisions

- **Storage:** Base64 data URI stored in the existing `partner.settings` JSONB column (`branding.logoUrl`). No new storage infrastructure needed. The ~33% base64 inflation is acceptable for a one-time sidebar fetch on each page load.
- **Size cap:** 300 KB raw file → ≤400 KB base64 string. Enforced both client-side (before encoding) and server-side (Zod `.max(400_000)`).
- **Formats accepted:** PNG, JPEG, WebP only. SVG is rejected in both the file picker (`accept=`) and `sanitizeImageSrc` (XSS risk from embedded scripts).
- **Client-side resize:** Canvas scales the image to fit within 256×256 before encoding, keeping the stored payload small regardless of what the user uploads.
- **Sanitization:** `sanitizeImageSrc` now allows safe raster data URIs and continues to block `javascript:`, `data:text/html`, `data:image/svg+xml`, and oversized values.
- **URL fallback:** The URL text input stays visible in `PartnerBrandingTab` when no file has been uploaded — partners with CDN-hosted logos can still paste a URL.
- **Auth scope:** `/orgs/partners/me` requires `requireScope('partner')`. System-scoped users get a 403, silently ignored by the `if (!r.ok) return null` guard in Sidebar.
- **Caching:** Branding fetch happens once per Sidebar mount, mirroring the existing `apiVersion` pattern. No store changes — YAGNI.
- **Out of scope:** primary/secondary color theming, custom CSS, favicon, portal branding, any other branding fields.
