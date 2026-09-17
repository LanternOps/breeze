import type { MouseEvent } from 'react';
import { fetchWithAuth } from '@/stores/auth';
import { showToast } from '@/components/shared/Toast';
import { downloadBlob } from './downloadBlob';
import { i18n } from './i18n';

/** Artifact routes require a bearer token; a plain anchor cannot supply it. */
export async function downloadArtifact(event: MouseEvent<HTMLAnchorElement>): Promise<void> {
  event.preventDefault();
  const path = event.currentTarget.getAttribute('href');
  const fallbackName = event.currentTarget.getAttribute('download') || 'artifact';
  if (!path) return;
  try {
    const response = await fetchWithAuth(path);
    if (!response.ok) throw new Error(`Artifact download failed (${response.status})`);
    // The API sanitizes this quoted filename; transcript links do not otherwise
    // know the original script/stdout filename.
    const filename = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/i)?.[1];
    downloadBlob(await response.blob(), filename || fallbackName);
  } catch {
    showToast({ type: 'error', message: i18n.t('reports:reports.reportsList.errors.downloadFailed') });
  }
}
