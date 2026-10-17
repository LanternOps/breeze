// Owner: W02f (FAQ). One Save writes the whole list (settings rule 7). The answer is edited in the flow
// rich-text subset; the API sanitizes it again and the payload builder a third time.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TRUST_FAQ_MAX } from '@breeze/shared';
import RichTextEditor from '@/components/common/RichTextEditor';
import type { TrustSectionProps } from '@/lib/api/trustPage';
import { getTrustFaq, putTrustFaq, type TrustFaqRow } from '@/lib/api/trustPageContent';
import { handleActionError, runAction } from '@/lib/runAction';

type Row = TrustFaqRow & { key: number };
const QUESTION_MIN = 5;
const ANSWER_RAW_MAX = 2000;

export default function TrustFaqSection({ orgId, orgFetch, state, canWrite, onReload }: TrustSectionProps) {
  const { t } = useTranslation('organizations');
  const tr = useCallback(
    (key: string, vars?: Record<string, unknown>) => t(/* i18n-dynamic */ `orgRecord.trust.faq.${key}`, vars ?? {}),
    [t],
  );
  const revision = state.page.publicationRevision;
  const nextKey = useRef(0);
  const dirty = useRef(false);
  // The revision the visible list was loaded at: Save sends THIS, so a change made elsewhere meanwhile is a 409.
  const loadedRevision = useRef(revision);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const withKey = useCallback((r: TrustFaqRow): Row => ({ ...r, key: nextKey.current++ }), []);

  // (Re)load whenever the page revision moves, unless the user has unsaved edits.
  useEffect(() => {
    if (dirty.current) return;
    let cancelled = false;
    getTrustFaq(orgFetch, orgId)
      .then((d) => { if (!cancelled && !dirty.current) { setRows(d.items.map((i) => withKey({ question: i.question, answerHtml: i.answerHtml }))); loadedRevision.current = d.publicationRevision; setLoadFailed(false); } })
      .catch((err: unknown) => { console.error('[TrustFaqSection] load failed', err); if (!cancelled) setLoadFailed(true); });
    return () => { cancelled = true; };
  }, [orgFetch, orgId, revision, withKey]);

  const edit = (fn: (prev: Row[]) => Row[]) => { dirty.current = true; setRows((prev) => fn(prev ?? [])); };
  const patch = (i: number, p: Partial<TrustFaqRow>) => edit((prev) => prev.map((r, n) => (n === i ? { ...r, ...p } : r)));
  const move = (i: number, d: -1 | 1) => edit((prev) => {
    const j = i + d;
    if (j < 0 || j >= prev.length) return prev;
    const copy = [...prev];
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    return copy;
  });

  const list = rows ?? [];
  const questionInvalid = (r: Row) => r.question.trim().length < QUESTION_MIN;
  const answerTooLong = (r: Row) => r.answerHtml.length > ANSWER_RAW_MAX;
  const invalid = list.some((r) => questionInvalid(r) || answerTooLong(r));

  const save = async () => {
    if (!canWrite || invalid || busy || rows === null) return;
    setBusy(true);
    try {
      await runAction({
        request: () => putTrustFaq(orgFetch, orgId, loadedRevision.current, list.map((r) => ({ question: r.question.trim(), answerHtml: r.answerHtml }))),
        successMessage: tr('saved'),
        errorFallback: tr('saveFailed'),
        friendly: (code) => ({ ANSWER_TOO_LONG: tr('answerTooLong') } as Record<string, string>)[code],
      });
      dirty.current = false;
      await onReload();
    } catch (err) {
      handleActionError(err, tr('saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4 rounded-lg border bg-card p-4" data-testid="trust-faq-section">
      <h3 className="text-base font-semibold">{tr('title')}</h3>
      <p className="text-sm text-muted-foreground">{tr('description')}</p>
      {loadFailed && <p role="alert" className="text-sm text-destructive" data-testid="trust-faq-load-error">{tr('loadFailed')}</p>}
      {rows !== null && list.length === 0 && <p className="text-sm text-muted-foreground" data-testid="trust-faq-empty">{tr('empty')}</p>}

      <ul className="space-y-3">
        {list.map((r, i) => (
          <li key={r.key} className="space-y-2 rounded-md border p-3" data-testid={`trust-faq-row-${i}`}>
            <label className="block text-xs"><span className="font-medium">{tr('question')}</span>
              <input
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm disabled:opacity-60"
                value={r.question}
                maxLength={300}
                disabled={!canWrite}
                onChange={(e) => patch(i, { question: e.target.value })}
                data-testid={`trust-faq-question-${i}`}
              />
              {r.question !== '' && questionInvalid(r) && <span className="text-xs text-destructive">{tr('questionShort', { min: QUESTION_MIN })}</span>}
            </label>
            <div className={canWrite ? '' : 'opacity-60'} aria-disabled={!canWrite} inert={!canWrite}>
              <div className="mb-1 text-xs font-medium">{tr('answer')}</div>
              <RichTextEditor value={r.answerHtml} onChange={(html) => patch(i, { answerHtml: html })} ariaLabel={tr('answer')} testId={`trust-faq-answer-${i}`} />
              {answerTooLong(r) && <p className="mt-1 text-xs text-destructive" data-testid={`trust-faq-answer-error-${i}`}>{tr('answerTooLong')}</p>}
            </div>
            <div className="flex gap-2 text-xs">
              <button type="button" disabled={!canWrite || i === 0} onClick={() => move(i, -1)} className="rounded-md border px-2 py-1 disabled:opacity-50" data-testid={`trust-faq-up-${i}`}>{tr('moveUp')}</button>
              <button type="button" disabled={!canWrite || i === list.length - 1} onClick={() => move(i, 1)} className="rounded-md border px-2 py-1 disabled:opacity-50" data-testid={`trust-faq-down-${i}`}>{tr('moveDown')}</button>
              <button type="button" disabled={!canWrite} onClick={() => edit((prev) => prev.filter((_, n) => n !== i))} className="rounded-md border px-2 py-1 text-destructive disabled:opacity-50" data-testid={`trust-faq-remove-${i}`}>{tr('remove')}</button>
            </div>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={!canWrite || rows === null || list.length >= TRUST_FAQ_MAX} onClick={() => edit((prev) => [...prev, withKey({ question: '', answerHtml: '' })])} className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50" data-testid="trust-faq-add">
          {tr('add')}
        </button>
        {list.length >= TRUST_FAQ_MAX && <span className="text-xs text-muted-foreground">{tr('limit', { max: TRUST_FAQ_MAX })}</span>}
        <button type="button" disabled={!canWrite || invalid || busy || rows === null} onClick={() => void save()} className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50" data-testid="trust-faq-save">
          {tr('save')}
        </button>
      </div>
    </section>
  );
}
