import { useTranslation } from 'react-i18next';
import type { AgreementRequestPreview } from '../../lib/api/agreementRequests';

const inputCls =
  'h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60';

interface Props {
  preview: AgreementRequestPreview | null;
  loading: boolean;
  /** Why the preview failed, or null. */
  error: string | null;
  values: Record<string, string>;
  onValueChange: (name: string, value: string) => void;
  onUpdate: () => void;
  busy: boolean;
}

/** Step 2 of the send dialog: the rendered agreement plus one input per
 *  variable the server still cannot resolve. `html` is sanitized server-side
 *  (same trust model as the template editor's preview pane). */
export default function SendAgreementPreview({
  preview, loading, error, values, onValueChange, onUpdate, busy,
}: Props) {
  const { t } = useTranslation('billing');
  const unresolved = preview?.unresolved ?? [];

  return (
    <div className="space-y-3">
      <h4 className="text-xs font-semibold uppercase text-muted-foreground">{t('agreements.send.preview.title')}</h4>

      {loading && !preview ? (
        <p className="text-sm text-muted-foreground">{t('agreements.send.preview.loading')}</p>
      ) : (
        <div
          className="prose prose-sm dark:prose-invert max-h-80 max-w-none overflow-y-auto rounded-md border bg-background p-3"
          data-testid="agreements-send-preview"
        >
          {preview?.sourceType === 'uploaded' ? (
            <p className="not-prose text-sm text-muted-foreground">{t('agreements.send.preview.uploaded')}</p>
          ) : preview?.html ? (
            <div dangerouslySetInnerHTML={{ __html: preview.html }} />
          ) : null}
        </div>
      )}

      {error && (
        <p className="text-sm text-destructive" data-testid="agreements-send-preview-error">
          {error}
        </p>
      )}

      {unresolved.length > 0 && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3" data-testid="agreements-send-unresolved">
          <p className="text-sm font-medium">{t('agreements.send.unresolved.title')}</p>
          {unresolved.map((name) => (
            <label key={name} className="block">
              <span className="mb-1 block text-xs text-muted-foreground">{name}</span>
              <input
                type="text"
                value={values[name] ?? ''}
                onChange={(e) => onValueChange(name, e.target.value)}
                disabled={busy}
                data-testid={`agreements-send-var-${name}`}
                className={inputCls}
              />
            </label>
          ))}
        </div>
      )}

      {(unresolved.length > 0 || error) && (
        <button
          type="button"
          onClick={onUpdate}
          disabled={busy}
          data-testid="agreements-send-update-preview"
          className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {busy ? t('agreements.send.updating') : t('agreements.send.updatePreview')}
        </button>
      )}
    </div>
  );
}
