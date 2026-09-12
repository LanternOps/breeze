import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { Plus, Pencil, Trash2, LayoutTemplate } from 'lucide-react';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { useDefaultOwnerScope, type OwnerScope } from '../../hooks/useDefaultOwnerScope';
import {
  addTemplateItem,
  createTemplateSet,
  deleteTemplateSet,
  listTemplateSets,
  removeTemplateItem,
  updateTemplateItem,
  updateTemplateSet,
  type TemplateItem,
  type TemplateSet,
} from '../../lib/api/deliverableTemplates';
import type { DeliverableCadence, DeliverableCompletionMode } from '../../lib/api/serviceDeliverables';
import { ActionError, handleActionError } from '../../lib/runAction';
import { runClientAction } from '../../lib/runClientAction';

type SetModalMode = 'closed' | 'create' | 'edit' | 'delete';

interface LoadFailure {
  failed: true;
  message: string;
}

const CADENCES: readonly DeliverableCadence[] = ['monthly', 'quarterly', 'semiannual', 'annual', 'one_time'];
const COMPLETION_MODES: readonly DeliverableCompletionMode[] = ['explicit', 'on_ticket_resolve'];

interface ItemFormState {
  name: string;
  cadence: DeliverableCadence;
  leadDays: string;
  graceDays: string;
  artifactRequired: boolean;
  completionMode: DeliverableCompletionMode;
}

function blankItemForm(): ItemFormState {
  return {
    name: '',
    cadence: 'monthly',
    leadDays: '7',
    graceDays: '14',
    artifactRequired: true,
    completionMode: 'on_ticket_resolve',
  };
}

function itemFormFrom(item: TemplateItem): ItemFormState {
  return {
    name: item.name,
    cadence: item.cadence,
    leadDays: String(item.leadDays),
    graceDays: String(item.graceDays),
    artifactRequired: item.artifactRequired,
    completionMode: item.completionMode,
  };
}

function intOr(value: string, fallback: number): number {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const inputClass = 'h-9 w-full rounded-md border bg-background px-2 py-1.5 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring';
const labelClass = 'block text-xs font-medium text-muted-foreground';

/**
 * Partner-wide (or org-owned) deliverable template sets, authored once and
 * applied to any customer (feature #5573 W05, spec §9). Ownership follows the
 * CLAUDE.md "Partner-Wide First" playbook — same selector, same badge, same
 * capability gate as CustomFieldsPage.tsx (#2135 step 6), adapted to the
 * single `ownerScope` field this schema uses instead of a dual orgId/partnerId
 * key. Every mutation goes through runClientAction so a failure is always
 * shown to the user (CLAUDE.md "Web Mutation Handlers").
 */
export default function DeliverableTemplatesPage() {
  const { t } = useTranslation('deliverables');
  const uid = useId();

  const [sets, setSets] = useState<TemplateSet[] | LoadFailure | null>(null);

  const { isPartnerScope, defaultOwnerScope } = useDefaultOwnerScope();
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const canManagePartnerWide = useAuthStore((s) => s.user?.canManagePartnerWide) !== false;
  const showOwnerScope = isPartnerScope && canManagePartnerWide;

  // Set create/edit/delete modal state.
  const [modalMode, setModalMode] = useState<SetModalMode>('closed');
  const [selectedSet, setSelectedSet] = useState<TemplateSet | null>(null);
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formOwnerScope, setFormOwnerScope] = useState<OwnerScope>(defaultOwnerScope);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Inline item add/edit state, one at a time, scoped to a set.
  const [itemEditor, setItemEditor] = useState<{ setId: string; item: TemplateItem | null } | null>(null);
  const [itemForm, setItemForm] = useState<ItemFormState>(blankItemForm());
  const [itemSubmitting, setItemSubmitting] = useState(false);
  const [itemError, setItemError] = useState<string | null>(null);

  const canMutateSet = (set: TemplateSet) => set.orgId !== null || canManagePartnerWide;

  const load = useCallback(async () => {
    try {
      const rows = await listTemplateSets(fetchWithAuth);
      setSets(rows);
    } catch (err) {
      console.error('[DeliverableTemplatesPage] failed to load template sets', err);
      const message = err instanceof ActionError && err.message ? err.message : t('templates.errors.loadFailed');
      setSets({ failed: true, message });
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const resetSetForm = () => {
    setFormName('');
    setFormDescription('');
    setFormError(null);
  };

  const openCreate = () => {
    resetSetForm();
    setSelectedSet(null);
    setFormOwnerScope(defaultOwnerScope);
    setModalMode('create');
  };

  const openEdit = (set: TemplateSet) => {
    setSelectedSet(set);
    setFormName(set.name);
    setFormDescription(set.description ?? '');
    setFormError(null);
    setModalMode('edit');
  };

  const openDelete = (set: TemplateSet) => {
    setSelectedSet(set);
    setModalMode('delete');
  };

  const closeModal = () => {
    setModalMode('closed');
    setSelectedSet(null);
    resetSetForm();
  };

  const handleSetSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = formName.trim();
    if (!trimmedName) return;

    setSubmitting(true);
    setFormError(null);
    try {
      const description = formDescription.trim() ? formDescription.trim() : null;
      if (modalMode === 'edit' && selectedSet) {
        const saved = await runClientAction(
          () => updateTemplateSet(fetchWithAuth, selectedSet.id, { name: trimmedName, description }),
          { errorFallback: t('templates.errors.saveFailed'), successMessage: t('templates.toast.setSaved') },
        );
        setSets((prev) => (Array.isArray(prev) ? prev.map((s) => (s.id === saved.id ? saved : s)) : prev));
      } else {
        // Exactly one ownership key, mirroring CustomFieldsPage.tsx (#2135
        // step 6): the selector's choice when the actor may manage
        // partner-wide state, otherwise always this organization. currentOrgId
        // can be null during the org-context unresolved/loading window; omit
        // orgId entirely rather than send a literal null, which the schema
        // (`orgId` is `.optional()`, not `.nullable()`) would reject.
        const ownerScope: OwnerScope = showOwnerScope && formOwnerScope === 'partner' ? 'partner' : 'organization';
        const orgId = ownerScope === 'organization' && currentOrgId ? currentOrgId : undefined;
        const created = await runClientAction(
          () =>
            createTemplateSet(fetchWithAuth, {
              ownerScope,
              ...(orgId ? { orgId } : {}),
              name: trimmedName,
              description,
              items: [],
            }),
          { errorFallback: t('templates.errors.saveFailed'), successMessage: t('templates.toast.setSaved') },
        );
        setSets((prev) => (Array.isArray(prev) ? [...prev, created] : [created]));
      }
      closeModal();
    } catch (err) {
      if (err instanceof ActionError && err.status === 409 && err.code === 'DUPLICATE_TEMPLATE_SET_NAME') {
        setFormError(t('templates.errors.duplicateSetName'));
        return;
      }
      if (err instanceof ActionError && err.status === 403 && err.code === 'PARTNER_WIDE_WRITE_DENIED') {
        setFormError(t('templates.errors.partnerWideDenied'));
        return;
      }
      if (err instanceof ActionError && err.status !== 401) setFormError(err.message);
      handleActionError(err, t('templates.errors.saveFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedSet) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await runClientAction(() => deleteTemplateSet(fetchWithAuth, selectedSet.id), {
        errorFallback: t('templates.errors.deleteFailed'),
        successMessage: t('templates.toast.setDeleted'),
      });
      setSets((prev) => (Array.isArray(prev) ? prev.filter((s) => s.id !== selectedSet.id) : prev));
      closeModal();
    } catch (err) {
      if (err instanceof ActionError && err.status !== 401) setFormError(err.message);
      handleActionError(err, t('templates.errors.deleteFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  // ---- Item management --------------------------------------------------

  const openAddItem = (setId: string) => {
    setItemEditor({ setId, item: null });
    setItemForm(blankItemForm());
    setItemError(null);
  };

  const openEditItem = (setId: string, item: TemplateItem) => {
    setItemEditor({ setId, item });
    setItemForm(itemFormFrom(item));
    setItemError(null);
  };

  const closeItemEditor = () => {
    setItemEditor(null);
    setItemError(null);
  };

  const applyItemToSets = (setId: string, item: TemplateItem, remove = false) => {
    setSets((prev) => {
      if (!Array.isArray(prev)) return prev;
      return prev.map((s) => {
        if (s.id !== setId) return s;
        const items = remove
          ? s.items.filter((i) => i.id !== item.id)
          : s.items.some((i) => i.id === item.id)
            ? s.items.map((i) => (i.id === item.id ? item : i))
            : [...s.items, item];
        return { ...s, items };
      });
    });
  };

  const handleItemSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!itemEditor) return;
    const trimmedName = itemForm.name.trim();
    if (!trimmedName) return;

    setItemSubmitting(true);
    setItemError(null);
    try {
      // `sortOrder` has a server-side default, but z.infer reflects the
      // OUTPUT type (default applied) for the create schema, so it is
      // required on `CreateTemplateItemInput` even though callers may omit it
      // at runtime. Preserve the existing item's position on edit; append new
      // items to the end of the target set's current list.
      const targetSet = Array.isArray(sets) ? sets.find((s) => s.id === itemEditor.setId) : undefined;
      const sortOrder = itemEditor.item?.sortOrder ?? targetSet?.items.length ?? 0;
      const common = {
        name: trimmedName,
        cadence: itemForm.cadence,
        leadDays: intOr(itemForm.leadDays, 7),
        graceDays: intOr(itemForm.graceDays, 14),
        artifactRequired: itemForm.artifactRequired,
        completionMode: itemForm.completionMode,
        sortOrder,
      };
      const saved = itemEditor.item
        ? await runClientAction(
            () => updateTemplateItem(fetchWithAuth, itemEditor.setId, itemEditor.item!.id, common),
            { errorFallback: t('templates.errors.itemSaveFailed'), successMessage: t('templates.toast.itemSaved') },
          )
        : await runClientAction(() => addTemplateItem(fetchWithAuth, itemEditor.setId, common), {
            errorFallback: t('templates.errors.itemSaveFailed'),
            successMessage: t('templates.toast.itemSaved'),
          });
      applyItemToSets(itemEditor.setId, saved);
      closeItemEditor();
    } catch (err) {
      if (err instanceof ActionError && err.status === 409 && err.code === 'DUPLICATE_TEMPLATE_ITEM_NAME') {
        setItemError(t('templates.errors.duplicateItemName'));
        return;
      }
      if (err instanceof ActionError && err.status !== 401) setItemError(err.message);
      handleActionError(err, t('templates.errors.itemSaveFailed'));
    } finally {
      setItemSubmitting(false);
    }
  };

  const handleRemoveItem = async (setId: string, item: TemplateItem) => {
    try {
      await runClientAction(() => removeTemplateItem(fetchWithAuth, setId, item.id), {
        errorFallback: t('templates.errors.itemDeleteFailed'),
        successMessage: t('templates.toast.itemDeleted'),
      });
      applyItemToSets(setId, item, true);
    } catch (err) {
      handleActionError(err, t('templates.errors.itemDeleteFailed'));
    }
  };

  if (sets === null) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="deliverable-templates-page">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('templates.pageTitle')}</h1>
          <p className="text-muted-foreground">{t('templates.pageDescription')}</p>
        </div>
        <button
          type="button"
          data-testid="deliverable-template-add"
          onClick={openCreate}
          className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          {t('templates.actions.newSet')}
        </button>
      </div>

      {!Array.isArray(sets) ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive" data-testid="deliverable-templates-error">
          {sets.message}
        </div>
      ) : sets.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center">
          <LayoutTemplate className="mx-auto h-12 w-12 text-muted-foreground" />
          <p className="mt-4 text-sm text-muted-foreground">{t('templates.empty')}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {sets.map((set) => (
            <div key={set.id} className="rounded-lg border bg-card" data-testid={`deliverable-template-set-${set.id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
                <div className="font-medium">
                  {set.name}
                  {set.orgId === null && (
                    <span
                      data-testid="deliverable-template-all-orgs-badge"
                      className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary"
                    >
                      {t('templates.allOrganizations')}
                    </span>
                  )}
                  {set.description && <p className="text-xs font-normal text-muted-foreground">{set.description}</p>}
                </div>
                {canMutateSet(set) && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      data-testid="deliverable-template-edit"
                      onClick={() => openEdit(set)}
                      className="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                      title={t('templates.actions.edit')}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      data-testid="deliverable-template-delete"
                      onClick={() => openDelete(set)}
                      className="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
                      title={t('templates.actions.delete')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>

              <div className="divide-y">
                {set.items.map((item) => (
                  <div key={item.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm" data-testid={`deliverable-template-item-${item.id}`}>
                    <div>
                      <span className="font-medium">{item.name}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {t(/* i18n-dynamic */ `cadence.${item.cadence}`)}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => openEditItem(set.id, item)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                        title={t('templates.actions.edit')}
                        data-testid={`deliverable-template-item-edit-${item.id}`}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleRemoveItem(set.id, item)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
                        title={t('templates.actions.delete')}
                        data-testid={`deliverable-template-item-remove-${item.id}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}

                {itemEditor?.setId === set.id ? (
                  <form onSubmit={(e) => void handleItemSubmit(e)} className="space-y-2 px-4 py-3" data-testid="deliverable-template-item-form">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div>
                        <label htmlFor={`${uid}-item-name-${set.id}`} className={labelClass}>{t('templates.form.itemName')}</label>
                        <input
                          id={`${uid}-item-name-${set.id}`}
                          data-testid="deliverable-template-item-name"
                          className={inputClass}
                          value={itemForm.name}
                          onChange={(e) => setItemForm((f) => ({ ...f, name: e.target.value }))}
                          maxLength={200}
                        />
                      </div>
                      <div>
                        <label htmlFor={`${uid}-item-cadence-${set.id}`} className={labelClass}>{t('templates.form.cadence')}</label>
                        <select
                          id={`${uid}-item-cadence-${set.id}`}
                          data-testid="deliverable-template-item-cadence"
                          className={inputClass}
                          value={itemForm.cadence}
                          onChange={(e) => setItemForm((f) => ({ ...f, cadence: e.target.value as DeliverableCadence }))}
                        >
                          {CADENCES.map((c) => (
                            <option key={c} value={c}>{t(/* i18n-dynamic */ `cadence.${c}`)}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label htmlFor={`${uid}-item-lead-${set.id}`} className={labelClass}>{t('templates.form.leadDays')}</label>
                        <input
                          id={`${uid}-item-lead-${set.id}`}
                          type="number"
                          min={0}
                          max={365}
                          className={inputClass}
                          value={itemForm.leadDays}
                          onChange={(e) => setItemForm((f) => ({ ...f, leadDays: e.target.value }))}
                        />
                      </div>
                      <div>
                        <label htmlFor={`${uid}-item-grace-${set.id}`} className={labelClass}>{t('templates.form.graceDays')}</label>
                        <input
                          id={`${uid}-item-grace-${set.id}`}
                          type="number"
                          min={0}
                          max={365}
                          className={inputClass}
                          value={itemForm.graceDays}
                          onChange={(e) => setItemForm((f) => ({ ...f, graceDays: e.target.value }))}
                        />
                      </div>
                      <div>
                        <label htmlFor={`${uid}-item-mode-${set.id}`} className={labelClass}>{t('templates.form.completionMode')}</label>
                        <select
                          id={`${uid}-item-mode-${set.id}`}
                          className={inputClass}
                          value={itemForm.completionMode}
                          onChange={(e) => setItemForm((f) => ({ ...f, completionMode: e.target.value as DeliverableCompletionMode }))}
                        >
                          {COMPLETION_MODES.map((m) => (
                            <option key={m} value={m}>{t(/* i18n-dynamic */ `form.completionMode.${m}`)}</option>
                          ))}
                        </select>
                      </div>
                      <label className="mt-5 flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={itemForm.artifactRequired}
                          onChange={(e) => setItemForm((f) => ({ ...f, artifactRequired: e.target.checked }))}
                        />
                        {t('templates.form.artifactRequired')}
                      </label>
                    </div>
                    {itemError && (
                      <p className="text-sm text-destructive" role="alert" data-testid="deliverable-template-item-error">
                        {itemError}
                      </p>
                    )}
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={closeItemEditor}
                        disabled={itemSubmitting}
                        className="h-8 rounded-md border px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
                      >
                        {t('templates.actions.cancel')}
                      </button>
                      <button
                        type="submit"
                        data-testid="deliverable-template-item-submit"
                        disabled={itemSubmitting || !itemForm.name.trim()}
                        className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                      >
                        {t('templates.actions.save')}
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="px-4 py-2">
                    <button
                      type="button"
                      data-testid="deliverable-template-item-add"
                      onClick={() => openAddItem(set.id)}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium hover:bg-muted"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {t('templates.actions.addItem')}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create/Edit set modal */}
      {(modalMode === 'create' || modalMode === 'edit') && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8 overflow-y-auto">
          <div className="w-full max-w-lg my-8 rounded-lg border bg-card p-6 shadow-lg">
            <h2 className="text-lg font-semibold">
              {modalMode === 'create' ? t('templates.actions.newSet') : t('templates.actions.edit')}
            </h2>

            <form onSubmit={(e) => void handleSetSubmit(e)} className="mt-4 space-y-4">
              <div>
                <label htmlFor={`${uid}-set-name`} className={labelClass}>{t('templates.form.name')}</label>
                <input
                  id={`${uid}-set-name`}
                  data-testid="deliverable-template-name"
                  className={inputClass}
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  maxLength={200}
                />
              </div>
              <div>
                <label htmlFor={`${uid}-set-description`} className={labelClass}>{t('templates.form.description')}</label>
                <textarea
                  id={`${uid}-set-description`}
                  data-testid="deliverable-template-description"
                  className={inputClass}
                  rows={2}
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  maxLength={2000}
                />
              </div>

              {modalMode === 'create' && showOwnerScope && (
                <fieldset className="space-y-2 rounded-md border p-3" data-testid="deliverable-template-owner">
                  <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
                    {t('templates.ownerScope.legend')}
                  </legend>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="templateOwnerScope"
                      value="partner"
                      data-testid="deliverable-template-owner-partner"
                      checked={formOwnerScope === 'partner'}
                      onChange={() => setFormOwnerScope('partner')}
                    />
                    {t('templates.ownerScope.allOrganizations')}
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="templateOwnerScope"
                      value="organization"
                      data-testid="deliverable-template-owner-org"
                      checked={formOwnerScope === 'organization'}
                      onChange={() => setFormOwnerScope('organization')}
                    />
                    {t('templates.ownerScope.thisOrganizationOnly')}
                  </label>
                </fieldset>
              )}

              {formError && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="deliverable-template-form-error">
                  {formError}
                </div>
              )}

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={closeModal}
                  className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground hover:text-foreground"
                >
                  {t('templates.actions.cancel')}
                </button>
                <button
                  type="submit"
                  data-testid="deliverable-template-submit"
                  disabled={submitting || !formName.trim()}
                  className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {t('templates.actions.save')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {modalMode === 'delete' && selectedSet && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
            <h2 className="text-lg font-semibold">{t('templates.actions.delete')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{selectedSet.name}</p>

            {formError && (
              <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {formError}
              </div>
            )}

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={closeModal}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                {t('templates.actions.cancel')}
              </button>
              <button
                type="button"
                data-testid="deliverable-template-delete-confirm"
                onClick={() => void handleDelete()}
                disabled={submitting}
                className="h-10 rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-50"
              >
                {t('templates.actions.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
