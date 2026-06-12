import { useState, useCallback } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';

export type ResolvedInstallPatchIds = {
  /** Patch ids approved for install. */
  patchIds: string[];
  /** Count of pending patches dropped because they are awaiting approval. */
  skippedPendingApproval?: number;
};

type UseBulkActionsOptions = {
  resolveInstallPatchIds?: (deviceId: string) => Promise<string[] | ResolvedInstallPatchIds>;
};

function normalizeResolved(value: string[] | ResolvedInstallPatchIds): ResolvedInstallPatchIds {
  if (Array.isArray(value)) {
    return { patchIds: value };
  }
  return { patchIds: value.patchIds, skippedPendingApproval: value.skippedPendingApproval };
}

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
    // Devices that hit a 409 approval-state failure on install.
    const approvalFailed: string[] = [];
    // Distinct generic (non-approval) error messages read off the response body.
    const genericErrors = new Set<string>();
    // Count of patches silently dropped because they were awaiting approval,
    // and how many devices had at least one such patch dropped.
    let patchesSkippedPendingApproval = 0;
    let devicesWithSkippedPatches = 0;
    try {
      for (const deviceId of ids) {
        let patchIds: string[] = [];
        if (resolveInstallPatchIds) {
          const resolved = normalizeResolved(await resolveInstallPatchIds(deviceId));
          patchIds = resolved.patchIds;
          const droppedHere = resolved.skippedPendingApproval ?? 0;
          if (droppedHere > 0) {
            patchesSkippedPendingApproval += droppedHere;
            devicesWithSkippedPatches += 1;
          }
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
          // Read the error body so we can distinguish an approval-state
          // rejection (409) from a generic failure. Be defensive: the body
          // may not be JSON.
          const body = await response.json().catch(() => null) as
            | { error?: string; unapprovedPatchIds?: unknown; missingPatchIds?: unknown }
            | null;
          if (response.status === 409) {
            approvalFailed.push(deviceId);
          } else {
            failed.push(deviceId);
            if (body && typeof body.error === 'string' && body.error.trim()) {
              genericErrors.add(body.error.trim());
            }
          }
        }
      }

      const queuedCount = ids.length - failed.length - approvalFailed.length - skipped.length;
      if (queuedCount > 0) {
        let success = `Patch install queued on ${queuedCount} ${queuedCount === 1 ? 'device' : 'devices'}`;
        if (patchesSkippedPendingApproval > 0) {
          success += `; ${patchesSkippedPendingApproval} ${patchesSkippedPendingApproval === 1 ? 'patch' : 'patches'} across ${devicesWithSkippedPatches} ${devicesWithSkippedPatches === 1 ? 'device' : 'devices'} skipped pending approval`;
        }
        setBulkSuccess(success);
      }

      if (failed.length > 0 || approvalFailed.length > 0 || skipped.length > 0) {
        const parts: string[] = [];
        if (approvalFailed.length > 0) {
          parts.push(`${approvalFailed.length} of ${ids.length} devices had patches pending approval, refresh and retry`);
        }
        if (failed.length > 0) {
          const detail = genericErrors.size > 0 ? ` (${[...genericErrors].join('; ')})` : '';
          parts.push(`Install failed on ${failed.length} of ${ids.length} devices${detail}`);
        }
        if (skipped.length > 0) {
          parts.push(`Skipped ${skipped.length} ${skipped.length === 1 ? 'device' : 'devices'} with no approved pending patches`);
        }
        setBulkError(parts.join('. '));
      } else if (queuedCount === 0 && patchesSkippedPendingApproval === 0) {
        setBulkError('No approved pending patches found for the selected devices');
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
