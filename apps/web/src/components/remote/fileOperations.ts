import { fetchWithAuth } from '@/stores/auth';

export type FileOpResult = {
  path?: string;
  sourcePath?: string;
  destPath?: string;
  trashId?: string;
  restoredPath?: string;
  status: 'success' | 'failure';
  error?: string;
};

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
): Promise<{ results: FileOpResult[] }> {
  const response = await fetchWithAuth(`/system-tools/devices/${deviceId}/files/copy`, {
    method: 'POST',
    body: JSON.stringify({ items }),
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({ error: 'Copy failed' }));
    throw new Error(json.error || 'Copy failed');
  }
  return response.json();
}

export async function moveFiles(
  deviceId: string,
  items: { sourcePath: string; destPath: string }[]
): Promise<{ results: FileOpResult[] }> {
  const response = await fetchWithAuth(`/system-tools/devices/${deviceId}/files/move`, {
    method: 'POST',
    body: JSON.stringify({ items }),
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({ error: 'Move failed' }));
    throw new Error(json.error || 'Move failed');
  }
  return response.json();
}

export async function deleteFiles(
  deviceId: string,
  paths: string[],
  permanent = false
): Promise<{ results: FileOpResult[] }> {
  const response = await fetchWithAuth(`/system-tools/devices/${deviceId}/files/delete`, {
    method: 'POST',
    body: JSON.stringify({ paths, permanent }),
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({ error: 'Delete failed' }));
    throw new Error(json.error || 'Delete failed');
  }
  return response.json();
}

export async function listTrash(deviceId: string): Promise<TrashItem[]> {
  const response = await fetchWithAuth(`/system-tools/devices/${deviceId}/files/trash`);
  if (!response.ok) {
    const json = await response.json().catch(() => ({ error: 'Failed to list trash' }));
    throw new Error(json.error || 'Failed to list trash');
  }
  const json = await response.json();
  return json.data || [];
}

export async function restoreFromTrash(
  deviceId: string,
  trashIds: string[]
): Promise<{ results: FileOpResult[] }> {
  const response = await fetchWithAuth(`/system-tools/devices/${deviceId}/files/trash/restore`, {
    method: 'POST',
    body: JSON.stringify({ trashIds }),
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({ error: 'Restore failed' }));
    throw new Error(json.error || 'Restore failed');
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
    const json = await response.json().catch(() => ({ error: 'Purge failed' }));
    throw new Error(json.error || 'Purge failed');
  }
  return response.json();
}
