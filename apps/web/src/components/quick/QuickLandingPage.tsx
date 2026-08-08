import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { formatSupportCode, normalizeSupportCode } from '@breeze/shared';
import { sanitizeImageSrc } from '@/lib/safeImageSrc';
// Initializes the shared i18next singleton. This page's layout has no Sidebar
// (which is what pulls i18n in elsewhere), so without this every t() call here
// renders its raw key. It is also the only page a logged-out stranger sees.
import '@/lib/i18n';

const API_BASE = (import.meta.env.PUBLIC_API_URL || '').trim();

/**
 * Display-only branding for the MSP behind the code, returned by /check for a
 * VALID code only. Never carries an id — it exists to reassure the end user
 * that the person on the phone is who they say they are, nothing more.
 */
export type QuickBranding = {
  partnerName: string;
  logoUrl: string | null;
  accentColor: string | null;
  headline: string | null;
};

/**
 * The check endpoint is deliberately unauthenticated — the one-time code IS the
 * credential — so this uses a plain `fetch`, never `fetchWithAuth`: an end user
 * on this page has no Breeze account and no token.
 */
type CheckState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'valid'; code: string; branding: QuickBranding | null }
  | { phase: 'invalid' }
  | { phase: 'unreachable'; code: string };

export type QuickOs = 'windows' | 'macos' | 'ios' | 'android' | 'linux' | 'unknown';
export type QuickBrowser = 'edge' | 'chrome' | 'other';
export type QuickClient = { os: QuickOs; browser: QuickBrowser };

/**
 * Which machine is the stranger reading this page on?
 *
 * A pure function of the two strings the browser exposes so it can be unit
 * tested per platform — the page shows a Windows download, a "not on Mac yet"
 * message or a "go to the PC that needs help" notice off the back of it.
 *
 * Detection is advisory, never a gate: `unknown` keeps the full Windows flow
 * visible rather than stranding a user behind a UA string we failed to parse.
 */
export function detectQuickClient(userAgent: string, platformHint?: string | null): QuickClient {
  return { os: detectOs(userAgent ?? '', platformHint ?? ''), browser: detectBrowser(userAgent ?? '') };
}

function detectOs(userAgent: string, platformHint: string): QuickOs {
  // navigator.userAgentData.platform is the reliable signal where it exists
  // ("Windows", "macOS", "Android", "Linux"), so it wins over UA sniffing.
  const hint = platformHint.toLowerCase();
  if (hint.includes('win')) return 'windows';
  if (hint.includes('android')) return 'android';
  if (hint.includes('ios') || hint.includes('iphone') || hint.includes('ipad')) return 'ios';
  if (hint.includes('mac')) return 'macos';
  if (hint.includes('linux') || hint.includes('cros') || hint.includes('chrome os')) return 'linux';

  // Order matters: an Android UA also says "Linux", and every iOS UA says
  // "like Mac OS X".
  if (/android/i.test(userAgent)) return 'android';
  if (/iphone|ipad|ipod/i.test(userAgent)) return 'ios';
  if (/windows/i.test(userAgent)) return 'windows';
  if (/mac os x|macintosh/i.test(userAgent)) return 'macos';
  if (/linux|x11|cros/i.test(userAgent)) return 'linux';
  return 'unknown';
}

function detectBrowser(userAgent: string): QuickBrowser {
  // Edge and Opera both carry "Chrome/" in their UA, so they are matched first.
  if (/edg(e|a|ios)?\//i.test(userAgent)) return 'edge';
  if (/opr\//i.test(userAgent)) return 'other';
  if (/(chrome|crios|chromium)\//i.test(userAgent)) return 'chrome';
  return 'other';
}

/**
 * The accent color is partner-controlled text that lands in an inline style,
 * so it is re-checked here even though the API already filters it: only an
 * exact #RRGGBB ever reaches the DOM.
 */
function safeAccent(value: string | null | undefined): string | null {
  return value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : null;
}

function downloadUrl(code: string): string {
  return `${API_BASE}/api/v1/support/download/windows?code=${encodeURIComponent(code)}`;
}

export default function QuickLandingPage() {
  const { t } = useTranslation('quick');
  const [state, setState] = useState<CheckState>({ phase: 'idle' });
  const [entry, setEntry] = useState('');
  const [formatError, setFormatError] = useState(false);
  // Detected after mount, never during render: this island is server-rendered
  // by Astro, where `navigator` does not exist.
  const [client, setClient] = useState<QuickClient>({ os: 'unknown', browser: 'other' });

  useEffect(() => {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    setClient(detectQuickClient(nav.userAgent, nav.userAgentData?.platform));
  }, []);

  const checkCode = useCallback(async (code: string) => {
    setState({ phase: 'checking' });
    try {
      const response = await fetch(`${API_BASE}/api/v1/support/check/${encodeURIComponent(code)}`);
      const body = (await response.json()) as
        | { valid?: boolean; branding?: QuickBranding | null }
        | null;
      setState(
        response.ok && body?.valid === true
          ? { phase: 'valid', code, branding: body.branding ?? null }
          : { phase: 'invalid' },
      );
    } catch {
      // A network failure is not the same as a rejected code: telling the user
      // their code is dead when the connection dropped sends them back to the
      // technician for nothing.
      setState({ phase: 'unreachable', code });
    }
  }, []);

  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get('code');
    if (!raw) return;
    const normalized = normalizeSupportCode(raw);
    if (!normalized) {
      setEntry(raw);
      setFormatError(true);
      return;
    }
    setEntry(formatSupportCode(normalized));
    void checkCode(normalized);
  }, [checkCode]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = normalizeSupportCode(entry);
    if (!normalized) {
      setFormatError(true);
      return;
    }
    setFormatError(false);
    setEntry(formatSupportCode(normalized));
    void checkCode(normalized);
  };

  const showForm = state.phase !== 'valid' && state.phase !== 'checking';
  const branding = state.phase === 'valid' ? state.branding : null;
  const accent = safeAccent(branding?.accentColor);
  // A custom property rather than a bare backgroundColor so the same accent can
  // be picked up by anything else in the subtree without re-plumbing the value.
  const accentStyle: CSSProperties | undefined = accent
    ? ({ '--quick-accent': accent, backgroundColor: 'var(--quick-accent)' } as CSSProperties)
    : undefined;
  const logo = sanitizeImageSrc(branding?.logoUrl);
  const isMobile = client.os === 'ios' || client.os === 'android';
  // Step 1 is entering the code; once it checks out the user is on step 2.
  const currentStep = state.phase === 'valid' ? 2 : 1;

  const steps = [
    { number: 1, title: t('steps.one.title'), body: t('steps.one.body') },
    { number: 2, title: t('steps.two.title'), body: t('steps.two.body') },
    { number: 3, title: t('steps.three.title'), body: t('steps.three.body') },
  ];

  const browserHint =
    client.browser === 'edge'
      ? t('download.hintEdge')
      : client.browser === 'chrome'
        ? t('download.hintChrome')
        : t('download.hintGeneric');

  return (
    <div className="space-y-6">
      <header className="space-y-3 text-center">
        {branding ? (
          <div data-testid="quick-branding" className="space-y-2">
            {logo && (
              <img
                data-testid="quick-branding-logo"
                src={logo}
                alt=""
                className="mx-auto h-10 max-w-[200px] object-contain"
              />
            )}
            <h2 className="text-lg font-semibold">
              {t('branding.title', { partner: branding.partnerName })}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t('branding.subtitle', { partner: branding.partnerName })}
            </p>
            {branding.headline && (
              <p className="text-sm text-muted-foreground">{branding.headline}</p>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <h2 className="text-lg font-semibold">{t('page.title')}</h2>
            <p className="text-sm text-muted-foreground">{t('page.intro')}</p>
          </div>
        )}
      </header>

      {isMobile && (
        <div
          data-testid="quick-mobile-notice"
          role="status"
          className="space-y-1 rounded-lg border border-primary/40 bg-primary/5 p-4"
        >
          <p className="text-base font-semibold">{t('mobile.title')}</p>
          <p className="text-sm text-muted-foreground">{t('mobile.body')}</p>
        </div>
      )}

      <ol data-testid="quick-steps" className="grid gap-3 sm:grid-cols-3">
        {steps.map((step) => (
          <li
            key={step.number}
            data-testid={`quick-step-${step.number}`}
            aria-current={step.number === currentStep ? 'step' : undefined}
            className={`rounded-lg border bg-card p-3 ${
              step.number === currentStep ? 'border-primary' : ''
            }`}
          >
            <span className="block text-2xl font-bold leading-none text-muted-foreground">
              {step.number}
            </span>
            <p className="mt-2 text-sm font-semibold">{step.title}</p>
            <p className="mt-1 text-sm text-muted-foreground">{step.body}</p>
          </li>
        ))}
      </ol>

      {state.phase === 'checking' && (
        <p className="text-center text-sm text-muted-foreground" aria-busy="true">
          {t('checking')}
        </p>
      )}

      {state.phase === 'invalid' && (
        <div
          data-testid="quick-invalid-code"
          role="status"
          className="space-y-1 rounded-lg border border-destructive/40 bg-destructive/5 p-4"
        >
          <p className="text-sm font-semibold">{t('invalid.title')}</p>
          <p className="text-sm text-muted-foreground">{t('invalid.body')}</p>
        </div>
      )}

      {state.phase === 'unreachable' && (
        <div
          data-testid="quick-check-error"
          role="status"
          className="space-y-2 rounded-lg border bg-card p-4"
        >
          <p className="text-sm font-semibold">{t('checkFailed.title')}</p>
          <p className="text-sm text-muted-foreground">{t('checkFailed.body')}</p>
          <button
            type="button"
            className="h-9 rounded-md border px-3 text-sm font-medium transition hover:bg-muted"
            onClick={() => void checkCode(state.code)}
          >
            {t('checkFailed.retry')}
          </button>
        </div>
      )}

      {showForm && (
        <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border bg-card p-4">
          <div className="space-y-1">
            <label htmlFor="quick-code" className="text-sm font-medium">
              {t('code.heading')}
            </label>
            <p className="text-sm text-muted-foreground">{t('code.help')}</p>
          </div>
          <input
            id="quick-code"
            data-testid="quick-code-input"
            name="code"
            // type=text with a numeric keypad hint, deliberately NOT type=number
            // or a digits-only pattern: codes minted before the digit alphabet
            // still contain letters and must remain typeable.
            type="text"
            inputMode="numeric"
            aria-label={t('code.label')}
            value={entry}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder={t('code.placeholder')}
            onChange={(event) => {
              setEntry(event.target.value);
              setFormatError(false);
            }}
            className="h-11 w-full rounded-md border bg-background px-3 text-center font-mono text-lg tracking-widest"
          />
          {formatError && (
            <p data-testid="quick-code-format-error" role="alert" className="text-sm text-destructive">
              {t('code.formatError')}
            </p>
          )}
          <button
            type="submit"
            data-testid="quick-code-submit"
            style={accentStyle}
            className="h-11 w-full rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
          >
            {t('code.submit')}
          </button>
        </form>
      )}

      {state.phase === 'valid' && (
        <div className="space-y-4 rounded-lg border bg-card p-4">
          <div className="space-y-1">
            <p className="text-sm font-semibold">{t('ready.title')}</p>
            <p className="text-sm text-muted-foreground">
              {t('ready.codeIntro', { code: formatSupportCode(state.code) })}
            </p>
          </div>

          {isMobile ? (
            // Nothing downloadable here is of any use on a phone — the whole
            // instruction is "go to the machine that needs fixing".
            <p data-testid="quick-mobile-download-hidden" className="text-sm text-muted-foreground">
              {t('mobile.downloadHidden')}
            </p>
          ) : (
            <>
              {client.os === 'macos' && (
                <div
                  data-testid="quick-download-macos"
                  aria-disabled="true"
                  className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3"
                >
                  <p className="text-sm font-semibold">{t('download.macosPrimaryTitle')}</p>
                  <p className="text-sm text-muted-foreground">{t('download.macosPrimaryBody')}</p>
                </div>
              )}

              <a
                data-testid="quick-download-windows"
                href={downloadUrl(state.code)}
                style={client.os === 'macos' ? undefined : accentStyle}
                className={
                  client.os === 'macos'
                    ? 'flex h-11 w-full items-center justify-center rounded-md border text-sm font-medium transition hover:bg-muted'
                    : 'flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:bg-primary/90'
                }
              >
                {t('download.windows')}
              </a>

              {client.os === 'windows' && (
                <p data-testid="quick-browser-hint" className="text-sm text-muted-foreground">
                  {browserHint}
                </p>
              )}

              {(client.os === 'linux' || client.os === 'unknown') && (
                <p data-testid="quick-platform-note" className="text-sm text-muted-foreground">
                  {t('download.windowsOnly')}
                </p>
              )}

              <p className="text-sm text-muted-foreground">
                {t('download.manualFallback', { code: formatSupportCode(state.code) })}
              </p>

              {client.os !== 'macos' && (
                <div
                  data-testid="quick-download-macos"
                  aria-disabled="true"
                  className="space-y-1 rounded-md border border-dashed p-3 opacity-60"
                >
                  <p className="flex items-center justify-between text-sm font-medium">
                    <span>{t('download.macosLabel')}</span>
                    <span className="rounded-full border px-2 py-0.5 text-xs font-normal">
                      {t('download.macosBadge')}
                    </span>
                  </p>
                  <p className="text-sm text-muted-foreground">{t('download.macosBody')}</p>
                </div>
              )}

              <div className="space-y-1 border-t pt-3">
                <p className="text-sm font-semibold">{t('windowsPrompt.title')}</p>
                <p className="text-sm text-muted-foreground">
                  {t('windowsPrompt.body', { publisher: t('windowsPrompt.publisher') })}
                </p>
              </div>
            </>
          )}
        </div>
      )}

      <div className="rounded-lg border bg-card p-4">
        <p className="text-sm font-semibold">{t('trust.title')}</p>
        <ul className="mt-2 grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
          <li>{t('trust.seeScreen')}</li>
          <li>{t('trust.temporary')}</li>
          <li>{t('trust.stopAnyTime')}</li>
          <li>{t('trust.onlyIfExpected')}</li>
        </ul>
      </div>
    </div>
  );
}
