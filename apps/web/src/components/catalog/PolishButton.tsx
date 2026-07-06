import { useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { Dialog } from '../shared/Dialog';
import { polishTextRequest, type PolishResult } from '../../lib/api/catalog';

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
  /** Override the button label. Default: "✨ Polish with AI". */
  label?: string;
  /** Render a smaller, condensed button (for inline use in line editors). */
  compact?: boolean;
}

interface Preview {
  beforeName: string | null;
  afterName: string | null;
  beforeDescription: string | null;
  afterDescription: string | null;
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
  const unchanged = (before ?? '') === (after ?? '');
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {unchanged && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">No change</span>}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div
          className="rounded-md border bg-muted/40 p-2 text-sm whitespace-pre-wrap break-words text-muted-foreground"
          data-testid={`polish-before-${field}-${idSuffix}`}
        >
          {before || <span className="italic opacity-60">empty</span>}
        </div>
        <div
          className={`rounded-md border p-2 text-sm whitespace-pre-wrap break-words ${
            unchanged ? 'text-muted-foreground' : 'border-primary/40 bg-primary/5 text-foreground'
          }`}
          data-testid={`polish-after-${field}-${idSuffix}`}
        >
          {after || <span className="italic opacity-60">empty</span>}
        </div>
      </div>
    </div>
  );
}

export default function PolishButton({
  getText, onApply, idSuffix, disabled, label, compact,
}: PolishButtonProps) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const headingId = useId();

  const run = async () => {
    if (busy) return;
    const input = getText();
    const name = input.name?.trim() ? input.name : undefined;
    const description = input.description?.trim() ? input.description : undefined;
    if (!name && !description) {
      showToast({ message: 'Enter a name or description to polish first.', type: 'error' });
      return;
    }
    setBusy(true);
    try {
      const result = await runAction<PolishResult>({
        request: () => polishTextRequest({ name, description }),
        // The fact-guard 502 (AI_FACT_DRIFT) carries a user-friendly message that
        // runAction surfaces verbatim, so the user learns nothing changed.
        errorFallback: "Couldn't polish that — try editing it manually.",
        parseSuccess: (data) => (data as { data: PolishResult }).data,
        onUnauthorized: UNAUTHORIZED,
      });
      if (!result.changed) {
        showToast({ message: 'Already looks good — no changes suggested.', type: 'success' });
        return;
      }
      setPreview({
        beforeName: name ?? null,
        afterName: result.name,
        beforeDescription: description ?? null,
        afterDescription: result.description,
      });
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) {
        showToast({ message: "Couldn't polish that — try editing it manually.", type: 'error' });
      }
    } finally {
      setBusy(false);
    }
  };

  const apply = () => {
    if (!preview) return;
    onApply({ name: preview.afterName, description: preview.afterDescription });
    setPreview(null);
    showToast({ message: 'Polished text applied.', type: 'success' });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void run()}
        disabled={disabled || busy}
        aria-busy={busy}
        data-testid={`polish-btn-${idSuffix}`}
        title="Clean up the wording with AI — your numbers and specs stay; review the preview before applying"
        className={
          compact
            ? 'inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-medium hover:bg-muted disabled:opacity-50'
            : 'inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50'
        }
      >
        {busy && <Loader2 className={`animate-spin ${compact ? 'h-3 w-3' : 'h-3.5 w-3.5'}`} aria-hidden="true" />}
        {busy ? 'Polishing…' : (label ?? '✨ Polish with AI')}
      </button>

      <Dialog
        open={preview !== null}
        onClose={() => setPreview(null)}
        title="Polish preview"
        labelledBy={headingId}
        maxWidth="2xl"
        className="flex max-h-[85vh] flex-col"
      >
        {preview && (
          <>
            <div className="border-b px-5 py-4">
              <h2 id={headingId} className="text-base font-semibold">Review polished text</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                This cleans up wording and formatting. Your numbers, measurements, and
                prices are kept as entered — review the before/after below before applying.
              </p>
            </div>
            <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
              {preview.beforeName !== null && (
                <FieldDiff
                  label="Name" field="name" idSuffix={idSuffix}
                  before={preview.beforeName} after={preview.afterName}
                />
              )}
              {preview.beforeDescription !== null && (
                <FieldDiff
                  label="Description" field="description" idSuffix={idSuffix}
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
                Cancel
              </button>
              <button
                type="button"
                onClick={apply}
                data-testid={`polish-apply-${idSuffix}`}
                className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                Apply changes
              </button>
            </div>
          </>
        )}
      </Dialog>
    </>
  );
}
