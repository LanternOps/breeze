import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../../lib/i18n';
import { navigateTo } from '@/lib/navigation';
import { runAction } from '../../../lib/runAction';
import { showToast } from '../../shared/Toast';
import {
  downloadQuoteAcceptanceEvidence,
  uploadQuoteAcceptanceEvidence,
  QUOTE_ACCEPTANCE_EVIDENCE_MAX_BYTES,
} from '../../../lib/api/quotes';
import type { QuoteAcceptance } from './quoteTypes';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

/** Accepted extensions/MIME list — kept in one place so the file-picker filter
 *  and the client-side type check (implicitly enforced by the OS picker) match
 *  the API's own allowlist (PDF, PNG, JPEG). */
const EVIDENCE_ACCEPT = 'application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg';

interface Props {
  quoteId: string;
  evidence: QuoteAcceptance['evidence'];
  /** Whether the current user may attach/replace evidence (quotes:accept). */
  canAttach: boolean;
  /** Called after a successful attach so the parent can reload the quote. */
  onChanged?: () => void;
}

/** Download-or-attach control for the evidence file behind an on-behalf
 *  acceptance (#6633). Renders next to the acceptance provenance line: a
 *  download button when a file is on record, an attach/replace button when the
 *  viewer holds quotes:accept, and nothing at all when neither applies. */
export default function AcceptanceEvidenceControl({ quoteId, evidence, canAttach, onChanged }: Props) {
  const { t } = useTranslation('billing');
  const [downloading, setDownloading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const download = useCallback(async () => {
    if (downloading || !evidence) return;
    setDownloading(true);
    try {
      const res = await downloadQuoteAcceptanceEvidence(quoteId);
      if (res.status === 401) {
        UNAUTHORIZED();
        return;
      }
      if (!res.ok) {
        showToast({ type: 'error', message: t('quotes.detail.evidence.downloadError') });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = evidence.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      showToast({ type: 'error', message: t('quotes.detail.evidence.downloadError') });
    } finally {
      setDownloading(false);
    }
  }, [downloading, evidence, quoteId, t]);

  const pickFile = useCallback(() => {
    if (uploading) return;
    inputRef.current?.click();
  }, [uploading]);

  const onFileChosen = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    // Reset so re-picking the same file fires onChange again.
    e.target.value = '';
    if (!file) return;
    if (file.size > QUOTE_ACCEPTANCE_EVIDENCE_MAX_BYTES) {
      showToast({ type: 'error', message: t('quotes.detail.evidence.tooLarge') });
      return;
    }
    setUploading(true);
    try {
      await runAction({
        request: () => uploadQuoteAcceptanceEvidence(quoteId, file),
        errorFallback: t('quotes.detail.evidence.attachError'),
        successMessage: t('quotes.detail.evidence.attached'),
        onUnauthorized: UNAUTHORIZED,
      });
      onChanged?.();
    } catch {
      // runAction already toasted; nothing further to do here.
    } finally {
      setUploading(false);
    }
  }, [quoteId, t, onChanged]);

  if (!evidence && !canAttach) return null;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      {evidence && (
        <button
          type="button"
          onClick={() => void download()}
          disabled={downloading}
          data-testid="quote-acceptance-evidence-download"
          title={t('quotes.detail.evidence.downloadTitle', { filename: evidence.filename })}
          className="text-xs font-medium text-primary underline-offset-2 hover:underline disabled:opacity-60"
        >
          {t('quotes.detail.evidence.download')} — {evidence.filename}
        </button>
      )}
      {canAttach && (
        <>
          <button
            type="button"
            onClick={pickFile}
            disabled={uploading}
            data-testid="quote-acceptance-evidence-attach"
            className="text-xs font-medium text-muted-foreground underline-offset-2 hover:underline disabled:opacity-60"
          >
            {evidence ? t('quotes.detail.evidence.replace') : t('quotes.detail.evidence.attach')}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept={EVIDENCE_ACCEPT}
            onChange={(e) => void onFileChosen(e)}
            data-testid="quote-acceptance-evidence-input"
            className="hidden"
          />
        </>
      )}
    </div>
  );
}
