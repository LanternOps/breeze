import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ticketFormFieldsSchema,
  TICKET_FORM_FIELD_TYPES,
  type TicketFormField,
  type TicketFormFieldType
} from '@breeze/shared';
import { Globe } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '@/lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import TicketFormFields from '../tickets/TicketFormFields';

interface TicketForm {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  name: string;
  description: string | null;
  categoryId: string | null;
  fields: TicketFormField[];
  titleTemplate: string | null;
  descriptionIntro: string | null;
  defaultPriority: string | null;
  // Partner-wide allowlist: null (or absent) = visible to all the partner's orgs;
  // a non-empty array = only those orgs. Never `[]` (server normalizes empty → null).
  visibleOrgIds?: string[] | null;
  showInPortal: boolean;
  isActive: boolean;
  sortOrder: number;
}

interface OrgOption {
  id: string;
  name: string;
}
interface CategoryOption {
  id: string;
  name: string;
  isActive?: boolean;
}

// Editor field row: `key` is DERIVED from the label (admins never hand-author
// keys), so the draft stores label/type/options-as-text and we compute keys at
// build time.
interface DraftField {
  label: string;
  type: TicketFormFieldType;
  required: boolean;
  helpText: string;
  placeholder: string;
  optionsText: string; // one option per line (select only)
  expanded: boolean;
}

interface FormDraft {
  name: string;
  description: string;
  categoryId: string;
  ownerScope: 'partner' | 'organization';
  orgId: string;
  // Partner-wide allowlist editor state. `limitOrgs` unchecked → save `null` (all
  // orgs); checked → `visibleOrgIds` (min 1, enforced client-side — never send `[]`).
  limitOrgs: boolean;
  visibleOrgIds: string[];
  fields: DraftField[];
  titleTemplate: string;
  descriptionIntro: string;
  defaultPriority: string;
  showInPortal: boolean;
  isActive: boolean;
  sortOrder: number;
}

type Editing = { id?: string; draft: FormDraft } | null;

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

const EMPTY_FIELD: DraftField = {
  label: '',
  type: 'text',
  required: false,
  helpText: '',
  placeholder: '',
  optionsText: '',
  expanded: false
};

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

function slugifyKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '')
    .slice(0, 50);
}

/** Derive unique field keys from labels; collisions get a `_2`, `_3`… suffix. */
function deriveKeys(labels: string[]): string[] {
  const used = new Set<string>();
  return labels.map((label) => {
    const base = slugifyKey(label) || 'field';
    let key = base;
    let n = 2;
    while (used.has(key)) {
      const suffix = `_${n++}`;
      key = base.slice(0, 50 - suffix.length) + suffix;
    }
    used.add(key);
    return key;
  });
}

/** Build the shared TicketFormField[] (with derived keys) from the draft rows. */
function buildFields(fields: DraftField[]): TicketFormField[] {
  const keys = deriveKeys(fields.map((f) => f.label));
  return fields.map((f, i) => {
    const field: TicketFormField = {
      key: keys[i],
      label: f.label.trim(),
      type: f.type,
      required: f.required
    };
    if (f.helpText.trim()) field.helpText = f.helpText.trim();
    if (f.placeholder.trim()) field.placeholder = f.placeholder.trim();
    if (f.type === 'select') {
      const opts = f.optionsText
        .split('\n')
        .map((o) => o.trim())
        .filter(Boolean);
      if (opts.length) field.options = opts;
    }
    return field;
  });
}

function draftFromForm(form: TicketForm): FormDraft {
  return {
    name: form.name,
    description: form.description ?? '',
    categoryId: form.categoryId ?? '',
    // Ownership is immutable on edit; seed something valid but the fieldset is hidden.
    ownerScope: form.orgId === null ? 'partner' : 'organization',
    orgId: form.orgId ?? '',
    limitOrgs: form.visibleOrgIds != null,
    visibleOrgIds: form.visibleOrgIds ?? [],
    fields: form.fields.map((f) => ({
      label: f.label,
      type: f.type,
      required: f.required,
      helpText: f.helpText ?? '',
      placeholder: f.placeholder ?? '',
      optionsText: (f.options ?? []).join('\n'),
      expanded: false
    })),
    titleTemplate: form.titleTemplate ?? '',
    descriptionIntro: form.descriptionIntro ?? '',
    defaultPriority: form.defaultPriority ?? '',
    showInPortal: form.showInPortal,
    isActive: form.isActive,
    sortOrder: form.sortOrder
  };
}

function emptyDraft(): FormDraft {
  return {
    name: '',
    description: '',
    categoryId: '',
    ownerScope: 'partner',
    orgId: '',
    limitOrgs: false,
    visibleOrgIds: [],
    fields: [],
    titleTemplate: '',
    descriptionIntro: '',
    defaultPriority: '',
    showInPortal: true,
    isActive: true,
    sortOrder: 0
  };
}

const inputCls = 'w-full rounded-md border bg-background px-2.5 py-1.5 text-sm';

export default function TicketFormsCard() {
  const [forms, setForms] = useState<TicketForm[]>([]);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [orgsLoadFailed, setOrgsLoadFailed] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [saving, setSaving] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
  const [previewValues, setPreviewValues] = useState<Record<string, unknown>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    setOrgsLoadFailed(false);
    // allSettled so a REJECTED optional fetch (network error) degrades the same
    // as a non-ok response — only the forms list is allowed to hard-fail.
    const [formsR, catsR, orgsR] = await Promise.allSettled([
      fetchWithAuth('/ticket-forms'),
      fetchWithAuth('/ticket-categories'),
      fetchWithAuth('/orgs/organizations?limit=100')
    ]);
    // The forms list is the critical resource — a rejection OR non-ok is a hard error.
    if (formsR.status !== 'fulfilled' || !formsR.value.ok) {
      setError(true);
      setLoading(false);
      return;
    }
    const formsBody = (await formsR.value.json()) as { data?: TicketForm[] };
    setForms(formsBody.data ?? []);
    // Categories / orgs are editor option lists — degrade to empty on rejection
    // OR non-ok, never hard-failing the card.
    if (catsR.status === 'fulfilled' && catsR.value.ok) {
      const b = (await catsR.value.json()) as { data?: CategoryOption[] };
      setCategories((b.data ?? []).filter((c) => c.isActive !== false));
    } else {
      console.warn(
        '[ticket-forms] categories failed to load; editor category list will be empty',
        catsR.status === 'rejected' ? catsR.reason : catsR.value.status
      );
      setCategories([]);
    }
    if (orgsR.status === 'fulfilled' && orgsR.value.ok) {
      const b = (await orgsR.value.json()) as { data?: OrgOption[] };
      setOrgs(b.data ?? []);
    } else {
      console.warn(
        '[ticket-forms] organizations failed to load; org-scoped form creation is blocked',
        orgsR.status === 'rejected' ? orgsR.reason : orgsR.value.status
      );
      setOrgs([]);
      setOrgsLoadFailed(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openNew = () => {
    setIssues([]);
    setPreviewValues({});
    setConfirmDeleteId(null);
    setEditing({ draft: emptyDraft() });
  };
  const openEdit = (form: TicketForm) => {
    setIssues([]);
    setPreviewValues({});
    setConfirmDeleteId(null);
    setEditing({ id: form.id, draft: draftFromForm(form) });
  };
  const closeEditor = () => {
    setEditing(null);
    setIssues([]);
  };

  const patchDraft = (patch: Partial<FormDraft>) =>
    setEditing((e) => (e ? { ...e, draft: { ...e.draft, ...patch } } : e));
  const patchField = (i: number, patch: Partial<DraftField>) =>
    setEditing((e) =>
      e ? { ...e, draft: { ...e.draft, fields: e.draft.fields.map((f, idx) => (idx === i ? { ...f, ...patch } : f)) } } : e
    );
  const addField = () =>
    setEditing((e) => (e ? { ...e, draft: { ...e.draft, fields: [...e.draft.fields, { ...EMPTY_FIELD }] } } : e));
  const removeField = (i: number) =>
    setEditing((e) => (e ? { ...e, draft: { ...e.draft, fields: e.draft.fields.filter((_, idx) => idx !== i) } } : e));
  const moveField = (i: number, dir: -1 | 1) =>
    setEditing((e) => {
      if (!e) return e;
      const j = i + dir;
      if (j < 0 || j >= e.draft.fields.length) return e;
      const next = [...e.draft.fields];
      [next[i], next[j]] = [next[j], next[i]];
      return { ...e, draft: { ...e.draft, fields: next } };
    });
  // Toggle an org in the partner-wide allowlist; preserves click order so the
  // saved array matches selection order.
  const toggleVisibleOrg = (id: string) =>
    setEditing((e) => {
      if (!e) return e;
      const next = e.draft.visibleOrgIds.includes(id)
        ? e.draft.visibleOrgIds.filter((x) => x !== id)
        : [...e.draft.visibleOrgIds, id];
      return { ...e, draft: { ...e.draft, visibleOrgIds: next } };
    });

  // Derived keys + built fields for the current draft (drives read-only key labels + preview).
  const draft = editing?.draft;
  const derivedKeys = useMemo(() => (draft ? deriveKeys(draft.fields.map((f) => f.label)) : []), [draft]);
  const previewFields = useMemo(() => (draft ? buildFields(draft.fields) : []), [draft]);

  const save = useCallback(async () => {
    if (!editing || saving) return;
    const d = editing.draft;
    const localIssues: string[] = [];
    if (!d.name.trim()) localIssues.push('Name is required.');
    // Org-scoped create needs an org. If orgs FAILED to load, the inline
    // `ticket-form-orgs-error` notice (with retry) is the honest feedback — emit
    // the "select an org" line only when orgs are actually available to pick.
    const orgScopeNeedsOrg = editing.id === undefined && d.ownerScope === 'organization' && !d.orgId;
    const orgScopeBlockedByLoad = orgScopeNeedsOrg && orgsLoadFailed;
    if (orgScopeNeedsOrg && !orgsLoadFailed) {
      localIssues.push('Select an organization for an organization-scoped form.');
    }
    // Allowlist is only meaningful on partner-wide forms. Checked-but-empty is
    // unrepresentable: force a choice rather than silently sending null/[].
    if (d.ownerScope === 'partner' && d.limitOrgs && d.visibleOrgIds.length === 0) {
      localIssues.push('Select at least one organization or uncheck "Limit to specific organizations".');
    }
    const built = buildFields(d.fields);
    const parsed = ticketFormFieldsSchema.safeParse(built);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.length ? `Field ${issue.path.join('.')}: ` : '';
        localIssues.push(`${path}${issue.message}`);
      }
    }
    // Title-template typo guard: every {{token}} must name a derived field key,
    // else the rendered ticket title silently drops it. Cheap, deterministic.
    if (d.titleTemplate.trim()) {
      const keys = new Set(built.map((f) => f.key));
      const seen = new Set<string>();
      for (const m of d.titleTemplate.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
        const token = m[1];
        if (!token || keys.has(token) || seen.has(token)) continue;
        seen.add(token);
        localIssues.push(
          `Title template references unknown field "{{${token}}}". Available keys: ${built.map((f) => f.key).join(', ') || 'none'}.`
        );
      }
    }
    if (localIssues.length) {
      setIssues(localIssues);
      return;
    }
    // Org-scope create blocked purely because orgs couldn't load: block the POST
    // (the inline notice already explains why) without a misleading issue line.
    if (orgScopeBlockedByLoad) {
      setIssues([]);
      return;
    }
    setIssues([]);
    setSaving(true);

    const isCreate = editing.id === undefined;
    const base: Record<string, unknown> = {
      name: d.name.trim(),
      fields: built,
      showInPortal: d.showInPortal,
      isActive: d.isActive,
      sortOrder: d.sortOrder
    };
    // Clearable optionals: on CREATE, empty means "not set" — omit the key.
    // On EDIT, the update schema is .partial(), so an omitted key silently
    // keeps the stored value — a cleared input must send an explicit null.
    const setOptional = (key: string, value: string) => {
      const v = value.trim();
      if (v) base[key] = v;
      else if (!isCreate) base[key] = null;
    };
    setOptional('description', d.description);
    setOptional('categoryId', d.categoryId);
    setOptional('titleTemplate', d.titleTemplate);
    setOptional('descriptionIntro', d.descriptionIntro);
    setOptional('defaultPriority', d.defaultPriority);

    // Allowlist only on partner-wide forms (both create and edit; for edit,
    // ownerScope is derived from orgId === null). Unchecked → null (all orgs);
    // checked → the selected ids. Org-owned forms never carry the key (API 400s).
    if (d.ownerScope === 'partner') {
      base.visibleOrgIds = d.limitOrgs ? d.visibleOrgIds : null;
    }

    // CREATE also sends the immutable ownership axis; UPDATE (schema is
    // .partial()) sends only the mutable base.
    const request = isCreate
      ? () => {
          const body: Record<string, unknown> = { ...base, ownerScope: d.ownerScope };
          if (d.ownerScope === 'organization') body.orgId = d.orgId;
          return fetchWithAuth('/ticket-forms', { method: 'POST', body: JSON.stringify(body) });
        }
      : () => fetchWithAuth(`/ticket-forms/${editing.id}`, { method: 'PUT', body: JSON.stringify(base) });
    try {
      await runAction({
        request,
        successMessage: 'Form saved',
        errorFallback: 'Failed to save form. Retry.',
        onUnauthorized: UNAUTHORIZED
      });
      closeEditor();
      await load();
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
      // ActionError already surfaced a toast via runAction; keep the editor open.
    } finally {
      setSaving(false);
    }
  }, [editing, saving, load, orgsLoadFailed]);

  const remove = useCallback(
    async (id: string) => {
      if (confirmDeleteId !== id) {
        setConfirmDeleteId(id);
        return;
      }
      setConfirmDeleteId(null);
      try {
        await runAction({
          request: () => fetchWithAuth(`/ticket-forms/${id}`, { method: 'DELETE' }),
          successMessage: 'Form deleted',
          errorFallback: 'Failed to delete form.',
          onUnauthorized: UNAUTHORIZED
        });
        await load();
      } catch (err) {
        if (!(err instanceof ActionError)) throw err;
      }
    },
    [confirmDeleteId, load]
  );

  return (
    <div className="max-w-4xl" data-testid="ticket-forms-card">
      <section className="rounded-lg border p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">Intake forms</h2>
            <p className="text-xs text-muted-foreground">
              Custom fields collected when a ticket is created. Share one form across all organizations or scope it to a
              single org.
            </p>
          </div>
          <button
            type="button"
            onClick={openNew}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white"
            data-testid="ticket-form-create"
          >
            New form
          </button>
        </div>

        {editing && draft && (
          <div className="mb-4 rounded-md border bg-muted/20 p-3" data-testid="ticket-form-editor">
            <div className="grid gap-4 md:grid-cols-2">
              {/* Left column: form metadata + field editor */}
              <div className="space-y-3">
                {editing.id === undefined && (
                  <fieldset className="space-y-2 rounded-md border p-3" data-testid="ticket-form-owner">
                    <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">Scope</legend>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name="ticket-form-owner-scope"
                        value="partner"
                        checked={draft.ownerScope === 'partner'}
                        onChange={() => patchDraft({ ownerScope: 'partner' })}
                        data-testid="ticket-form-owner-partner"
                      />
                      All organizations <span className="text-muted-foreground">(partner-wide)</span>
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name="ticket-form-owner-scope"
                        value="organization"
                        checked={draft.ownerScope === 'organization'}
                        onChange={() => patchDraft({ ownerScope: 'organization' })}
                        data-testid="ticket-form-owner-org"
                      />
                      This organization only
                    </label>
                    {draft.ownerScope === 'organization' && (
                      <select
                        className={inputCls}
                        value={draft.orgId}
                        onChange={(e) => patchDraft({ orgId: e.target.value })}
                        data-testid="ticket-form-owner-org-select"
                      >
                        <option value="">Select an organization…</option>
                        {orgs.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name}
                          </option>
                        ))}
                      </select>
                    )}
                    {/* This testid is reused below in the partner-wide Visibility
                        fieldset (same string, both instances). That's unambiguous
                        for tests to target: ownerScope is XOR, so only one of the
                        two owner-scope sections ever renders at a time — never
                        both `ticket-form-orgs-error` nodes simultaneously. */}
                    {draft.ownerScope === 'organization' && orgsLoadFailed && (
                      <p className="text-xs text-destructive" data-testid="ticket-form-orgs-error">
                        Organizations failed to load, so an org-scoped form can't be created yet.{' '}
                        <button
                          type="button"
                          onClick={() => void load()}
                          className="underline hover:text-foreground"
                          data-testid="ticket-form-orgs-retry"
                        >
                          Retry
                        </button>
                      </p>
                    )}
                  </fieldset>
                )}

                {/* Org allowlist — partner-wide forms only (create with partner
                    scope, or editing a partner-wide row where orgId === null). */}
                {draft.ownerScope === 'partner' && (
                  <fieldset className="space-y-2 rounded-md border p-3" data-testid="ticket-form-visibility">
                    <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">Visibility</legend>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border"
                        checked={draft.limitOrgs}
                        onChange={(e) => patchDraft({ limitOrgs: e.target.checked })}
                        data-testid="ticket-form-limit-orgs"
                      />
                      Limit to specific organizations
                    </label>
                    {draft.limitOrgs &&
                      (orgsLoadFailed ? (
                        <p className="text-xs text-destructive" data-testid="ticket-form-orgs-error">
                          Organizations failed to load, so the allowlist can't be edited yet.{' '}
                          <button
                            type="button"
                            onClick={() => void load()}
                            className="underline hover:text-foreground"
                            data-testid="ticket-form-orgs-retry"
                          >
                            Retry
                          </button>
                        </p>
                      ) : (
                        <div className="space-y-1" data-testid="ticket-form-visible-orgs">
                          {orgs.map((o) => (
                            <label key={o.id} className="flex items-center gap-2 text-sm">
                              <input
                                type="checkbox"
                                className="h-4 w-4 rounded border"
                                checked={draft.visibleOrgIds.includes(o.id)}
                                onChange={() => toggleVisibleOrg(o.id)}
                                data-testid={`ticket-form-visible-org-${o.id}`}
                              />
                              {o.name}
                            </label>
                          ))}
                        </div>
                      ))}
                  </fieldset>
                )}

                <div>
                  <label className="mb-1 block text-sm font-medium" htmlFor="ticket-form-name">
                    Name
                  </label>
                  <input
                    id="ticket-form-name"
                    className={inputCls}
                    value={draft.name}
                    onChange={(e) => patchDraft({ name: e.target.value })}
                    data-testid="ticket-form-name"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium" htmlFor="ticket-form-description">
                    Description <span className="text-muted-foreground">(optional)</span>
                  </label>
                  <input
                    id="ticket-form-description"
                    className={inputCls}
                    value={draft.description}
                    onChange={(e) => patchDraft({ description: e.target.value })}
                    data-testid="ticket-form-description"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium" htmlFor="ticket-form-category">
                    Category <span className="text-muted-foreground">(optional)</span>
                  </label>
                  <select
                    id="ticket-form-category"
                    className={inputCls}
                    value={draft.categoryId}
                    onChange={(e) => patchDraft({ categoryId: e.target.value })}
                    data-testid="ticket-form-category"
                  >
                    <option value="">No category</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium" htmlFor="ticket-form-title-template">
                    Title template <span className="text-muted-foreground">(optional)</span>
                  </label>
                  <input
                    id="ticket-form-title-template"
                    className={inputCls}
                    value={draft.titleTemplate}
                    onChange={(e) => patchDraft({ titleTemplate: e.target.value })}
                    data-testid="ticket-form-title-template"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">Use {'{{field_key}}'} to insert responses.</p>
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium" htmlFor="ticket-form-description-intro">
                    Description intro <span className="text-muted-foreground">(optional)</span>
                  </label>
                  <textarea
                    id="ticket-form-description-intro"
                    className={inputCls}
                    rows={2}
                    value={draft.descriptionIntro}
                    onChange={(e) => patchDraft({ descriptionIntro: e.target.value })}
                    data-testid="ticket-form-description-intro"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium" htmlFor="ticket-form-priority">
                    Default priority <span className="text-muted-foreground">(optional)</span>
                  </label>
                  <select
                    id="ticket-form-priority"
                    className={inputCls}
                    value={draft.defaultPriority}
                    onChange={(e) => patchDraft({ defaultPriority: e.target.value })}
                    data-testid="ticket-form-priority"
                  >
                    <option value="">No default</option>
                    {PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-wrap gap-4">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border"
                      checked={draft.showInPortal}
                      onChange={(e) => patchDraft({ showInPortal: e.target.checked })}
                      data-testid="ticket-form-portal"
                    />
                    Show in portal
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border"
                      checked={draft.isActive}
                      onChange={(e) => patchDraft({ isActive: e.target.checked })}
                      data-testid="ticket-form-active"
                    />
                    Active
                  </label>
                </div>

                {/* Field editor */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold">Fields</h3>
                    <button
                      type="button"
                      onClick={addField}
                      className="rounded-md border px-2 py-1 text-xs"
                      data-testid="ticket-form-field-add"
                    >
                      Add field
                    </button>
                  </div>
                  {draft.fields.length === 0 && (
                    <p className="text-xs text-muted-foreground" data-testid="ticket-form-fields-empty">
                      No fields yet. Add one to start collecting responses.
                    </p>
                  )}
                  {draft.fields.map((f, i) => (
                    <div key={i} className="rounded-md border bg-background p-2" data-testid={`ticket-form-field-row-${i}`}>
                      <div className="flex items-center gap-2">
                        <input
                          className={inputCls}
                          placeholder="Field label"
                          aria-label="Field label"
                          value={f.label}
                          onChange={(e) => patchField(i, { label: e.target.value })}
                          data-testid={`ticket-form-field-label-${i}`}
                        />
                        <select
                          className="rounded-md border bg-background px-2 py-1.5 text-sm"
                          aria-label="Field type"
                          value={f.type}
                          onChange={(e) => patchField(i, { type: e.target.value as TicketFormFieldType })}
                          data-testid={`ticket-form-field-type-${i}`}
                        >
                          {TICKET_FORM_FIELD_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-2">
                        <code className="text-xs text-muted-foreground" data-testid={`ticket-form-field-key-${i}`}>
                          key: {derivedKeys[i]}
                        </code>
                        <div className="flex items-center gap-2 text-xs">
                          <label className="flex items-center gap-1">
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5 rounded border"
                              checked={f.required}
                              onChange={(e) => patchField(i, { required: e.target.checked })}
                              data-testid={`ticket-form-field-required-${i}`}
                            />
                            Required
                          </label>
                          <button
                            type="button"
                            onClick={() => moveField(i, -1)}
                            disabled={i === 0}
                            className="rounded border px-1.5 py-0.5 disabled:opacity-40"
                            data-testid={`ticket-form-field-up-${i}`}
                            aria-label="Move field up"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            onClick={() => moveField(i, 1)}
                            disabled={i === draft.fields.length - 1}
                            className="rounded border px-1.5 py-0.5 disabled:opacity-40"
                            data-testid={`ticket-form-field-down-${i}`}
                            aria-label="Move field down"
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            onClick={() => patchField(i, { expanded: !f.expanded })}
                            className="rounded border px-1.5 py-0.5"
                            data-testid={`ticket-form-field-expand-${i}`}
                          >
                            {f.expanded ? 'Less' : 'More'}
                          </button>
                          <button
                            type="button"
                            onClick={() => removeField(i)}
                            className="rounded border px-1.5 py-0.5 text-destructive"
                            data-testid={`ticket-form-field-remove-${i}`}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                      {f.expanded && (
                        <div className="mt-2 space-y-2">
                          <input
                            className={inputCls}
                            placeholder="Help text (optional)"
                            value={f.helpText}
                            onChange={(e) => patchField(i, { helpText: e.target.value })}
                            data-testid={`ticket-form-field-help-${i}`}
                          />
                          <input
                            className={inputCls}
                            placeholder="Placeholder (optional)"
                            value={f.placeholder}
                            onChange={(e) => patchField(i, { placeholder: e.target.value })}
                            data-testid={`ticket-form-field-placeholder-${i}`}
                          />
                          {f.type === 'select' && (
                            <textarea
                              className={inputCls}
                              rows={3}
                              placeholder="One option per line"
                              value={f.optionsText}
                              onChange={(e) => patchField(i, { optionsText: e.target.value })}
                              data-testid={`ticket-form-field-options-${i}`}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Right column: live preview using the SHARED renderer */}
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">Preview</h3>
                <div className="rounded-md border bg-background p-3" data-testid="ticket-form-preview">
                  {previewFields.length === 0 ? (
                    <p className="text-xs text-muted-foreground">Add fields to see a preview.</p>
                  ) : (
                    <TicketFormFields
                      fields={previewFields}
                      values={previewValues}
                      errors={{}}
                      onChange={(key, value) => setPreviewValues((v) => ({ ...v, [key]: value }))}
                    />
                  )}
                </div>
              </div>
            </div>

            {issues.length > 0 && (
              <ul className="mt-3 list-inside list-disc text-xs text-destructive" data-testid="ticket-form-issues">
                {issues.map((msg, i) => (
                  <li key={i}>{msg}</li>
                ))}
              </ul>
            )}

            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                data-testid="ticket-form-save"
              >
                {saving ? 'Saving' : 'Save'}
              </button>
              <button
                type="button"
                onClick={closeEditor}
                disabled={saving}
                className="rounded-md border px-3 py-1.5 text-sm"
                data-testid="ticket-form-cancel"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <p className="text-center text-sm text-muted-foreground" data-testid="ticket-forms-loading">
            Loading.
          </p>
        ) : error ? (
          <p className="text-center text-sm text-muted-foreground" data-testid="ticket-forms-error">
            Failed to load intake forms.{' '}
            <button
              type="button"
              onClick={() => void load()}
              className="underline hover:text-foreground"
              data-testid="ticket-forms-retry"
            >
              Retry
            </button>
          </p>
        ) : forms.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="ticket-forms-empty">
            No intake forms yet. Create one to collect structured details on new tickets.
          </p>
        ) : (
          <ul className="divide-y">
            {forms.map((form) => (
              <li
                key={form.id}
                className="flex items-start justify-between gap-3 py-2"
                data-testid={`ticket-form-row-${form.id}`}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <span>{form.name}</span>
                    {form.orgId === null &&
                      (form.visibleOrgIds == null ? (
                        <span
                          className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                          title="Partner-wide form — available to every organization"
                          data-testid={`ticket-form-all-orgs-${form.id}`}
                        >
                          <Globe className="h-3 w-3" />
                          All orgs
                        </span>
                      ) : (
                        <span
                          className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                          title="Partner-wide form limited to specific organizations"
                          data-testid={`ticket-form-org-count-${form.id}`}
                        >
                          <Globe className="h-3 w-3" />
                          {form.visibleOrgIds.length} org{form.visibleOrgIds.length === 1 ? '' : 's'}
                        </span>
                      ))}
                    {form.showInPortal && (
                      <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">Portal</span>
                    )}
                    {!form.isActive && (
                      <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">Inactive</span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {form.fields.length} field{form.fields.length === 1 ? '' : 's'}
                    {form.categoryId
                      ? ` · ${categories.find((c) => c.id === form.categoryId)?.name ?? 'Category'}`
                      : ''}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2 text-sm">
                  <button
                    type="button"
                    onClick={() => openEdit(form)}
                    className="text-muted-foreground hover:text-foreground"
                    data-testid={`ticket-form-edit-${form.id}`}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(form.id)}
                    className="text-muted-foreground hover:text-foreground"
                    data-testid={`ticket-form-delete-${form.id}`}
                  >
                    {confirmDeleteId === form.id ? 'Confirm delete' : 'Delete'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
