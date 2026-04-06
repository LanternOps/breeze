import { useState, useCallback } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';

type UseBulkActionsOptions = {
  resolveInstallPatchIds?: (deviceId: string) => Promise<string[]>;
};

export function useBulkActions(
  selectedIds: Set<string>,
  clearSelection: () => void,
  onRefresh: () => void,
  options: UseBulkActionsOptions = {}
) {
  const [bulkAction, setBulkAction] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string>();
  const [bulkSuccess, setBulkSuccess] = useState<string>();
  const { resolveInstallPatchIds } = options;

  const handleBulkScan = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkAction('scan');
    setBulkError(undefined);
    setBulkSuccess(undefined);
    try {
      const response = await fetchWithAuth('/patches/scan', {
        method: 'POST',
        body: JSON.stringify({ deviceIds: ids })
      });
      if (!response.ok) {
        if (response.status === 401) { void navigateTo('/login', { replace: true }); return; }
        throw new Error('Failed to start patch scan');
      }
      setBulkSuccess(`Patch scan queued for ${ids.length} ${ids.length === 1 ? 'device' : 'devices'}`);
      clearSelection();
      setTimeout(() => { onRefresh(); }, 3000);
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : 'Failed to start scan');
    } finally {
      setBulkAction(null);
    }
  }, [selectedIds, clearSelection, onRefresh]);

  const handleBulkInstall = useCallback(async (filterIds?: string[]) => {
    const ids = filterIds ?? Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkAction('install');
    setBulkError(undefined);
    setBulkSuccess(undefined);
    const failed: string[] = [];
    const skipped: string[] = [];
    try {
      for (const deviceId of ids) {
        let patchIds: string[] = [];
        if (resolveInstallPatchIds) {
          patchIds = await resolveInstallPatchIds(deviceId);
          if (patchIds.length === 0) {
            skipped.push(deviceId);
            continue;
          }
        }

        const response = await fetchWithAuth(`/devices/${deviceId}/patches/install`, {
          method: 'POST',
          body: JSON.stringify({ patchIds })
        });
        if (!response.ok) {
          if (response.status === 401) { void navigateTo('/login', { replace: true }); return; }
          failed.push(deviceId);
        }
      }

      const queuedCount = ids.length - failed.length - skipped.length;
      if (queuedCount > 0) {
        setBulkSuccess(`Patch install queued on ${queuedCount} ${queuedCount === 1 ? 'device' : 'devices'}`);
      }

      if (failed.length > 0 || skipped.length > 0) {
        const parts: string[] = [];
        if (failed.length > 0) {
          parts.push(`Install failed on ${failed.length} of ${ids.length} devices`);
        }
        if (skipped.length > 0) {
          parts.push(`Skipped ${skipped.length} ${skipped.length === 1 ? 'device' : 'devices'} with no installable pending patches`);
        }
        setBulkError(parts.join('. '));
      } else if (queuedCount === 0) {
        setBulkError('No installable pending patches found for the selected devices');
      }

      clearSelection();
      setTimeout(() => { onRefresh(); }, 3000);
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : 'Failed to install patches');
    } finally {
      setBulkAction(null);
    }
  }, [selectedIds, clearSelection, onRefresh, resolveInstallPatchIds]);

  return {
    bulkAction,
    bulkError,
    setBulkError,
    bulkSuccess,
    setBulkSuccess,
    handleBulkScan,
    handleBulkInstall,
  };
}
