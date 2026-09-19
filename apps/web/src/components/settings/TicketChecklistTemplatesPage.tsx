import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { Plus, Pencil, Trash2, ListChecks } from 'lucide-react';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { useDefaultOwnerScope, type OwnerScope } from '../../hooks/useDefaultOwnerScope';
import {
  addChecklistTemplateItem,
  createChecklistTemplate,
  deleteChecklistTemplate,
  listChecklistTemplates,
  removeChecklistTemplateItem,
  updateChecklistTemplate,
  type ChecklistTemplate,
  type ChecklistTemplateItem,
} from '../../lib/api/ticketChecklistTemplates';
import { ActionError, handleActionError } from '../../lib/runAction';
import { runClientAction } from '../../lib/runClientAction';

type ModalMode = 'closed' | 'create' | 'edit' | 'delete';

interface LoadFailure {
  failed: true;
  message: string;
}

const inputClass =
  'h-9 w-full rounded-md border bg-background px-2 py-1.5 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring';
const labelClass = 'block text-xs font-medium text-muted-foreground';

/**
 * Partner-wide (or org-owned) ticket checklist templates, authored once and
 * applied to any ticket (feature #5808 W02, spec §7). Ownership follows the
 * CLAUDE.md "Partner-Wide First" playbook — the same create-only selector, the
 * same "All orgs" badge and the same TWO-flag capability gate as
 * DeliverableTemplatesPage.tsx. Every mutation goes through `runClientAction`
 * so a failure is always shown to the user (CLAUDE.md "Web Mutation Handlers").
 */
export default function TicketChecklistTemplatesPage() {
  const { t } = useTranslation('checklists');
  const uid = useId();

  const [templates, setTemplates] = useState<ChecklistTemplate[] | LoadFailure | null>(null);

  // TWO flags, not one: partner scope alone is not permission to author
  // partner-wide state — the user must also carry canManagePartnerWide.
  const { isPartnerScope, defaultOwnerScope } = useDefaultOwnerScope();
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const canManagePartnerWide = useAuthStore((s) => s.user?.canManagePartnerWide) !== false;
  const showOwnerScope = isPartnerScope && canManagePartnerWide;

  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selected, setSelected] = useState<ChecklistTemplate | null>(null);
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formInstructions, setFormInstructions] = useState('');
  const [formIsActive, setFormIsActive] = useState(true);
  const [formOwnerScope, setFormOwnerScope] = useState<OwnerScope>(defaultOwnerScope);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [itemEditor, setItemEditor] = useState<{ templateId: string } | null>(null);
  const [itemLabel, setItemLabel] = useState('');
  const [itemSubmitting, setItemSubmitting] = useState(false);

  /** A partner-wide template is visible to everyone but editable only by a full-partner admin. */
  const canMutate = (tpl: ChecklistTemplate) => tpl.orgId !== null || canManagePartnerWide;

  const load = useCallback(async () => {
    try {
      setTemplates(await listChecklistTemplates(fetchWithAuth, { includeInactive: true }));
    } catch (err) {
      console.error('[TicketChecklistTemplatesPage] failed to load templates', err);
      const message =
        err instanceof ActionError && err.message ? err.message : t('templates.errors.loadFailed');
      setTemplates({ failed: true, message });
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const resetForm = () => {
    setFormName('');
    setFormDescription('');
    setFormInstructions('');
    setFormIsActive(true);
    setFormError(null);
  };

  const openCreate = () => {
    resetForm();
    setSelected(null);
    setFormOwnerScope(defaultOwnerScope);
    setModalMode('create');
  };

  const openEdit = (tpl: ChecklistTemplate) => {
    setSelected(tpl);
    setFormName(tpl.name);
    setFormDescription(tpl.description ?? '');
    setFormInstructions(tpl.instructions ?? '');
    setFormIsActive(tpl.isActive);
    setFormError(null);
    setModalMode('edit');
  };

  const openDelete = (tpl: ChecklistTemplate) => {
    setSelected(tpl);
    setFormError(null);
    setModalMode('delete');
  };

  const closeModal = () => {
    setModalMode('closed');
    setSelected(null);
    resetForm();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = formName.trim();
    if (!name) return;

    setSubmitting(true);
    setFormError(null);
    try {
      const description = formDescription.trim() ? formDescription.trim() : null;
      const instructions = formInstructions.trim() ? formInstructions.trim() : null;

      if (modalMode === 'edit' && selected) {
        // NOTE: no ownerScope in this body. Ownership is create-only — the API
        // rejects it with a 400, so offering it here would promise a re-homing
        // that cannot happen.
        const saved = await runClientAction(
          () =>
            updateChecklistTemplate(fetchWithAuth, selected.id, {
              name,
              description,
              instructions,
              isActive: formIsActive,
            }),
          { errorFallback: t('templates.errors.saveFailed') },
        );
        setTemplates((prev) =>
          Array.isArray(prev) ? prev.map((x) => (x.id === saved.id ? saved : x)) : prev,
        );
      } else {
        const ownerScope: OwnerScope =
          showOwnerScope && formOwnerScope === 'partner' ? 'partner' : 'organization';
        // currentOrgId can be null during the org-context unresolved window;
        // omit orgId entirely rather than send a literal null, which the schema
        // (`orgId` is `.optional()`, not `.nullable()`) would reject.
        const orgId = ownerScope === 'organization' && currentOrgId ? currentOrgId : undefined;
        const created = await runClientAction(
          () =>
            createChecklistTemplate(fetchWithAuth, {
              ownerScope,
              ...(orgId ? { orgId } : {}),
              name,
              description,
              instructions,
              items: [],
            }),
          { errorFallback: t('templates.errors.saveFailed') },
        );
        setTemplates((prev) => (Array.isArray(prev) ? [...prev, created] : [created]));
      }
      closeModal();
    } catch (err) {
      // A 403 PARTNER_WIDE_WRITE_DENIED must be VISIBLE, not a silent no-op.
      if (err instanceof ActionError && err.status !== 401) setFormError(err.message);
      handleActionError(err, t('templates.errors.saveFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await runClientAction(() => deleteChecklistTemplate(fetchWithAuth, selected.id), {
        errorFallback: t('templates.errors.saveFailed'),
      });
      setTemplates((prev) => (Array.isArray(prev) ? prev.filter((x) => x.id !== selected.id) : prev));
      closeModal();
    } catch (err) {
      if (err instanceof ActionError && err.status !== 401) setFormError(err.message);
      handleActionError(err, t('templates.errors.saveFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const applyItem = (templateId: string, item: ChecklistTemplateItem, remove = false) => {
    setTemplates((prev) => {
      if (!Array.isArray(prev)) return prev;
      return prev.map((tpl) => {
        if (tpl.id !== templateId) return tpl;
        const items = remove
          ? tpl.items.filter((i) => i.id !== item.id)
          : [...tpl.items, item];
        return { ...tpl, items };
      });
    });
  };

  const handleAddItem = async (e: React.FormEvent, tpl: ChecklistTemplate) => {
    e.preventDefault();
    const label = itemLabel.trim();
    if (!label) return;
    setItemSubmitting(true);
    try {
      const saved = await runClientAction(
        () =>
          addChecklistTemplateItem(fetchWithAuth, tpl.id, {
            label,
            sortOrder: tpl.items.length,
          }),
        { errorFallback: t('templates.errors.saveFailed') },
      );
      applyItem(tpl.id, saved);
      setItemLabel('');
      setItemEditor(null);
    } catch (err) {
      handleActionError(err, t('templates.errors.saveFailed'));
    } finally {
      setItemSubmitting(false);
    }
  };

  const handleRemoveItem = async (templateId: string, item: ChecklistTemplateItem) => {
    try {
      await runClientAction(() => removeChecklistTemplateItem(fetchWithAuth, item.id), {
        errorFallback: t('templates.errors.saveFailed'),
      });
      applyItem(templateId, item, true);
    } catch (err) {
      handleActionError(err, t('templates.errors.saveFailed'));
    }
  };

  if (templates === null) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="checklist-templates-page">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('templates.title')}</h1>
          <p className="text-muted-foreground">{t('templates.subtitle')}</p>
        </div>
        <button
          type="button"
          data-testid="checklist-template-add"
          onClick={openCreate}
          className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          {t('templates.create')}
        </button>
      </div>

      {!Array.isArray(templates) ? (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          data-testid="checklist-templates-error"
        >
          {templates.message}
        </div>
      ) : templates.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center">
          <ListChecks className="mx-auto h-12 w-12 text-muted-foreground" />
          <p className="mt-4 text-sm text-muted-foreground">{t('templates.empty')}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {templates.map((tpl) => (
            <div
              key={tpl.id}
              className="rounded-lg border bg-card"
              data-testid={`checklist-template-${tpl.id}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
                <div className="font-medium">
                  {tpl.name}
                  {tpl.orgId === null && (
                    <span
                      data-testid="checklist-template-all-orgs-badge"
                      className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary"
                    >
                      {t('templates.allOrganizations')}
                    </span>
                  )}
                  {!tpl.isActive && (
                    <span
                      data-testid={`checklist-template-inactive-${tpl.id}`}
                      className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                    >
                      {t('templates.isActive')}
                    </span>
                  )}
                  {tpl.description && (
                    <p className="text-xs font-normal text-muted-foreground">{tpl.description}</p>
                  )}
                </div>
                {canMutate(tpl) && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      data-testid={`checklist-template-edit-${tpl.id}`}
                      onClick={() => openEdit(tpl)}
                      className="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                      title={t('actions.edit')}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      data-testid={`checklist-template-delete-${tpl.id}`}
                      onClick={() => openDelete(tpl)}
                      className="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
                      title={t('templates.delete')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>

              <div className="divide-y">
                {tpl.items.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
                    data-testid={`checklist-template-item-${item.id}`}
                  >
                    <span>{item.label}</span>
                    {canMutate(tpl) && (
                      <button
                        type="button"
                        onClick={() => void handleRemoveItem(tpl.id, item)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
                        title={t('templates.delete')}
                        data-testid={`checklist-template-item-remove-${item.id}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                ))}

                {canMutate(tpl) &&
                  (itemEditor?.templateId === tpl.id ? (
                    <form
                      onSubmit={(e) => void handleAddItem(e, tpl)}
                      className="flex items-center gap-2 px-4 py-3"
                      data-testid="checklist-template-item-form"
                    >
                      <input
                        aria-label={t('templates.stepLabelPlaceholder')}
                        data-testid="checklist-template-item-label"
                        className={inputClass}
                        value={itemLabel}
                        onChange={(e) => setItemLabel(e.target.value)}
                        maxLength={500}
                      />
                      <button
                        type="submit"
                        data-testid="checklist-template-item-submit"
                        disabled={itemSubmitting || !itemLabel.trim()}
                        className="h-9 shrink-0 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
                      >
                        {t('templates.save')}
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      data-testid={`checklist-template-add-step-${tpl.id}`}
                      onClick={() => {
                        setItemLabel('');
                        setItemEditor({ templateId: tpl.id });
                      }}
                      className="w-full px-4 py-2 text-left text-sm text-muted-foreground hover:text-foreground"
                    >
                      {t('templates.addStep')}
                    </button>
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {(modalMode === 'create' || modalMode === 'edit') && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4">
          <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-lg">
            <h2 className="text-lg font-semibold">
              {modalMode === 'create' ? t('templates.create') : t('actions.edit')}
            </h2>
            <form onSubmit={(e) => void handleSubmit(e)} className="mt-4 space-y-3">
              <div>
                <label htmlFor={`${uid}-name`} className={labelClass}>
                  {t('templates.name')}
                </label>
                <input
                  id={`${uid}-name`}
                  data-testid="checklist-template-name"
                  className={inputClass}
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  maxLength={200}
                />
              </div>

              <div>
                <label htmlFor={`${uid}-description`} className={labelClass}>
                  {t('templates.description')}
                </label>
                <textarea
                  id={`${uid}-description`}
                  data-testid="checklist-template-description"
                  className={inputClass}
                  rows={2}
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  maxLength={2000}
                />
              </div>

              <div>
                <label htmlFor={`${uid}-instructions`} className={labelClass}>
                  {t('templates.instructions')}
                </label>
                <textarea
                  id={`${uid}-instructions`}
                  data-testid="checklist-template-instructions"
                  className={inputClass}
                  rows={3}
                  value={formInstructions}
                  onChange={(e) => setFormInstructions(e.target.value)}
                  maxLength={10000}
                />
                <p
                  className="mt-1 text-xs text-muted-foreground"
                  data-testid="checklist-template-instructions-hint"
                >
                  {t('templates.instructionsHint')}
                </p>
              </div>

              {modalMode === 'edit' && (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    data-testid="checklist-template-active"
                    checked={formIsActive}
                    onChange={(e) => setFormIsActive(e.target.checked)}
                  />
                  {t('templates.isActive')}
                </label>
              )}

              {/* Create-only, and only for a partner admin. Ownership cannot be
                  changed afterwards, so a selector on edit would promise a
                  re-homing the API refuses with a 400. */}
              {modalMode === 'create' && showOwnerScope && (
                <fieldset
                  className="space-y-2 rounded-md border p-3"
                  data-testid="checklist-template-owner"
                >
                  <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
                    {t('templates.scope')}
                  </legend>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="checklistTemplateOwnerScope"
                      value="partner"
                      data-testid="checklist-template-owner-partner"
                      checked={formOwnerScope === 'partner'}
                      onChange={() => setFormOwnerScope('partner')}
                    />
                    {t('templates.allOrganizations')}
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="checklistTemplateOwnerScope"
                      value="organization"
                      data-testid="checklist-template-owner-org"
                      checked={formOwnerScope === 'organization'}
                      onChange={() => setFormOwnerScope('organization')}
                    />
                    {t('templates.thisOrganizationOnly')}
                  </label>
                  <p className="text-xs text-muted-foreground">{t('templates.partnerWideHint')}</p>
                </fieldset>
              )}

              {formError && (
                <div
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  data-testid="checklist-template-form-error"
                >
                  {formError}
                </div>
              )}

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={closeModal}
                  className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground hover:text-foreground"
                >
                  {t('templates.cancel')}
                </button>
                <button
                  type="submit"
                  data-testid="checklist-template-submit"
                  disabled={submitting || !formName.trim()}
                  className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {t('templates.save')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {modalMode === 'delete' && selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
            <h2 className="text-lg font-semibold">{t('templates.delete')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{selected.name}</p>

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
                {t('templates.cancel')}
              </button>
              <button
                type="button"
                data-testid="checklist-template-delete-confirm"
                onClick={() => void handleDelete()}
                disabled={submitting}
                className="h-10 rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-50"
              >
                {t('templates.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
