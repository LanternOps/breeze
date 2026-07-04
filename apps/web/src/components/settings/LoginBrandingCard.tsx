import { useEffect, useState } from 'react';
import { Loader2, Palette, Save } from 'lucide-react';
import type { LoginContextBranding } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { sanitizeImageSrc } from '../../lib/safeImageSrc';
import { navigateTo } from '@/lib/navigation';

// Fallback swatch when no accent has been set yet, so the color picker and the
// preview have something sensible to render. Not persisted unless the user saves.
const DEFAULT_ACCENT = '#2563eb';
const HEADLINE_MAX = 120;

const inputClass = 'h-10 w-full rounded-md border bg-background px-3 text-sm';

/**
 * Partner "Login Branding" settings card (#2183). Lets a partner admin brand
 * the technician login screen (logo, accent color, headline). The login page
 * shows the branding automatically when the instance resolves to exactly one
 * partner (typical self-hosted setup) — there is no `?partner=` route or
 * query param, and multi-partner instances show no branding (v2 slug
 * discovery). Reads/writes GET/PUT /api/v1/partners/me/login-branding.
 *
 * PUT is FULL-REPLACE: we always send all three fields on every save, so an
 * omitted field is not treated as "unchanged" — it is nulled server-side.
 */
export default function LoginBrandingCard() {
  const [logoUrl, setLogoUrl] = useState('');
  const [accentColor, setAccentColor] = useState('');
  const [headline, setHeadline] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Set when the initial GET fails (non-401 error response or thrown fetch
  // error). The PUT is full-replace, so saving over an unloaded form would
  // silently wipe any real saved branding — Save is disabled until this clears.
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth('/partners/me/login-branding');
        if (res.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as { data?: LoginContextBranding | null } | null;
          const data = body?.data ?? null;
          if (!cancelled) {
            if (data) {
              setLogoUrl(data.logoUrl ?? '');
              setAccentColor(data.accentColor ?? '');
              setHeadline(data.headline ?? '');
            }
            setLoadFailed(false);
          }
        } else {
          console.error('[login-branding] failed to load current branding', res.status);
          if (!cancelled) setLoadFailed(true);
        }
      } catch (err) {
        console.error('[login-branding] failed to load current branding', err);
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await runAction<{ data: LoginContextBranding }>({
        // Full-replace: always send all three fields. A blank field goes as null
        // (cleared), never omitted — omitting would NULL it server-side anyway,
        // but sending explicit null keeps request intent unambiguous.
        request: () =>
          fetchWithAuth('/partners/me/login-branding', {
            method: 'PUT',
            body: JSON.stringify({
              logoUrl: logoUrl.trim() || null,
              accentColor: accentColor.trim() || null,
              headline: headline.trim() || null,
            }),
          }),
        successMessage: 'Login branding saved',
        errorFallback: 'Failed to save login branding',
        onUnauthorized: () => {
          void navigateTo('/login', { replace: true });
        },
      });
    } catch (err) {
      // 401 → the auth redirect is the feedback; non-401 ActionError was already
      // toasted by runAction; anything else is unexpected → surface it.
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ message: 'Failed to save login branding', type: 'error' });
      }
    } finally {
      setSaving(false);
    }
  };

  const previewAccent = accentColor.trim() || DEFAULT_ACCENT;
  const previewLogo = sanitizeImageSrc(logoUrl.trim() || null);

  if (loading) {
    return (
      <section className="rounded-lg border bg-card p-6 shadow-xs" data-testid="login-branding-card">
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-lg border bg-card p-6 shadow-xs" data-testid="login-branding-card">
      <div className="mb-6">
        <div className="flex items-center gap-2">
          <Palette className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Login Branding</h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Brand the technician login screen. Shown automatically when this deployment resolves to a
          single partner (typical self-hosted setup).
        </p>
      </div>

      {loadFailed && (
        <div
          role="alert"
          className="mb-6 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          Couldn't load your current branding — reload the page before saving, or you may overwrite
          existing settings.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Fields */}
        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="login-branding-logo-url" className="text-sm font-medium">
              Logo URL
            </label>
            <input
              id="login-branding-logo-url"
              data-testid="login-branding-logo-url"
              type="url"
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              placeholder="https://cdn.example.com/logo.png"
              className={inputClass}
            />
            <p className="text-xs text-muted-foreground">
              An <code>https://</code> URL to your logo. Leave blank for no logo.
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="login-branding-accent-hex" className="text-sm font-medium">
              Accent color
            </label>
            <div className="flex items-center gap-3">
              <input
                aria-label="Accent color picker"
                data-testid="login-branding-accent-color"
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(accentColor) ? accentColor : DEFAULT_ACCENT}
                onChange={(e) => setAccentColor(e.target.value)}
                className="h-10 w-14 shrink-0 cursor-pointer rounded-md border bg-background"
              />
              <input
                id="login-branding-accent-hex"
                data-testid="login-branding-accent-hex"
                type="text"
                value={accentColor}
                onChange={(e) => setAccentColor(e.target.value)}
                placeholder="#2563eb"
                maxLength={7}
                className={inputClass}
              />
            </div>
            <p className="text-xs text-muted-foreground">A <code>#rrggbb</code> hex color.</p>
          </div>

          <div className="space-y-2">
            <label htmlFor="login-branding-headline" className="text-sm font-medium">
              Headline
            </label>
            <input
              id="login-branding-headline"
              data-testid="login-branding-headline"
              type="text"
              value={headline}
              onChange={(e) => setHeadline(e.target.value)}
              placeholder="Sign in to Acme IT"
              maxLength={HEADLINE_MAX}
              className={inputClass}
            />
            <p className="text-xs text-muted-foreground">
              {headline.length}/{HEADLINE_MAX} characters.
            </p>
          </div>
        </div>

        {/* Live preview */}
        <div className="space-y-2">
          <span className="text-sm font-medium">Preview</span>
          <div
            data-testid="login-branding-preview"
            className="flex min-h-40 flex-col items-center justify-center gap-4 rounded-lg border p-6 text-center"
            style={{ backgroundColor: previewAccent }}
          >
            {previewLogo && (
              <img
                src={previewLogo}
                alt="Login logo preview"
                className="max-h-16 max-w-[70%] object-contain"
              />
            )}
            <div className="rounded-md bg-white/90 px-4 py-3 shadow-sm">
              <p className="text-base font-semibold text-gray-900">
                {headline.trim() || 'Sign in to your account'}
              </p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Approximate preview of the technician login screen.
          </p>
        </div>
      </div>

      <div className="mt-6 flex justify-end">
        <button
          type="button"
          onClick={save}
          disabled={saving || loadFailed}
          data-testid="login-branding-save"
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saving ? 'Saving...' : 'Save branding'}
        </button>
      </div>
    </section>
  );
}
