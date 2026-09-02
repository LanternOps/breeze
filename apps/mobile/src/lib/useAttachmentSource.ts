import { useEffect, useState } from 'react';

import { getAuthImageHeaders } from '../services/api';
import { attachmentContentUrl } from '../services/ticketAttachments';

export interface AttachmentSource {
  uri: string;
  headers: Record<string, string>;
}

/**
 * Resolve an `<Image source={{ uri, headers }}>` for an attachment.
 *
 * Both halves are async — the base URL comes from stored server config and the
 * bearer token from SecureStore — so this cannot be computed inline in render.
 * Returns null until both are known; callers render a placeholder meanwhile.
 *
 * The header is not optional decoration: `GET /tickets/:id/attachments/:aid/content`
 * is an authenticated route (never a presigned URL), so a bare `uri` 401s and
 * `expo-image` shows an empty box with no error.
 */
export function useAttachmentSource(
  ticketId: string,
  attachmentId: string
): AttachmentSource | null {
  const [source, setSource] = useState<AttachmentSource | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [uri, headers] = await Promise.all([
          attachmentContentUrl(ticketId, attachmentId),
          getAuthImageHeaders(),
        ]);
        // An unmount (or a scrolled-away row) must not write state, and a stale
        // pair must not overwrite a newer one.
        if (active) setSource({ uri, headers });
      } catch {
        // Defensive only: neither `attachmentContentUrl` (which falls back to
        // the bundled base URL) nor `getAuthImageHeaders` throws today, so this
        // should be unreachable. It stays because both read from storage and a
        // future change could make them throw — and leaving the placeholder up
        // is the right answer either way.
        //
        // NOTE: this does NOT cover a failed byte fetch. Resolving the URL says
        // nothing about whether the image loads; that failure surfaces through
        // the `onError` prop on the consuming `<Image>`, which is where the
        // retry affordance lives.
      }
    })();
    return () => {
      active = false;
    };
  }, [ticketId, attachmentId]);

  return source;
}
