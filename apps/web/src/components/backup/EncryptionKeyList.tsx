import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Key,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { formatTime } from './backupDashboardHelpers';
import AlphaBadge from '../shared/AlphaBadge';

// ── Types ──────────────────────────────────────────────────────────

type KeyStatus = 'active' | 'rotated' | 'deactivated';
type KeyType = 'AES-256' | 'RSA-2048';

type EncryptionKey = {
  id: string;
  name: string;
  keyType: KeyType;
  status: KeyStatus;
  keyHash?: string | null;
  createdAt: string;
  expiresAt?: string | null;
};

const statusBadge: Record<KeyStatus, { className: string; label: string }> = {
  active: { className: 'bg-success/10 text-success', label: 'Active' },
  rotated: { className: 'bg-muted text-muted-foreground', label: 'Rotated' },
  deactivated: { className: 'bg-destructive/10 text-destructive', label: 'Deactivated' },
};

// ── Component ─────────────────────────────────────────────────────

export default function EncryptionKeyList() {
  const [keys, setKeys] = useState<EncryptionKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  // Create dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKeyType, setNewKeyType] = useState<KeyType>('AES-256');
  const [creating, setCreating] = useState(false);
  const [createdKeyHash, setCreatedKeyHash] = useState<string | null>(null);

  // Rotate confirmation
  const rotateDialogRef = useRef<HTMLDialogElement>(null);
  const [rotatingKeyId, setRotatingKeyId] = useState<string | null>(null);
  const [rotateLoading, setRotateLoading] = useState(false);

  const fetchKeys = useCallback(async () => {
    try {
      setError(undefined);
      const response = await fetchWithAuth('/backup/encryption/keys');
      if (!response.ok) throw new Error('Failed to fetch encryption keys');
      const payload = await response.json();
      const data = payload?.data ?? payload ?? [];
      setKeys(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('[EncryptionKeyList] fetchKeys:', err);
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) {
      setError('Key name is required');
      return;
    }
    setCreating(true);
    setError(undefined);
    setCreatedKeyHash(null);
    try {
      const response = await fetchWithAuth('/backup/encryption/keys', {
        method: 'POST',
        body: JSON.stringify({ name: newName, keyType: newKeyType }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to create key');
      }
      const payload = await response.json();
      const created = payload?.data ?? payload ?? {};
      setCreatedKeyHash(created.keyHash ?? null);
      setNewName('');
      await fetchKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create key');
    } finally {
      setCreating(false);
    }
  }, [fetchKeys, newKeyType, newName]);

  const handleRotateClick = useCallback((keyId: string) => {
    setRotatingKeyId(keyId);
    rotateDialogRef.current?.showModal();
  }, []);

  const handleRotateConfirm = useCallback(async () => {
    if (!rotatingKeyId) return;
    setRotateLoading(true);
    try {
      const response = await fetchWithAuth(`/backup/encryption/keys/${rotatingKeyId}/rotate`, {
        method: 'POST',
      });
      if (!response.ok) throw new Error('Failed to rotate key');
      rotateDialogRef.current?.close();
      await fetchKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rotate key');
    } finally {
      setRotateLoading(false);
      setRotatingKeyId(null);
    }
  }, [fetchKeys, rotatingKeyId]);

  const handleDeactivate = useCallback(async (keyId: string) => {
    try {
      const response = await fetchWithAuth(`/backup/encryption/keys/${keyId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'deactivated' }),
      });
      if (!response.ok) throw new Error('Failed to deactivate key');
      await fetchKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to deactivate key');
    }
  }, [fetchKeys]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading encryption keys...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <AlphaBadge variant="banner" disclaimer="Client-side encryption key management is in early access. Key creation and rotation are functional. Ensure you have secure backups of your encryption keys — lost keys cannot be recovered." />
      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Create Key Section */}
      <div className="rounded-lg border bg-card p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 font-semibold">
            <Lock className="h-4 w-4" /> Encryption Keys
          </h3>
          <button
            type="button"
            onClick={() => setCreateOpen(!createOpen)}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" /> Create Key
          </button>
        </div>

        {createOpen && (
          <div className="mt-4 rounded-md border bg-muted/10 p-4 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="enc-key-name" className="text-xs font-medium text-muted-foreground">Key Name</label>
                <input
                  id="enc-key-name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Production Backup Key"
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                />
              </div>
              <div>
                <label htmlFor="enc-key-type" className="text-xs font-medium text-muted-foreground">Key Type</label>
                <select
                  id="enc-key-type"
                  value={newKeyType}
                  onChange={(e) => setNewKeyType(e.target.value as KeyType)}
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="AES-256">AES-256</option>
                  <option value="RSA-2048">RSA-2048</option>
                </select>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCreate}
                disabled={creating}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {creating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Create
              </button>
              <button
                type="button"
                onClick={() => { setCreateOpen(false); setCreatedKeyHash(null); }}
                className="rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
              >
                Cancel
              </button>
            </div>
            {createdKeyHash && (
              <div className="rounded-md border border-success/40 bg-success/10 p-3">
                <p className="text-xs font-medium text-success">Key created successfully</p>
                <p className="mt-1 break-all font-mono text-xs text-foreground">{createdKeyHash}</p>
                <p className="mt-1 text-[10px] text-muted-foreground">Save this key hash securely. It will not be shown again.</p>
              </div>
            )}
          </div>
        )}

        {/* Key Table */}
        {keys.length === 0 ? (
          <div className="mt-4 flex flex-col items-center py-8 text-center">
            <Key className="h-10 w-10 text-muted-foreground/40" />
            <p className="mt-2 text-sm text-muted-foreground">No encryption keys configured.</p>
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-4 font-medium">Name</th>
                  <th className="pb-2 pr-4 font-medium">Type</th>
                  <th className="pb-2 pr-4 font-medium">Status</th>
                  <th className="pb-2 pr-4 font-medium">Created</th>
                  <th className="pb-2 pr-4 font-medium">Expires</th>
                  <th className="pb-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => {
                  const badge = statusBadge[key.status] ?? statusBadge.active;
                  return (
                    <tr key={key.id} className="border-b last:border-0">
                      <td className="py-2.5 pr-4 font-medium text-foreground">{key.name}</td>
                      <td className="py-2.5 pr-4 font-mono text-xs text-muted-foreground">{key.keyType}</td>
                      <td className="py-2.5 pr-4">
                        <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', badge.className)}>
                          {badge.label}
                        </span>
                      </td>
                      <td className="py-2.5 pr-4 text-muted-foreground">{formatTime(key.createdAt)}</td>
                      <td className="py-2.5 pr-4 text-muted-foreground">{formatTime(key.expiresAt)}</td>
                      <td className="py-2.5">
                        <div className="flex items-center gap-1">
                          {key.status === 'active' && (
                            <>
                              <button
                                type="button"
                                onClick={() => handleRotateClick(key.id)}
                                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                              >
                                <RefreshCw className="h-3 w-3" /> Rotate
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeactivate(key.id)}
                                className="rounded-md border px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
                              >
                                Deactivate
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Rotate Confirmation Dialog */}
      <dialog
        ref={rotateDialogRef}
        className="rounded-lg border bg-card p-6 shadow-xl backdrop:bg-black/50"
        onClose={() => setRotatingKeyId(null)}
      >
        <h3 className="text-lg font-semibold text-foreground">Rotate Encryption Key</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          This will generate a new key and mark the current key as rotated.
          Existing backups encrypted with the old key will remain accessible.
        </p>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => { rotateDialogRef.current?.close(); setRotatingKeyId(null); }}
            className="rounded-md border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleRotateConfirm}
            disabled={rotateLoading}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {rotateLoading && <Loader2 className="h-4 w-4 animate-spin" />}
            Confirm Rotate
          </button>
        </div>
      </dialog>
    </div>
  );
}
