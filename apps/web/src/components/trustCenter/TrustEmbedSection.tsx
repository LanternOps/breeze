// Owner: W03a (Trust Center embed, #8771). "Embed on your website": the per-page iframe allowlist and the snippet.
// The allowlist is LIVE (W3 plan Open Decision 4): saving it takes effect on the next load of the embed, with no
// republish, so it carries no page revision. The PUT is MFA-gated; it goes through runAction (listed in
// no-silent-mutations TARGET_GLOBS). Origins are normalized with the same shared helper the API and portal use.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { normalizeEmbedOrigin, TRUST_EMBED_ORIGINS_MAX } from '@breeze/shared';
import { showToast } from '@/components/shared/Toast';
import { ActionError, handleActionError, runAction } from '@/lib/runAction';
import { trustPublicUrl, updateTrustEmbedOrigins, type TrustSectionProps } from '@/lib/api/trustPage';
import { escapeHtmlAttr } from './TrustBadgeSnippet';

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

export default function TrustEmbedSection({ orgId, orgFetch, state, canWrite }: TrustSectionProps) {
  const { t } = useTranslation('organizations');
  const tr = useCallback(
    (key: string, vars?: Record<string, unknown>) => t(/* i18n-dynamic */ `orgRecord.trust.embed.${key}`, vars ?? {}),
    [t],
  );
  const loaded = state.page.embedAllowedOrigins ?? [];
  const [saved, setSaved] = useState<string[]>(loaded);
  const [draft, setDraft] = useState<string[]>(loaded);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const loadedKey = loaded.join(' ');
  useEffect(() => {
    // A reload of the tab (another section's save) re-reads the page: adopt the server's list, but keep an
    // unsaved edit in progress.
    const fresh = loadedKey ? loadedKey.split(' ') : [];
    setDraft((d) => (sameList(d, savedRef.current) ? fresh : d));
    setSaved(fresh);
  }, [loadedKey]);

  const pending = input.trim();
  const candidate = pending ? normalizeEmbedOrigin(pending) : null;
  const inputError = !pending ? null
    : candidate === null ? tr('invalidOrigin')
    : draft.includes(candidate) ? tr('duplicateOrigin')
    : draft.length >= TRUST_EMBED_ORIGINS_MAX ? tr('maxReached', { max: TRUST_EMBED_ORIGINS_MAX })
    : null;
  const dirty = !sameList(draft, saved);
  const canSave = canWrite && !busy && dirty && inputError === null;

  const add = () => {
    if (!canWrite || !candidate || inputError) return;
    setDraft((d) => [...d, candidate]);
    setInput('');
  };
  const remove = (origin: string) => {
    if (!canWrite) return;
    setDraft((d) => d.filter((o) => o !== origin));
  };
  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    try {
      const stored = await runAction({
        request: () => updateTrustEmbedOrigins(orgFetch, orgId, draft),
        parseSuccess: (d) => (d as { data: { embedAllowedOrigins: string[] } }).data.embedAllowedOrigins,
        successMessage: tr('saved'),
        errorFallback: tr('saveFailed'),
        friendly: (code) => ({ MFA_REQUIRED: tr('mfaRequired') } as Record<string, string>)[code],
      });
      setSaved(stored);
      setDraft(stored);
    } catch (err) {
      // runAction already toasted an ActionError; anything else (e.g. a malformed 200 body) gets the fallback toast
      // here, so keep the real error for debugging.
      if (!(err instanceof ActionError)) console.error('[TrustEmbedSection] save failed', err);
      handleActionError(err, tr('saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const snippet = useMemo(
    () => `<iframe src="${escapeHtmlAttr(trustPublicUrl(state.embedPath))}" title="${escapeHtmlAttr(tr('frameTitle'))}" width="100%" height="160" loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe>`,
    [state.embedPath, tr],
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      showToast({ type: 'success', message: tr('copied') });
    } catch (err) {
      console.error('[TrustEmbedSection] clipboard write failed', err);
      showToast({ type: 'error', message: tr('copyFailed') });
    }
  };

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4" data-testid="trust-embed-section">
      <div>
        <h3 className="text-sm font-semibold">{tr('title')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{tr('description')}</p>
        <p className="mt-1 text-xs text-muted-foreground">{tr('liveNote')}</p>
        {!state.page.publishedAt && <p className="mt-1 text-xs text-muted-foreground" data-testid="trust-embed-unpublished">{tr('unpublishedNote')}</p>}
      </div>

      {draft.length > 0 && (
        <ul className="space-y-1" data-testid="trust-embed-origins">
          {draft.map((origin, i) => (
            <li key={origin} className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm">
              <span className="truncate font-mono text-xs" data-testid={`trust-embed-origin-${i}`}>{origin}</span>
              <button
                type="button"
                onClick={() => remove(origin)}
                disabled={!canWrite || busy}
                className="rounded-md border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50"
                data-testid={`trust-embed-remove-${i}`}
              >
                {tr('remove')}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div>
        <label className="block text-xs font-medium text-muted-foreground" htmlFor="trust-embed-origin-input">{tr('originLabel')}</label>
        <div className="mt-1 flex gap-2">
          <input
            id="trust-embed-origin-input"
            type="url"
            inputMode="url"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
            disabled={!canWrite || busy}
            placeholder="https://www.example.com"
            aria-invalid={inputError !== null}
            aria-describedby={inputError ? 'trust-embed-origin-error' : undefined}
            className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            data-testid="trust-embed-origin-input"
          />
          <button
            type="button"
            onClick={add}
            disabled={!canWrite || busy || !candidate || inputError !== null}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
            data-testid="trust-embed-add"
          >
            {tr('add')}
          </button>
        </div>
        {inputError && <p id="trust-embed-origin-error" className="mt-1 text-xs text-destructive" role="alert" data-testid="trust-embed-origin-error">{inputError}</p>}
        {!inputError && candidate && (
          <p className="mt-1 text-xs text-muted-foreground">{tr('preview')} <span className="font-mono" data-testid="trust-embed-origin-preview">{candidate}</span></p>
        )}
      </div>

      <button
        type="button"
        onClick={() => void save()}
        disabled={!canSave}
        className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        data-testid="trust-embed-save"
      >
        {tr('save')}
      </button>

      {saved.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="trust-embed-empty">{tr('emptyNote')}</p>
      ) : (
        <div>
          <label className="block text-xs font-medium text-muted-foreground" htmlFor="trust-embed-snippet">{tr('snippetLabel')}</label>
          <textarea
            id="trust-embed-snippet"
            readOnly
            rows={3}
            value={snippet}
            className="mt-1 w-full rounded-md border bg-background p-2 font-mono text-xs"
            data-testid="trust-embed-snippet"
          />
          <button
            type="button"
            onClick={() => void copy()}
            className="mt-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            data-testid="trust-embed-copy"
          >
            {tr('copy')}
          </button>
        </div>
      )}
    </section>
  );
}
