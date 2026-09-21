/**
 * Latest filesystem snapshot for ONE scan path, plus that device's recent
 * threshold-triggered scans (spec §8).
 *
 * Two things the 958-line tab got wrong and this fixes (spec §2 defect 9):
 *   - the fetches outlived the component. Every request here rides one
 *     AbortController that the effect's cleanup aborts, so an unmount — or a
 *     volume switch — cancels the in-flight work instead of resolving into a
 *     dead component.
 *   - `t` was missing from the callbacks' dependency arrays, so a language
 *     switch left the previous language's fallback strings in place. It is
 *     declared here.
 *
 * A 404 is NOT an error: it is the honest answer for a volume that has never
 * been scanned, and the caller renders the "run Analyze" empty state.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '@/stores/auth';
import '@/lib/i18n';
import {
  readThresholdEvents,
  type CommandRow,
  type FilesystemSnapshot,
  type ThresholdEvent,
} from './filesystemTabUtils';

function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

export function useFilesystemSnapshot(
  deviceId: string,
  scanPath: string | null,
): {
  snapshot: FilesystemSnapshot | null;
  thresholdEvents: ThresholdEvent[];
  loading: boolean;
  error: string | null;
  reload: (options?: { silent?: boolean }) => Promise<void>;
} {
  const { t } = useTranslation('devices');
  const [snapshot, setSnapshot] = useState<FilesystemSnapshot | null>(null);
  const [thresholdEvents, setThresholdEvents] = useState<ThresholdEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!scanPath) return;
      // One controller per load; aborting the previous one is what stops a
      // slow request for volume A landing after the user picked volume B.
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      if (!options.silent) setLoading(true);
      setError(null);
      try {
        const [snapshotResponse, commandsResponse] = await Promise.all([
          fetchWithAuth(
            `/devices/${deviceId}/filesystem?path=${encodeURIComponent(scanPath)}`,
            { signal: controller.signal },
          ),
          fetchWithAuth(`/devices/${deviceId}/commands?limit=100`, { signal: controller.signal }),
        ]);

        if (controller.signal.aborted) return;

        if (snapshotResponse.status === 404) {
          setSnapshot(null);
        } else if (!snapshotResponse.ok) {
          const body = await snapshotResponse.json().catch(() => null);
          throw new Error(
            (body && typeof body.error === 'string' && body.error)
            || t('deviceFilesystemTab.failedToFetchFilesystemStatus'),
          );
        } else {
          const body = await snapshotResponse.json();
          setSnapshot((body?.data ?? null) as FilesystemSnapshot | null);
        }

        if (!commandsResponse.ok) {
          const body = await commandsResponse.json().catch(() => null);
          throw new Error(
            (body && typeof body.error === 'string' && body.error)
            || t('deviceFilesystemTab.failedToFetchCommandHistory'),
          );
        }
        const commandsBody = await commandsResponse.json();
        const rows = Array.isArray(commandsBody?.data) ? (commandsBody.data as CommandRow[]) : [];
        if (controller.signal.aborted) return;
        setThresholdEvents(readThresholdEvents(rows));
      } catch (err) {
        if (isAbort(err) || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : t('deviceFilesystemTab.failedToLoadFilesystemStatus'));
        setSnapshot(null);
      } finally {
        if (!controller.signal.aborted && !options.silent) setLoading(false);
      }
    },
    [deviceId, scanPath, t],
  );

  useEffect(() => {
    void load();
    return () => {
      controllerRef.current?.abort();
    };
  }, [load]);

  return { snapshot, thresholdEvents, loading, error, reload: load };
}
