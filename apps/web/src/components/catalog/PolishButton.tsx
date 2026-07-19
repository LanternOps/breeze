import { useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { Dialog } from '../shared/Dialog';
import { polishTextRequest, type PolishResult } from '../../lib/api/catalog';
import { useTranslation } from 'react-i18next';

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

export interface PolishApplyResult {
  name: string | null;
  description: string | null;
}

interface PolishButtonProps {
  /** Read the current (possibly unsaved) field values when the button is clicked.
   *  Return only the fields you want polished — omit a field to leave it untouched. */
  getText: () => { name?: string | null; description?: string | null };
  /** Called with the polished values after the user approves the preview. The
   *  host applies whichever fields it owns. */
  onApply: (result: PolishApplyResult) => void;
  /** Disambiguates data-testids when multiple instances mount on one page. */
  idSuffix: string;
  disabled?: boolean;
  /** Override the button label. Default: "Tidy description". */
  label?: string;
  /** Render a smaller, condensed button (for inline use in line editors). */
  compact?: boolean;
}

interface Preview {
  beforeName: string | null;
  afterName: string | null;
  beforeDescription: string | null;
  afterDescription: string | null;
  // Advisory fact-guard warning: the polish may have changed/dropped a number,
  // unit, or code. The result is still shown (the guard is a reviewer aid, not a
  // gate). Non-null drives a "double-check the details" banner in the preview;
  // its presence IS the warning (no separate flag to keep in sync).
  factChanges: PolishResult['factChanges'];
}

function FieldDiff({
  label, before, after, idSuffix, field,
}: {
  label: string;
  before: string | null;
  after: string | null;
  idSuffix: string;
  field: 'name' | 'description';
}) {
  const { t } = useTranslation('common');
  const unchanged = (before ?? '') === (after ?? '');
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {unchanged && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{t('longTail.catalog.PolishButton.noChange')}</span>}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div
          className="rounded-md border bg-muted/40 p-2 text-sm whitespace-pre-wrap break-words text-muted-foreground"
          data-testid={`polish-before-${field}-${idSuffix}`}
        >
          {before || <span className="italic opacity-60">{t('longTail.catalog.PolishButton.empty')}</span>}
        </div>
        <div
          className={`rounded-md border p-2 text-sm whitespace-pre-wrap break-words ${
            unchanged ? 'text-muted-foreground' : 'border-primary/40 bg-primary/5 text-foreground'
          }`}
          data-testid={`polish-after-${field}-${idSuffix}`}
        >
          {after || <span className="italic opacity-60">{t('longTail.catalog.PolishButton.empty')}</span>}
        </div>
      </div>
    </div>
  );
}

export default function PolishButton({
  getText, onApply, idSuffix, disabled, label, compact,
}: PolishButtonProps) {
  const { t } = useTranslation('common');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const headingId = useId();

  const run = async () => {
    if (busy) return;
    const input = getText();
    const name = input.name?.trim() ? input.name : undefined;
    const description = input.description?.trim() ? input.description : undefined;
    if (!name && !description) {
      showToast({ message: t('longTail.catalog.PolishButton.errors.enterText'), type: 'error' });
      return;
    }
    setBusy(true);
    try {
      const result = await runAction<PolishResult>({
        request: () => polishTextRequest({ name, description }),
        // A fact drift is no longer an error — it comes back as a normal result
        // with a non-null factChanges and a warning banner. Genuine failures still
        // error: AI_PARSE 502 / rate-limit carry a server message runAction
        // surfaces verbatim; this fallback string shows only on a transport
        // failure or an unparseable success body.
        errorFallback: t('longTail.catalog.PolishButton.errors.polishFailed'),
        parseSuccess: (data) => (data as { data: PolishResult }).data,
        onUnauthorized: UNAUTHORIZED,
      });
      // Server-side `changed` plus a client-side visual check: if what the user
      // would SEE in the preview is identical after whitespace normalization
      // (e.g. the only difference is a trailing newline), a before/after dialog
      // of two identical blocks is worse than useless — toast instead. A fact
      // warning always opens the preview, though: the user must be told to review
      // even if the visible diff looks small.
      const trimEq = (a: string | null | undefined, b: string | null | undefined) =>
        (a ?? '').trim() === (b ?? '').trim();
      const nameVisiblySame = result.name === null || trimEq(result.name, name);
      const descVisiblySame = result.description === null || trimEq(result.description, description);
      if (!result.factChanges && (!result.changed || (nameVisiblySame && descVisiblySame))) {
        showToast({ message: t('longTail.catalog.PolishButton.messages.noChanges'), type: 'success' });
        return;
      }
      setPreview({
        beforeName: name ?? null,
        afterName: result.name,
        beforeDescription: description ?? null,
        afterDescription: result.description,
        factChanges: result.factChanges,
      });
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) {
        showToast({ message: t('longTail.catalog.PolishButton.errors.polishFailed'), type: 'error' });
      }
    } finally {
      setBusy(false);
    }
  };

  const apply = () => {
    if (!preview) return;
    onApply({ name: preview.afterName, description: preview.afterDescription });
    setPreview(null);
    showToast({ message: t('longTail.catalog.PolishButton.messages.applied'), type: 'success' });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void run()}
        disabled={disabled || busy}
        aria-busy={busy}
        data-testid={`polish-btn-${idSuffix}`}
        title={t('longTail.catalog.PolishButton.title')}
        className={
          compact
            ? 'inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-medium hover:bg-muted disabled:opacity-50'
            : 'inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50'
        }
      >
        {busy && <Loader2 className={`animate-spin ${compact ? 'h-3 w-3' : 'h-3.5 w-3.5'}`} aria-hidden="true" />}
        {busy ? t('longTail.catalog.PolishButton.polishing') : (label ?? t('longTail.catalog.PolishButton.defaultLabel'))}
      </button>

      <Dialog
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={t('longTail.catalog.PolishButton.preview.dialogTitle')}
        labelledBy={headingId}
        maxWidth="2xl"
        className="flex max-h-[85vh] flex-col"
      >
        {preview && (
          <>
            <div className="border-b px-5 py-4">
              <h2 id={headingId} className="text-base font-semibold">{t('longTail.catalog.PolishButton.preview.title')}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t('longTail.catalog.PolishButton.preview.description')}
              </p>
            </div>
            <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
              {preview.factChanges && (
                <div
                  role="alert"
                  data-testid={`polish-fact-warning-${idSuffix}`}
                  className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-900 dark:text-amber-200"
                >
                  <p className="font-medium">{t('longTail.catalog.PolishButton.preview.warningTitle')}</p>
                  <p className="mt-0.5 text-xs">
                    {t('longTail.catalog.PolishButton.preview.warningDescription')}
                  </p>
                  {(preview.factChanges.added.length > 0 || preview.factChanges.removed.length > 0) && (
                    <div className="mt-2 flex flex-col gap-1.5 text-xs">
                      {([
                        { tokens: preview.factChanges.added, label: t('longTail.catalog.PolishButton.preview.addedLabel'), k: 'a', chip: 'bg-amber-500/20' },
                        { tokens: preview.factChanges.removed, label: t('longTail.catalog.PolishButton.preview.removedLabel'), k: 'r', chip: 'bg-amber-500/10 line-through opacity-80' },
                      ] as const).map(({ tokens, label, k, chip }) => tokens.length > 0 && (
                        <div key={k} className="flex flex-wrap items-center gap-1">
                          <span className="font-medium">{label}</span>
                          {tokens.map((t, i) => (
                            <code key={`${k}-${i}`} className={`rounded px-1 py-0.5 ${chip}`}>{t}</code>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {preview.beforeName !== null && (
                <FieldDiff
                  label={t('common:labels.name')} field="name" idSuffix={idSuffix}
                  before={preview.beforeName} after={preview.afterName}
                />
              )}
              {preview.beforeDescription !== null && (
                <FieldDiff
                  label={t('common:labels.description')} field="description" idSuffix={idSuffix}
                  before={preview.beforeDescription} after={preview.afterDescription}
                />
              )}
            </div>
            <div className="flex justify-end gap-2 border-t px-5 py-4">
              <button
                type="button"
                onClick={() => setPreview(null)}
                data-testid={`polish-cancel-${idSuffix}`}
                className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted"
              >
                {t('common:actions.cancel')}
              </button>
              <button
                type="button"
                onClick={apply}
                data-testid={`polish-apply-${idSuffix}`}
                className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                {t('longTail.catalog.PolishButton.actions.applyChanges')}
              </button>
            </div>
          </>
        )}
      </Dialog>
    </>
  );
}
