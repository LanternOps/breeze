import { fetchWithAuth } from '@/stores/auth';

export type FileOpResult = {
  path?: string;
  sourcePath?: string;
  destPath?: string;
  trashId?: string;
  restoredPath?: string;
  status: 'success' | 'failure';
  error?: string;
  unverified?: boolean;
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

// Signals that a single-item mutating operation timed out and may or may not
// have completed on the device. Callers should render a "verify before
// retrying" state rather than a hard failure.
export class UnverifiedOperationError extends Error {
  readonly unverified = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'UnverifiedOperationError';
  }
}

export async function uploadFile(
  deviceId: string,
  body: { path: string; content: string; encoding?: string },
  opts?: { signal?: AbortSignal },
): Promise<{ path: string; size?: number }> {
  const response = await fetchWithAuth(`/system-tools/devices/${deviceId}/files/upload`, {
    method: 'POST',
    body: JSON.stringify(body),
    signal: opts?.signal,
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({ error: 'Upload failed' }));
    if (json?.unverified) {
      throw new UnverifiedOperationError(json.error || 'Upload unverified');
    }
    throw new Error(json?.error || 'Upload failed');
  }
  const json = await response.json();
  return json.data ?? { path: body.path };
}

export type BulkOutcome = {
  result: 'success' | 'failure' | 'unverified';
  summary?: string;
};

export function summarizeBulkResults(results: FileOpResult[]): BulkOutcome {
  const failures = results.filter((r) => r.status === 'failure' && !r.unverified);
  const unverified = results.filter((r) => r.unverified);
  if (failures.length === 0 && unverified.length === 0) {
    return { result: 'success' };
  }
  const parts: string[] = [];
  if (failures.length > 0) parts.push(`${failures.length} failed`);
  if (unverified.length > 0) parts.push(`${unverified.length} unverified`);
  const summary = unverified.length > 0
    ? `${parts.join(', ')} — refresh to verify`
    : parts.join(', ');
  const result: BulkOutcome['result'] = failures.length > 0 ? 'failure' : 'unverified';
  return { result, summary };
}
