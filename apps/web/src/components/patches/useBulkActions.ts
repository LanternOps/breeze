import { useState, useCallback } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';

export function useBulkActions(
  selectedIds: Set<string>,
  clearSelection: () => void,
  onRefresh: () => void
) {
  const [bulkAction, setBulkAction] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string>();
  const [bulkSuccess, setBulkSuccess] = useState<string>();

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

  const handleBulkInstall = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkAction('install');
    setBulkError(undefined);
    setBulkSuccess(undefined);
    const failed: string[] = [];
    try {
      for (const deviceId of ids) {
        const response = await fetchWithAuth(`/devices/${deviceId}/patches/install`, {
          method: 'POST',
          body: JSON.stringify({})
        });
        if (!response.ok) {
          if (response.status === 401) { void navigateTo('/login', { replace: true }); return; }
          failed.push(deviceId);
        }
      }
      if (failed.length > 0) {
        setBulkError(`Install failed on ${failed.length} of ${ids.length} devices`);
      } else {
        setBulkSuccess(`Patch install queued on ${ids.length} ${ids.length === 1 ? 'device' : 'devices'}`);
      }
      clearSelection();
      setTimeout(() => { onRefresh(); }, 3000);
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : 'Failed to install patches');
    } finally {
      setBulkAction(null);
    }
  }, [selectedIds, clearSelection, onRefresh]);

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
