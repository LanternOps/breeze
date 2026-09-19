import type { MouseEvent } from 'react';
import { fetchWithAuth, handleSessionExpired } from '@/stores/auth';
import { showToast } from '@/components/shared/Toast';
import { downloadBlob } from './downloadBlob';
import { i18n } from './i18n';

/** Carries the HTTP status through to the `catch` so it can pick the right toast. */
class ArtifactDownloadError extends Error {
  constructor(public readonly status: number) {
    super(`Artifact download failed (${status})`);
  }
}

/** Artifact routes require a bearer token; a plain anchor cannot supply it. */
export async function downloadArtifact(event: MouseEvent<HTMLAnchorElement>): Promise<void> {
  event.preventDefault();
  const path = event.currentTarget.getAttribute('href');
  const fallbackName = event.currentTarget.getAttribute('download') || 'artifact';
  if (!path) return;
  try {
    const response = await fetchWithAuth(path);
    if (!response.ok) {
      // A 401 means the auth redirect is already handling this — a generic
      // "download failed" toast on top of it is misleading and, per the
      // sibling `fetchWithAuth` callers' convention, never shown.
      if (response.status === 401) {
        handleSessionExpired();
        return;
      }
      throw new ArtifactDownloadError(response.status);
    }
    // The API sanitizes this quoted filename; transcript links do not otherwise
    // know the original script/stdout filename.
    const filename = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/i)?.[1];
    downloadBlob(await response.blob(), filename || fallbackName);
  } catch (error) {
    console.error('[downloadArtifact]', { path, error });
    // Artifacts carry a TTL (spec §5.2) — a 404/410 here most often means the
    // artifact has expired and been reaped, not a transient failure, so it
    // gets its own message rather than the generic "try again" framing.
    const status = error instanceof ArtifactDownloadError ? error.status : undefined;
    const message = status === 404 || status === 410
      ? i18n.t('settings:aiAgentsPage.runs.detail.artifacts.downloadExpired')
      : i18n.t('reports:reports.reportsList.errors.downloadFailed');
    showToast({ type: 'error', message });
  }
}
