import { useCallback, useEffect, useId, useState } from 'react';
import { Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { showToast } from '../shared/Toast';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { Dialog } from '../shared/Dialog';
import { type PamSignerGroup } from './types';

/**
 * Manage reusable signer groups (trusted-publisher catalog). A group is a named
 * list of Authenticode signer (subject CN) patterns referenced from PAM rules
 * via matchSignerGroupId. Manage vendors once, reference everywhere.
 */
export default function PamSignerGroupsTab({ liveTick = 0 }: { liveTick?: number }) {
  const [groups, setGroups] = useState<PamSignerGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PamSignerGroup | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PamSignerGroup | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchGroups = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth('/pam/signer-groups', { signal });
      if (!res.ok) {
        if (res.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        throw new Error(`Failed to load signer groups (HTTP ${res.status})`);
      }
      const body = await res.json();
      const list = ((body.signerGroups ?? []) as PamSignerGroup[]).slice();
      list.sort((a, b) => a.name.localeCompare(b.name));
      setGroups(list);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Failed to load signer groups');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchGroups(controller.signal);
    return () => controller.abort();
  }, [fetchGroups, liveTick]);

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    const group = deleteTarget;
    setDeleting(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/pam/signer-groups/${group.id}`, { method: 'DELETE' }),
        errorFallback: 'Failed to delete signer group',
        successMessage: `Signer group "${group.name}" deleted`,
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      void fetchGroups();
    } catch (err) {
      // A 409 ("used by N rule(s)") is surfaced by runAction's toast — just
      // don't re-toast it here.
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: 'Failed to delete signer group' });
      }
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          A signer group is a named list of trusted Authenticode signers. Reference one from a rule
          instead of repeating the same publisher across many rules.
        </p>
        <button
          type="button"
          onClick={() => setCreating(true)}
          data-testid="pam-add-signer-group-btn"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          Add signer group
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 rounded-md border bg-card px-4 py-6 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          Loading signer groups…
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-md border border-dashed bg-card px-4 py-8 text-center">
          <ShieldCheck className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">No signer groups yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Create one to reuse a trusted-publisher list across multiple rules.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Signers</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr
                  key={group.id}
                  className="border-b last:border-0"
                  data-testid={`pam-signer-group-row-${group.id}`}
                >
                  <td className="px-3 py-2">
                    <div className="font-medium" data-testid={`pam-signer-group-name-${group.id}`}>
                      {group.name}
                    </div>
                    {group.description && (
                      <div
                        className="mt-0.5 max-w-[280px] truncate text-xs text-muted-foreground"
                        title={group.description}
                      >
                        {group.description}
                      </div>
                    )}
                  </td>
                  <td
                    className="max-w-[360px] px-3 py-2 text-xs text-muted-foreground"
                    data-testid={`pam-signer-group-signers-${group.id}`}
                    title={group.signers.join(', ')}
                  >
                    <span className="font-medium">{group.signers.length}</span>
                    {group.signers.length > 0 && (
                      <span className="ml-1.5 truncate">· {group.signers.join(', ')}</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => setEditing(group)}
                      data-testid={`pam-signer-group-edit-${group.id}`}
                      className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-accent"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(group)}
                      data-testid={`pam-signer-group-delete-${group.id}`}
                      className="ml-1.5 rounded-md border border-destructive/40 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
        title="Delete signer group"
        message={`Delete signer group "${deleteTarget?.name ?? ''}"? Rules referencing it must be updated first.`}
        confirmLabel="Delete group"
        variant="destructive"
        isLoading={deleting}
        confirmTestId="pam-signer-group-delete-confirm"
      />

      {(creating || editing) && (
        <PamSignerGroupModal
          group={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            void fetchGroups();
          }}
        />
      )}
    </div>
  );
}

/** Create/edit modal for a signer group. */
function PamSignerGroupModal({
  group,
  onClose,
  onSaved,
}: {
  group: PamSignerGroup | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = group !== null;
  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  // One editable row per signer pattern; always keep at least one (blank) row so
  // the add/remove controls have something to anchor to.
  const [signers, setSigners] = useState<string[]>(
    group?.signers && group.signers.length > 0 ? group.signers : [''],
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameId = useId();
  const descId = useId();

  const inputClass = 'w-full rounded-md border bg-background px-3 py-2 text-sm';

  const updateSigner = (i: number, value: string) => {
    setSigners((prev) => prev.map((s, idx) => (idx === i ? value : s)));
  };
  const addSigner = () => setSigners((prev) => [...prev, '']);
  const removeSigner = (i: number) => {
    setSigners((prev) => {
      const next = prev.filter((_, idx) => idx !== i);
      return next.length > 0 ? next : [''];
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    // The server trims/de-dupes; send the non-blank rows.
    const cleaned = signers.map((s) => s.trim()).filter((s) => s.length > 0);

    const payload: Record<string, unknown> = {
      name: name.trim(),
      description: description.trim() || null,
      signers: cleaned,
    };

    setSubmitting(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(isEdit ? `/pam/signer-groups/${group.id}` : '/pam/signer-groups', {
            method: isEdit ? 'PATCH' : 'POST',
            body: JSON.stringify(payload),
          }),
        errorFallback: isEdit ? 'Failed to update signer group' : 'Failed to create signer group',
        successMessage: `Signer group "${name.trim()}" ${isEdit ? 'updated' : 'created'}`,
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      onSaved();
    } catch (err) {
      if (err instanceof ActionError) {
        if (err.status === 401) return;
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : 'Network error');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={isEdit ? 'Edit signer group' : 'New signer group'}
      maxWidth="lg"
      className="max-h-[90vh] overflow-y-auto p-6"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor={nameId} className="mb-1 block text-sm font-medium">
            Name
          </label>
          <input
            id={nameId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={255}
            data-testid="pam-signer-group-name"
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor={descId} className="mb-1 block text-sm font-medium">
            Description (optional)
          </label>
          <input
            id={descId}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
            data-testid="pam-signer-group-description"
            className={inputClass}
          />
        </div>

        <div>
          <span className="mb-1 block text-sm font-medium">Signers</span>
          <p className="mb-2 text-xs text-muted-foreground">
            One Authenticode signer (subject CN) per row; matched case-insensitively.
          </p>
          <div className="space-y-2">
            {signers.map((signer, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  value={signer}
                  onChange={(e) => updateSigner(i, e.target.value)}
                  placeholder="e.g. Microsoft Corporation"
                  maxLength={255}
                  data-testid={`pam-signer-group-signer-${i}`}
                  className={inputClass}
                />
                <button
                  type="button"
                  onClick={() => removeSigner(i)}
                  aria-label="Remove signer"
                  data-testid={`pam-signer-group-remove-signer-${i}`}
                  className="rounded-md border border-destructive/40 p-2 text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={addSigner}
            data-testid="pam-signer-group-add-signer"
            className="mt-2 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-accent"
          >
            <Plus className="h-3.5 w-3.5" />
            Add signer
          </button>
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-2 text-sm hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !name.trim()}
            data-testid="pam-signer-group-save"
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create group'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
