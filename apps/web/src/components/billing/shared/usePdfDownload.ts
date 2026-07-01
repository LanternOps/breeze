import { useCallback, useState } from 'react';
import { fetchWithAuth } from '../../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { handleActionError } from '../../../lib/runAction';

export interface UsePdfDownloadOptions {
  /** API path passed straight to `fetchWithAuth` (it attaches the auth header and
   *  prepends `/api/v1`). Accepts both bare (`/invoices/:id/pdf`) and already
   *  `/api/v1`-prefixed paths. */
  path: string;
  /** The saved filename, e.g. `INV-2026-0001.pdf`. */
  filename: string;
  /** Toast copy on failure — domain-specific so quotes/invoices read naturally. */
  errorMessage?: string;
}

export interface UsePdfDownload {
  download: () => Promise<void>;
  downloading: boolean;
}

/**
 * Download an access-controlled PDF: authed fetch → blob → object URL → anchor
 * click → revoke. A bare `<a href>`/`<a download>` would 401 (no Bearer header),
 * so we fetch the bytes ourselves. One implementation for every billing surface
 * (quote header + preview, invoice detail + preview) so they can't drift in URL,
 * filename, 401 handling, or error copy. `downloading` guards double-submit and
 * drives the button's disabled/label state.
 */
export function usePdfDownload({ path, filename, errorMessage = 'Could not download the PDF.' }: UsePdfDownloadOptions): UsePdfDownload {
  const [downloading, setDownloading] = useState(false);

  const download = useCallback(async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const res = await fetchWithAuth(path);
      if (res.status === 401) { void navigateTo('/login', { replace: true }); return; }
      if (!res.ok) { handleActionError(new Error('pdf'), errorMessage); return; }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      handleActionError(err, errorMessage);
    } finally {
      setDownloading(false);
    }
  }, [downloading, path, filename, errorMessage]);

  return { download, downloading };
}
