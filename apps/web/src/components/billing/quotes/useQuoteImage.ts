import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { handleActionError } from '../../../lib/runAction';
import { quotePdfUrl } from '../../../lib/api/quotes';

/**
 * Fetch an access-controlled image (a quote image, a catalog thumbnail) that
 * requires the Bearer header — a bare `<img src>` would 401 — and expose it as a
 * blob object URL, revoked on unmount/change. Shared by the internal detail view
 * and the customer document so the two can't drift in how they load or fail. (The
 * editor's own thumbnail/preview still use inline loaders and aren't on this hook.)
 *
 * Returns `{ url, failed }`: `url` is undefined while loading, `failed` flips true
 * on a non-OK response or a network error. Pass `path = null` to render nothing
 * (the hook stays stable; callers decide what an absent image looks like).
 */
export function useAuthedImage(path: string | null): { url?: string; failed: boolean } {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setUrl(undefined);
    setFailed(false);
    if (!path) return;
    let objectUrl: string | undefined;
    let active = true;
    void (async () => {
      try {
        const res = await fetchWithAuth(path);
        if (!res.ok) { if (active) setFailed(true); return; }
        const blob = await res.blob();
        if (!active) return;
        objectUrl = window.URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch (err) {
        // Keep the developer breadcrumb the inline loaders had — the user sees the
        // "image unavailable" fallback, but a silent catch hides why an authed
        // image failed across the surfaces that now share this hook.
        console.error('[useAuthedImage] image load failed', path, err instanceof Error ? err.message : err);
        if (active) setFailed(true);
      }
    })();
    return () => { active = false; if (objectUrl) window.URL.revokeObjectURL(objectUrl); };
  }, [path]);

  return { url, failed };
}

/**
 * Download a quote's PDF (authed bytes → blob → anchor click). One implementation
 * for both the workspace header action and the customer-preview button, so the
 * two can't drift in URL, filename, or error handling. Returns `{ busy, downloadPdf }`;
 * `busy` guards against double-submit and drives the button's disabled/label state.
 */
export function useQuotePdfDownload(quote: { id: string; quoteNumber: string | null }) {
  const [busy, setBusy] = useState(false);
  const downloadPdf = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetchWithAuth(quotePdfUrl(quote.id));
      if (res.status === 401) { void navigateTo('/login', { replace: true }); return; }
      if (!res.ok) { handleActionError(new Error('pdf'), 'Could not download the quote PDF.'); return; }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${quote.quoteNumber ?? `quote-${quote.id}`}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      handleActionError(err, 'Could not download the quote PDF.');
    } finally {
      setBusy(false);
    }
  }, [busy, quote.id, quote.quoteNumber]);
  return { busy, downloadPdf };
}
