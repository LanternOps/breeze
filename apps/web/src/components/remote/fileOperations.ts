import { fetchWithAuth } from '@/stores/auth';

export type CopyMoveResult = {
  sourcePath: string;
  destPath: string;
  status: 'success' | 'failure';
  error?: string;
};

export type DeleteResult = {
  path: string;
  status: 'success' | 'failure';
  error?: string;
};

export type RestoreResult = {
  trashId: string;
  restoredPath?: string;
  status: 'success' | 'failure';
  error?: string;
};

export type FileOpResult = CopyMoveResult | DeleteResult | RestoreResult;

export type TrashItem = {
  originalPath: string;
  trashId: string;
  deletedAt: string;
  deletedBy?: string;
  isDirectory: boolean;
  sizeBytes: number;
};

export async function copyFiles(
  deviceId: string,
  items: { sourcePath: string; destPath: string }[]
): Promise<{ results: CopyMoveResult[] }> {
  const response = await fetchWithAuth(`/system-tools/devices/${deviceId}/files/copy`, {
    method: 'POST',
    body: JSON.stringify({ items }),
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({ error: `Copy failed (HTTP ${response.status})` }));
    throw new Error(json.error || `Copy failed (HTTP ${response.status})`);
  }
  return response.json();
}

export async function moveFiles(
  deviceId: string,
  items: { sourcePath: string; destPath: string }[]
): Promise<{ results: CopyMoveResult[] }> {
  const response = await fetchWithAuth(`/system-tools/devices/${deviceId}/files/move`, {
    method: 'POST',
    body: JSON.stringify({ items }),
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({ error: `Move failed (HTTP ${response.status})` }));
    throw new Error(json.error || `Move failed (HTTP ${response.status})`);
  }
  return response.json();
}

export async function deleteFiles(
  deviceId: string,
  paths: string[],
  permanent = false
): Promise<{ results: DeleteResult[] }> {
  const response = await fetchWithAuth(`/system-tools/devices/${deviceId}/files/delete`, {
    method: 'POST',
    body: JSON.stringify({ paths, permanent }),
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({ error: `Delete failed (HTTP ${response.status})` }));
    throw new Error(json.error || `Delete failed (HTTP ${response.status})`);
  }
  return response.json();
}

export async function listTrash(deviceId: string): Promise<TrashItem[]> {
  const response = await fetchWithAuth(`/system-tools/devices/${deviceId}/files/trash`);
  if (!response.ok) {
    const json = await response.json().catch(() => ({ error: `Failed to list trash (HTTP ${response.status})` }));
    throw new Error(json.error || `Failed to list trash (HTTP ${response.status})`);
  }
  const json = await response.json();
  return json.data || [];
}

export async function restoreFromTrash(
  deviceId: string,
  trashIds: string[]
): Promise<{ results: RestoreResult[] }> {
  const response = await fetchWithAuth(`/system-tools/devices/${deviceId}/files/trash/restore`, {
    method: 'POST',
    body: JSON.stringify({ trashIds }),
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({ error: `Restore failed (HTTP ${response.status})` }));
    throw new Error(json.error || `Restore failed (HTTP ${response.status})`);
  }
  return response.json();
}

export async function purgeTrash(
  deviceId: string,
  trashIds?: string[]
): Promise<{ success: boolean; purged?: number }> {
  const response = await fetchWithAuth(`/system-tools/devices/${deviceId}/files/trash/purge`, {
    method: 'POST',
    body: JSON.stringify({ trashIds }),
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({ error: `Purge failed (HTTP ${response.status})` }));
    throw new Error(json.error || `Purge failed (HTTP ${response.status})`);
  }
  return response.json();
}
