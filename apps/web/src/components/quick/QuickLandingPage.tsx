import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { formatSupportCode, normalizeSupportCode } from '@breeze/shared';
// Initializes the shared i18next singleton. This page's layout has no Sidebar
// (which is what pulls i18n in elsewhere), so without this every t() call here
// renders its raw key. It is also the only page a logged-out stranger sees.
import '@/lib/i18n';

const API_BASE = (import.meta.env.PUBLIC_API_URL || '').trim();

/**
 * The check endpoint is deliberately unauthenticated — the one-time code IS the
 * credential — so this uses a plain `fetch`, never `fetchWithAuth`: an end user
 * on this page has no Breeze account and no token.
 */
type CheckState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'valid'; code: string }
  | { phase: 'invalid' }
  | { phase: 'unreachable'; code: string };

function downloadUrl(code: string): string {
  return `${API_BASE}/api/v1/support/download/windows?code=${encodeURIComponent(code)}`;
}

export default function QuickLandingPage() {
  const { t } = useTranslation('quick');
  const [state, setState] = useState<CheckState>({ phase: 'idle' });
  const [entry, setEntry] = useState('');
  const [formatError, setFormatError] = useState(false);

  const checkCode = useCallback(async (code: string) => {
    setState({ phase: 'checking' });
    try {
      const response = await fetch(`${API_BASE}/api/v1/support/check/${encodeURIComponent(code)}`);
      const body = (await response.json()) as { valid?: boolean } | null;
      setState(
        response.ok && body?.valid === true ? { phase: 'valid', code } : { phase: 'invalid' },
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

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h2 className="text-lg font-semibold">{t('page.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('page.intro')}</p>
      </div>

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

          <a
            data-testid="quick-download-windows"
            href={downloadUrl(state.code)}
            className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
          >
            {t('download.windows')}
          </a>

          <p className="text-sm text-muted-foreground">
            {t('download.manualFallback', { code: formatSupportCode(state.code) })}
          </p>

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

          <div className="space-y-1 border-t pt-3">
            <p className="text-sm font-semibold">{t('windowsPrompt.title')}</p>
            <p className="text-sm text-muted-foreground">
              {t('windowsPrompt.body', { publisher: t('windowsPrompt.publisher') })}
            </p>
          </div>
        </div>
      )}

      <div className="space-y-2 rounded-lg border bg-card p-4">
        <p className="text-sm font-semibold">{t('trust.title')}</p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>{t('trust.seeScreen')}</li>
          <li>{t('trust.temporary')}</li>
          <li>{t('trust.stopAnyTime')}</li>
          <li>{t('trust.onlyIfExpected')}</li>
        </ul>
      </div>
    </div>
  );
}
