import '@/lib/i18n';
import { useCallback, useEffect, useId, useState } from 'react';
import { Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { showToast } from '../shared/Toast';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { Dialog } from '../shared/Dialog';
import { type PamSignerGroup } from './types';
import {
  DialogHeader,
  EmptyState,
  ErrorAlert,
  TableSkeleton,
  btnGhostClass,
  btnOutlineClass,
  btnOutlineDestructiveClass,
  btnPrimaryClass,
  inputClass,
  tableClass,
  tableWrapClass,
  tbodyClass,
  tdClass,
  thClass,
  theadClass,
  theadRowClass,
  rowClass,
} from './ui';

/**
 * Manage reusable signer groups (trusted-publisher catalog). A group is a named
 * list of Authenticode signer (subject CN) patterns referenced from PAM rules
 * via matchSignerGroupId. Manage vendors once, reference everywhere.
 */
export default function PamSignerGroupsTab({ liveTick = 0 }: { liveTick?: number }) {
  const { t } = useTranslation('security');
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
        throw new Error(
          t('pamPamSignerGroupsTab.errors.loadWithStatus', {
            defaultValue: 'Failed to load signer groups (HTTP {{status}})',
            status: res.status,
          }),
        );
      }
      const body = await res.json();
      const list = ((body.signerGroups ?? []) as PamSignerGroup[]).slice();
      list.sort((a, b) => a.name.localeCompare(b.name));
      setGroups(list);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(
        err instanceof Error
          ? err.message
          : t('pamPamSignerGroupsTab.errors.load', { defaultValue: 'Failed to load signer groups' }),
      );
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [t]);

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
        errorFallback: t('pamPamSignerGroupsTab.errors.deleteGroup', {
          defaultValue: 'Failed to delete signer group',
        }),
        successMessage: t('pamPamSignerGroupsTab.toasts.groupDeleted', {
          defaultValue: 'Signer group "{{name}}" deleted',
          name: group.name,
        }),
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      void fetchGroups();
    } catch (err) {
      // A 409 ("used by N rule(s)") is surfaced by runAction's toast — just
      // don't re-toast it here.
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({
          type: 'error',
          message: t('pamPamSignerGroupsTab.errors.deleteGroup', {
            defaultValue: 'Failed to delete signer group',
          }),
        });
      }
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t('pamPamSignerGroupsTab.description', {
            defaultValue:
              'A signer group is a named list of trusted Authenticode signers. Reference one from a rule instead of repeating the same publisher across many rules.',
          })}
        </p>
        <button
          type="button"
          onClick={() => setCreating(true)}
          data-testid="pam-add-signer-group-btn"
          className={btnPrimaryClass}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('pamPamSignerGroupsTab.actions.addSignerGroup', { defaultValue: 'Add signer group' })}
        </button>
      </div>

      {error && <ErrorAlert>{error}</ErrorAlert>}

      {loading ? (
        <TableSkeleton
          rows={3}
          label={t('pamPamSignerGroupsTab.loading', { defaultValue: 'Loading signer groups…' })}
        />
      ) : groups.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title={t('pamPamSignerGroupsTab.empty.title', { defaultValue: 'No signer groups yet' })}
          description={t('pamPamSignerGroupsTab.empty.description', {
            defaultValue: 'Create one to reuse a trusted-publisher list across multiple rules.',
          })}
        />
      ) : (
        <div className={tableWrapClass}>
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr className={theadRowClass}>
                <th className={thClass}>{t('pamPamSignerGroupsTab.table.name', { defaultValue: 'Name' })}</th>
                <th className={thClass}>{t('pamPamSignerGroupsTab.table.signers', { defaultValue: 'Signers' })}</th>
                <th className={thClass} />
              </tr>
            </thead>
            <tbody className={tbodyClass}>
              {groups.map((group) => (
                <tr
                  key={group.id}
                  className={rowClass}
                  data-testid={`pam-signer-group-row-${group.id}`}
                >
                  <td className={tdClass}>
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
                    className={`${tdClass} max-w-[360px]`}
                    data-testid={`pam-signer-group-signers-${group.id}`}
                    title={group.signers.join(', ')}
                  >
                    <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums">
                      {group.signers.length}
                    </span>
                    {group.signers.length > 0 && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {group.signers.join(', ')}
                      </span>
                    )}
                  </td>
                  <td className={`${tdClass} whitespace-nowrap text-right`}>
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setEditing(group)}
                        data-testid={`pam-signer-group-edit-${group.id}`}
                        className={btnOutlineClass}
                      >
                        {t('common:actions.edit', { defaultValue: 'Edit' })}
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(group)}
                        data-testid={`pam-signer-group-delete-${group.id}`}
                        className={btnOutlineDestructiveClass}
                      >
                        {t('common:actions.delete', { defaultValue: 'Delete' })}
                      </button>
                    </div>
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
        title={t('pamPamSignerGroupsTab.deleteDialog.title', { defaultValue: 'Delete signer group' })}
        message={t('pamPamSignerGroupsTab.deleteDialog.message', {
          defaultValue:
            'Delete signer group "{{name}}"? Rules referencing it must be updated first.',
          name: deleteTarget?.name ?? '',
        })}
        confirmLabel={t('pamPamSignerGroupsTab.deleteDialog.confirm', { defaultValue: 'Delete group' })}
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
  const { t } = useTranslation('security');
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
  const titleId = useId();

  const modalTitle = isEdit
    ? t('pamPamSignerGroupsTab.modal.title.edit', { defaultValue: 'Edit signer group' })
    : t('pamPamSignerGroupsTab.modal.title.new', { defaultValue: 'New signer group' });

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
        errorFallback: isEdit
          ? t('pamPamSignerGroupsTab.modal.errors.update', {
              defaultValue: 'Failed to update signer group',
            })
          : t('pamPamSignerGroupsTab.modal.errors.create', {
              defaultValue: 'Failed to create signer group',
            }),
        successMessage: t('pamPamSignerGroupsTab.modal.toasts.saved', {
          defaultValue: 'Signer group "{{name}}" {{action}}',
          name: name.trim(),
          action: isEdit
            ? t('pamPamSignerGroupsTab.modal.toasts.updated', { defaultValue: 'updated' })
            : t('pamPamSignerGroupsTab.modal.toasts.created', { defaultValue: 'created' }),
        }),
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      onSaved();
    } catch (err) {
      if (err instanceof ActionError) {
        if (err.status === 401) return;
        setError(err.message);
      } else {
        setError(
          err instanceof Error
            ? err.message
            : t('pamPamSignerGroupsTab.modal.errors.network', { defaultValue: 'Network error' }),
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={modalTitle}
      labelledBy={titleId}
      maxWidth="lg"
      className="flex max-h-[90vh] flex-col"
    >
      <DialogHeader id={titleId} title={modalTitle} />
      <form onSubmit={handleSubmit} className="space-y-4 overflow-y-auto p-6">
        <div>
          <label htmlFor={nameId} className="mb-1 block text-sm font-medium">
            {t('pamPamSignerGroupsTab.modal.form.name', { defaultValue: 'Name' })}
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
            {t('pamPamSignerGroupsTab.modal.form.descriptionOptional', {
              defaultValue: 'Description (optional)',
            })}
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
          <span className="mb-1 block text-sm font-medium">
            {t('pamPamSignerGroupsTab.modal.form.signers', { defaultValue: 'Signers' })}
          </span>
          <p className="mb-2 text-xs text-muted-foreground">
            {t('pamPamSignerGroupsTab.modal.form.signersHelp', {
              defaultValue:
                'One Authenticode signer (subject CN) per row; matched case-insensitively.',
            })}
          </p>
          <div className="space-y-2">
            {signers.map((signer, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  value={signer}
                  onChange={(e) => updateSigner(i, e.target.value)}
                  placeholder={t('pamPamSignerGroupsTab.modal.form.signerPlaceholder', {
                    defaultValue: 'e.g. Microsoft Corporation',
                  })}
                  maxLength={255}
                  data-testid={`pam-signer-group-signer-${i}`}
                  className={inputClass}
                />
                <button
                  type="button"
                  onClick={() => removeSigner(i)}
                  aria-label={t('pamPamSignerGroupsTab.modal.actions.removeSigner', {
                    defaultValue: 'Remove signer',
                  })}
                  data-testid={`pam-signer-group-remove-signer-${i}`}
                  className="rounded-md border border-destructive/40 p-2 text-destructive shadow-xs transition-colors hover:bg-destructive/10"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={addSigner}
            data-testid="pam-signer-group-add-signer"
            className={`mt-2 ${btnOutlineClass}`}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            {t('pamPamSignerGroupsTab.modal.actions.addSigner', { defaultValue: 'Add signer' })}
          </button>
        </div>

        {error && <ErrorAlert>{error}</ErrorAlert>}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={btnGhostClass}>
            {t('common:actions.cancel', { defaultValue: 'Cancel' })}
          </button>
          <button
            type="submit"
            disabled={submitting || !name.trim()}
            data-testid="pam-signer-group-save"
            className={btnPrimaryClass}
          >
            {submitting
              ? t('common:states.saving', { defaultValue: 'Saving…' })
              : isEdit
                ? t('pamPamSignerGroupsTab.modal.actions.saveChanges', {
                    defaultValue: 'Save changes',
                  })
                : t('pamPamSignerGroupsTab.modal.actions.createGroup', {
                    defaultValue: 'Create group',
                  })}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
