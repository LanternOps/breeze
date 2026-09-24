import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchWithAuth } from "../../../stores/auth";
import "../../../lib/i18n";
import { useStableT } from '@/lib/i18n/useStableT';

/** Mirrors `FilesystemVolume` in `apps/api/src/services/filesystemVolumes.ts`. */
export type FilesystemVolume = {
  mountPoint: string;
  /** The normalised key: send this back as `?path=` / `{ path }`. */
  scanPath: string;
  fsType: string | null;
  /** Null when the device has reported no disk row for this volume. */
  totalGb: number | null;
  usedGb: number | null;
  freeGb: number | null;
  usedPercent: number | null;
  isOsRoot: boolean;
  scanState: {
    lastRunMode: string;
    lastBaselineCompletedAt: string | null;
    hasCheckpoint: boolean;
  } | null;
  latestSnapshot: {
    id: string;
    capturedAt: string;
    partial: boolean;
    cleanupEstimateBytes: number;
  } | null;
};

/**
 * The device's scannable volumes.
 *
 * Every request owns an AbortController tied to unmount (spec §8) — the tab's
 * existing poll loop survives unmount today, which is defect 9, and the fix
 * starts with not repeating it here.
 */
export function useFilesystemVolumes(deviceId: string): {
  volumes: FilesystemVolume[];
  loading: boolean;
  error?: string;
  reload: () => Promise<void>;
} {
  const { t } = useTranslation("devices");
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
  const [volumes, setVolumes] = useState<FilesystemVolume[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const abortRef = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const response = await fetchWithAuth(
        `/devices/${deviceId}/filesystem/volumes`,
        { signal: controller.signal },
      );
      if (!response.ok) {
        const body = await response
          .json()
          .catch(() => ({ error: stableT("deviceFilesystemTab.failedToFetchVolumes") }));
        throw new Error(body.error || stableT("deviceFilesystemTab.failedToFetchVolumes"));
      }
      const body = await response.json();
      if (controller.signal.aborted) return;
      setVolumes(Array.isArray(body?.data) ? (body.data as FilesystemVolume[]) : []);
      setError(undefined);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(
        err instanceof Error ? err.message : stableT("deviceFilesystemTab.failedToFetchVolumes"),
      );
      setVolumes([]);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
    // `t` IS a dependency: the callback closes over it, and leaving it out is
    // what leaves a stale English fallback behind after a locale switch
    // (defect 9).
  }, [deviceId, stableT]);

  useEffect(() => {
    void reload();
    return () => abortRef.current?.abort();
  }, [reload]);

  return { volumes, loading, error, reload };
}
