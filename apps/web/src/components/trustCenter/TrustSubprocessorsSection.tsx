// Owner: W02f (subprocessors). One Save writes the whole list (settings rule 7); nothing here reaches the
// public page until the next publish freezes it (Ruling 20).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TRUST_SUBPROCESSORS_MAX } from '@breeze/shared';
import type { TrustSectionProps } from '@/lib/api/trustPage';
import {
  getTrustSubprocessors, getTrustSubprocessorSuggestions, putTrustSubprocessors, type TrustSubprocessorRow,
} from '@/lib/api/trustPageContent';
import { handleActionError, runAction } from '@/lib/runAction';

type Row = TrustSubprocessorRow & { key: number };

/** The server rows carry ids and timestamps; the strict PUT schema accepts only the input fields. */
const toInput = (r: TrustSubprocessorRow): TrustSubprocessorRow => ({
  name: r.name, purpose: r.purpose, location: r.location, websiteUrl: r.websiteUrl, source: r.source, sourceKey: r.sourceKey,
});

const isHttps = (v: string): boolean => {
  try { return new URL(v).protocol === 'https:'; } catch { return false; }
};

export default function TrustSubprocessorsSection({ orgId, orgFetch, state, canWrite, onReload }: TrustSectionProps) {
  const { t } = useTranslation('organizations');
  const tr = useCallback(
    (key: string, vars?: Record<string, unknown>) => t(/* i18n-dynamic */ `orgRecord.trust.subprocessors.${key}`, vars ?? {}),
    [t],
  );
  const revision = state.page.publicationRevision;
  const nextKey = useRef(0);
  const dirty = useRef(false);
  // The revision the visible list was loaded at: Save sends THIS, so a change made elsewhere meanwhile is a 409.
  const loadedRevision = useRef(revision);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [suggestions, setSuggestions] = useState<TrustSubprocessorRow[] | null>(null);
  const [suggestionsFailed, setSuggestionsFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const withKey = useCallback((r: TrustSubprocessorRow): Row => ({ ...r, key: nextKey.current++ }), []);

  // (Re)load whenever the page revision moves, unless the user has unsaved edits.
  useEffect(() => {
    if (dirty.current) return;
    let cancelled = false;
    getTrustSubprocessors(orgFetch, orgId)
      .then((d) => { if (!cancelled && !dirty.current) { setRows(d.subprocessors.map((r) => withKey(toInput(r)))); loadedRevision.current = d.publicationRevision; setLoadFailed(false); } })
      .catch((err: unknown) => { console.error('[TrustSubprocessorsSection] load failed', err); if (!cancelled) setLoadFailed(true); });
    return () => { cancelled = true; };
  }, [orgFetch, orgId, revision, withKey]);

  const edit = (fn: (prev: Row[]) => Row[]) => { dirty.current = true; setRows((prev) => fn(prev ?? [])); };
  const patch = (i: number, p: Partial<TrustSubprocessorRow>) => edit((prev) => prev.map((r, n) => (n === i ? { ...r, ...p } : r)));
  const move = (i: number, d: -1 | 1) => edit((prev) => {
    const j = i + d;
    if (j < 0 || j >= prev.length) return prev;
    const copy = [...prev];
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    return copy;
  });

  const list = rows ?? [];
  // Until the saved list has loaded, editing is blocked: a replace-all Save of a partial list would delete the saved one.
  const atLimit = rows === null || list.length >= TRUST_SUBPROCESSORS_MAX;
  const websiteInvalid = (r: Row) => r.websiteUrl !== null && r.websiteUrl.trim() !== '' && !isHttps(r.websiteUrl.trim());
  const invalid = list.some((r) => r.name.trim() === '' || r.purpose.trim() === '' || websiteInvalid(r));

  const openMenu = async () => {
    const opening = !menuOpen;
    setMenuOpen(opening);
    if (!opening) return;
    if (suggestions !== null && !suggestionsFailed) return;
    try { setSuggestions(await getTrustSubprocessorSuggestions(orgFetch, orgId)); setSuggestionsFailed(false); } catch (err) {
      // Leave `suggestions` null so the next open retries: a failure must not read as "nothing detected".
      console.error('[TrustSubprocessorsSection] suggestions failed', err);
      setSuggestionsFailed(true);
    }
  };
  const taken = new Set(list.map((r) => r.sourceKey).filter((k): k is string => !!k));
  const offered = (suggestions ?? []).filter((s) => !s.sourceKey || !taken.has(s.sourceKey));

  const save = async () => {
    if (!canWrite || invalid || busy || rows === null) return;
    setBusy(true);
    try {
      await runAction({
        request: () => putTrustSubprocessors(orgFetch, orgId, loadedRevision.current, list.map(({ key: _k, ...r }) => ({
          ...toInput(r), name: r.name.trim(), purpose: r.purpose.trim(),
          location: r.location && r.location.trim() ? r.location.trim() : null,
          websiteUrl: r.websiteUrl && r.websiteUrl.trim() ? r.websiteUrl.trim() : null,
        }))),
        successMessage: tr('saved'),
        errorFallback: tr('saveFailed'),
        friendly: (code) => ({ DUPLICATE_SOURCE_KEY: tr('duplicate') } as Record<string, string>)[code],
      });
      dirty.current = false;
      await onReload();
    } catch (err) {
      handleActionError(err, tr('saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const input = 'w-full rounded-md border bg-background px-2 py-1.5 text-sm disabled:opacity-60';
  return (
    <section className="space-y-4 rounded-lg border bg-card p-4" data-testid="trust-subprocessors-section">
      <h3 className="text-base font-semibold">{tr('title')}</h3>
      <p className="text-sm text-muted-foreground">{tr('description')}</p>
      {loadFailed && <p role="alert" className="text-sm text-destructive" data-testid="trust-subprocessors-load-error">{tr('loadFailed')}</p>}
      {rows !== null && list.length === 0 && <p className="text-sm text-muted-foreground" data-testid="trust-subprocessors-empty">{tr('empty')}</p>}

      <ul className="space-y-3">
        {list.map((r, i) => (
          <li key={r.key} className="space-y-2 rounded-md border p-3" data-testid={`trust-subprocessors-row-${i}`}>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block text-xs"><span className="font-medium">{tr('name')}</span>
                <input className={input} value={r.name} maxLength={200} disabled={!canWrite} onChange={(e) => patch(i, { name: e.target.value })} data-testid={`trust-subprocessors-name-${i}`} />
              </label>
              <label className="block text-xs"><span className="font-medium">{tr('purpose')}</span>
                <input className={input} value={r.purpose} maxLength={300} disabled={!canWrite} onChange={(e) => patch(i, { purpose: e.target.value })} data-testid={`trust-subprocessors-purpose-${i}`} />
              </label>
              <label className="block text-xs"><span className="font-medium">{tr('location')}</span>
                <input className={input} value={r.location ?? ''} maxLength={120} disabled={!canWrite} onChange={(e) => patch(i, { location: e.target.value })} data-testid={`trust-subprocessors-location-${i}`} />
              </label>
              <label className="block text-xs"><span className="font-medium">{tr('website')}</span>
                <input className={input} type="url" placeholder="https://" value={r.websiteUrl ?? ''} disabled={!canWrite} onChange={(e) => patch(i, { websiteUrl: e.target.value })} data-testid={`trust-subprocessors-website-${i}`} />
                {websiteInvalid(r) && <span className="text-xs text-destructive" data-testid={`trust-subprocessors-website-error-${i}`}>{tr('websiteInvalid')}</span>}
              </label>
            </div>
            <div className="flex gap-2 text-xs">
              <button type="button" disabled={!canWrite || i === 0} onClick={() => move(i, -1)} className="rounded-md border px-2 py-1 disabled:opacity-50" data-testid={`trust-subprocessors-up-${i}`}>{tr('moveUp')}</button>
              <button type="button" disabled={!canWrite || i === list.length - 1} onClick={() => move(i, 1)} className="rounded-md border px-2 py-1 disabled:opacity-50" data-testid={`trust-subprocessors-down-${i}`}>{tr('moveDown')}</button>
              <button type="button" disabled={!canWrite} onClick={() => edit((prev) => prev.filter((_, n) => n !== i))} className="rounded-md border px-2 py-1 text-destructive disabled:opacity-50" data-testid={`trust-subprocessors-remove-${i}`}>{tr('remove')}</button>
            </div>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-start gap-2">
        <div className="relative">
          <button type="button" disabled={!canWrite || atLimit} onClick={() => void openMenu()} className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50" data-testid="trust-subprocessors-add-detected" aria-expanded={menuOpen}>
            {tr('addDetected')}
          </button>
          {menuOpen && (
            <ul className="absolute z-10 mt-1 min-w-64 rounded-md border bg-popover p-1 shadow" data-testid="trust-subprocessors-suggestions">
              {suggestionsFailed && <li className="px-2 py-1.5 text-xs text-destructive" data-testid="trust-subprocessors-suggestions-error">{tr('suggestionsFailed')}</li>}
              {suggestions !== null && !suggestionsFailed && offered.length === 0 && <li className="px-2 py-1.5 text-xs text-muted-foreground" data-testid="trust-subprocessors-no-suggestions">{tr('noSuggestions')}</li>}
              {offered.map((s, i) => (
                <li key={s.sourceKey ?? s.name}>
                  <button
                    type="button"
                    className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                    data-testid={`trust-subprocessors-suggestion-${i}`}
                    onClick={() => { edit((prev) => [...prev, withKey(s)]); setMenuOpen(false); }}
                  >
                    {s.name} <span className="text-xs text-muted-foreground">— {s.purpose}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button type="button" disabled={!canWrite || atLimit} onClick={() => edit((prev) => [...prev, withKey({ name: '', purpose: '', location: null, websiteUrl: null, source: 'manual', sourceKey: null })])} className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50" data-testid="trust-subprocessors-add-manual">
          {tr('addManual')}
        </button>
        {rows !== null && atLimit && <span className="self-center text-xs text-muted-foreground">{tr('limit', { max: TRUST_SUBPROCESSORS_MAX })}</span>}
      </div>

      <button type="button" disabled={!canWrite || invalid || busy || rows === null} onClick={() => void save()} className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50" data-testid="trust-subprocessors-save">
        {tr('save')}
      </button>
    </section>
  );
}
