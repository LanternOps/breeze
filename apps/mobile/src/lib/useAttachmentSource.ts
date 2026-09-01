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
        // Leave the placeholder in place — a thumbnail that cannot resolve its
        // URL is not worth a toast, and the tap path reports its own failures.
      }
    })();
    return () => {
      active = false;
    };
  }, [ticketId, attachmentId]);

  return source;
}
