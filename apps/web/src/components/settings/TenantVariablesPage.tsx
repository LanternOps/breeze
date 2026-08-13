import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { KeyRound, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import type { TenantVariable } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, runAction } from '@/lib/runAction';
import { loginPathWithNext } from '@/lib/authScope';
import { navigateTo } from '@/lib/navigation';
import { useDefaultOwnerScope, type OwnerScope } from '@/hooks/useDefaultOwnerScope';
import { useOrgScope } from '@/hooks/useOrgScope';

interface Draft {
  key: string;
  value: string;
  isSecret: boolean;
  description: string;
  ownerScope: OwnerScope;
}

type Editing = { id?: string; original?: TenantVariable; draft: Draft } | null;

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });
const KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const inputCls = 'w-full rounded-md border bg-background px-2.5 py-1.5 text-sm';

function emptyDraft(ownerScope: OwnerScope): Draft {
  return { key: '', value: '', isSecret: false, description: '', ownerScope };
}

function draftFrom(variable: TenantVariable): Draft {
  return {
    key: variable.key,
    // Always blank on edit: a secret is never sent to the client, and leaving
    // the field empty is what keeps the stored value untouched.
    value: '',
    isSecret: variable.isSecret,
    description: variable.description ?? '',
    ownerScope: variable.ownerScope
  };
}

/**
 * Tenant variables management (#3409). A variable is defined once — for one
 * org or for every org under the partner — and referenced from scripts.
 */
export default function TenantVariablesPage() {
  const { t } = useTranslation('settings');
  const { isPartnerScope, defaultOwnerScope } = useDefaultOwnerScope();
  const orgScope = useOrgScope();

  const [variables, setVariables] = useState<TenantVariable[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    // fetchWithAuth injects the selected orgId, so this is already scoped to
    // the current org context (plus the partner-wide rows it inherits).
    const response = await fetchWithAuth('/tenant-variables').catch(() => null);
    if (!response || !response.ok) {
      setError(true);
      setLoading(false);
      return;
    }
    const body = (await response.json()) as { data?: TenantVariable[] };
    setVariables(body.data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openNew = () => {
    setIssues([]);
    setConfirmDeleteId(null);
    setEditing({ draft: emptyDraft(isPartnerScope ? defaultOwnerScope : 'organization') });
  };

  const openEdit = (variable: TenantVariable) => {
    setIssues([]);
    setConfirmDeleteId(null);
    setEditing({ id: variable.id, original: variable, draft: draftFrom(variable) });
  };

  const closeEditor = () => {
    setEditing(null);
    setIssues([]);
  };

  const patchDraft = (patch: Partial<Draft>) =>
    setEditing((e) => (e ? { ...e, draft: { ...e.draft, ...patch } } : e));

  const save = useCallback(async () => {
    if (!editing || saving) return;
    const draft = editing.draft;
    const isCreate = editing.id === undefined;
    const problems: string[] = [];

    if (isCreate && !KEY_PATTERN.test(draft.key)) problems.push(t('tenantVariablesPage.issues.key'));
    if (isCreate && !draft.value) problems.push(t('tenantVariablesPage.issues.value'));
    // Turning off "secret" cannot reveal the stored value, so the API demands a
    // replacement — say so here rather than round-tripping for the 400.
    if (!isCreate && editing.original?.isSecret && !draft.isSecret && !draft.value) {
      problems.push(t('tenantVariablesPage.issues.unsecret'));
    }
    if (isCreate && draft.ownerScope === 'organization' && !orgScope.orgId) {
      problems.push(t('tenantVariablesPage.issues.org'));
    }
    if (problems.length > 0) {
      setIssues(problems);
      return;
    }

    setIssues([]);
    setSaving(true);
    const description = draft.description.trim() ? draft.description.trim() : null;

    try {
      await runAction({
        // Kept inline rather than hoisted: the no-silent-mutations guard is a
        // lexical AST check, so a thunk defined outside the runAction(...) call
        // reads as an unwrapped mutation even when passed straight in (#2429).
        request: isCreate
          ? () => {
              const body: Record<string, unknown> = {
                ownerScope: draft.ownerScope,
                key: draft.key,
                value: draft.value,
                isSecret: draft.isSecret,
                description
              };
              if (draft.ownerScope === 'organization') body.orgId = orgScope.orgId;
              return fetchWithAuth('/tenant-variables', { method: 'POST', body: JSON.stringify(body) });
            }
          : () => {
              // Omitting `value` is the no-clobber path — it keeps the stored
              // (encrypted) value, which is the only way to edit a secret.
              const body: Record<string, unknown> = { isSecret: draft.isSecret, description };
              if (draft.value) body.value = draft.value;
              return fetchWithAuth(`/tenant-variables/${editing.id}`, {
                method: 'PUT',
                body: JSON.stringify(body)
              });
            },
        successMessage: t('tenantVariablesPage.toasts.saved'),
        errorFallback: t('tenantVariablesPage.toasts.saveFailed'),
        onUnauthorized: UNAUTHORIZED
      });
      closeEditor();
      await load();
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
      // ActionError already toasted via runAction; keep the editor open.
    } finally {
      setSaving(false);
    }
  }, [editing, saving, load, orgScope.orgId, t]);

  const remove = useCallback(
    async (id: string) => {
      if (confirmDeleteId !== id) {
        setConfirmDeleteId(id);
        return;
      }
      setConfirmDeleteId(null);
      try {
        await runAction({
          request: () => fetchWithAuth(`/tenant-variables/${id}`, { method: 'DELETE' }),
          successMessage: t('tenantVariablesPage.toasts.deleted'),
          errorFallback: t('tenantVariablesPage.toasts.deleteFailed'),
          onUnauthorized: UNAUTHORIZED
        });
        await load();
      } catch (err) {
        if (!(err instanceof ActionError)) throw err;
      }
    },
    [confirmDeleteId, load, t]
  );

  /**
   * An org session may READ the partner-wide variables it inherits but cannot
   * edit them — the API answers 404 for those, so the row actions are hidden
   * rather than offered and then rejected.
   */
  const canManage = (variable: TenantVariable) => variable.ownerScope === 'organization' || isPartnerScope;

  return (
    <div className="space-y-6" data-testid="tenant-variables-page">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('tenantVariablesPage.title')}</h1>
          <p className="text-muted-foreground">{t('tenantVariablesPage.description')}</p>
        </div>
        <button
          type="button"
          onClick={openNew}
          className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
          data-testid="tenant-variable-create-button"
        >
          <Plus className="h-4 w-4" />
          {t('tenantVariablesPage.actions.add')}
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {t('tenantVariablesPage.errors.load')}
        </div>
      )}

      {editing && (
        <section className="rounded-lg border bg-muted/20 p-4" data-testid="tenant-variable-editor">
          <h2 className="mb-3 text-sm font-semibold">
            {editing.id === undefined ? t('tenantVariablesPage.editor.newTitle') : t('tenantVariablesPage.editor.editTitle')}
          </h2>

          {issues.length > 0 && (
            <ul
              className="mb-3 list-disc space-y-1 rounded-md border border-destructive/40 bg-destructive/10 px-6 py-2 text-sm text-destructive"
              data-testid="tenant-variable-issues"
            >
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            {editing.id === undefined && isPartnerScope && (
              <fieldset className="space-y-2 rounded-md border p-3 md:col-span-2" data-testid="tenant-variable-owner-scope">
                <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
                  {t('tenantVariablesPage.editor.scopeLegend')}
                </legend>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="tenant-variable-owner"
                    value="partner"
                    checked={editing.draft.ownerScope === 'partner'}
                    onChange={() => patchDraft({ ownerScope: 'partner' })}
                    data-testid="tenant-variable-owner-partner"
                  />
                  {t('tenantVariablesPage.editor.allOrgs')}{' '}
                  <span className="text-muted-foreground">{t('tenantVariablesPage.editor.allOrgsHint')}</span>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="tenant-variable-owner"
                    value="organization"
                    checked={editing.draft.ownerScope === 'organization'}
                    onChange={() => patchDraft({ ownerScope: 'organization' })}
                    data-testid="tenant-variable-owner-org"
                  />
                  {t('tenantVariablesPage.editor.thisOrg')}
                </label>
              </fieldset>
            )}

            <label className="space-y-1 text-sm">
              <span className="font-medium">{t('tenantVariablesPage.fields.key')}</span>
              <input
                className={inputCls}
                value={editing.draft.key}
                disabled={editing.id !== undefined}
                onChange={(e) => patchDraft({ key: e.target.value })}
                placeholder="s1_site_token"
                data-testid="tenant-variable-key-input"
              />
              <span className="block text-xs text-muted-foreground">
                {editing.id === undefined
                  ? t('tenantVariablesPage.fields.keyHint')
                  : t('tenantVariablesPage.fields.keyImmutable')}
              </span>
            </label>

            <label className="space-y-1 text-sm">
              <span className="font-medium">{t('tenantVariablesPage.fields.value')}</span>
              <input
                className={inputCls}
                type={editing.draft.isSecret ? 'password' : 'text'}
                autoComplete="new-password"
                value={editing.draft.value}
                onChange={(e) => patchDraft({ value: e.target.value })}
                data-testid="tenant-variable-value-input"
              />
              {editing.id !== undefined && (
                <span className="block text-xs text-muted-foreground">
                  {t('tenantVariablesPage.fields.valueKeepHint')}
                </span>
              )}
            </label>

            <label className="space-y-1 text-sm md:col-span-2">
              <span className="font-medium">{t('tenantVariablesPage.fields.description')}</span>
              <input
                className={inputCls}
                value={editing.draft.description}
                onChange={(e) => patchDraft({ description: e.target.value })}
                data-testid="tenant-variable-description-input"
              />
            </label>

            <label className="flex items-center gap-2 text-sm md:col-span-2">
              <input
                type="checkbox"
                checked={editing.draft.isSecret}
                onChange={(e) => patchDraft({ isSecret: e.target.checked })}
                data-testid="tenant-variable-secret-toggle"
              />
              <span>{t('tenantVariablesPage.fields.isSecret')}</span>
              <span className="text-xs text-muted-foreground">{t('tenantVariablesPage.fields.isSecretHint')}</span>
            </label>
          </div>

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-60"
              data-testid="tenant-variable-save"
            >
              {t('tenantVariablesPage.actions.save')}
            </button>
            <button
              type="button"
              onClick={closeEditor}
              className="rounded-md border px-3 py-1.5 text-sm"
              data-testid="tenant-variable-cancel"
            >
              {t('tenantVariablesPage.actions.cancel')}
            </button>
          </div>
        </section>
      )}

      {loading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">{t('tenantVariablesPage.loading')}</div>
      ) : variables.length === 0 ? (
        <div className="rounded-lg border border-dashed py-12 text-center" data-testid="tenant-variables-empty">
          <KeyRound className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
          <p className="text-sm font-medium">{t('tenantVariablesPage.empty.title')}</p>
          <p className="text-sm text-muted-foreground">{t('tenantVariablesPage.empty.description')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2">{t('tenantVariablesPage.fields.key')}</th>
                <th className="px-4 py-2">{t('tenantVariablesPage.fields.value')}</th>
                <th className="px-4 py-2">{t('tenantVariablesPage.fields.scope')}</th>
                <th className="px-4 py-2">{t('tenantVariablesPage.fields.description')}</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {variables.map((variable) => (
                <tr key={variable.id} className="border-t" data-testid={`tenant-variable-row-${variable.key}`}>
                  <td className="px-4 py-2 font-mono text-xs">{`{{var.${variable.key}}}`}</td>
                  <td className="px-4 py-2">
                    {variable.isSecret ? (
                      <span className="inline-flex items-center gap-1 text-muted-foreground" data-testid="tenant-variable-secret-mask">
                        <Lock className="h-3 w-3" />
                        ••••••••
                      </span>
                    ) : (
                      <span className="font-mono text-xs">{variable.value}</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {variable.ownerScope === 'partner' ? (
                      <span
                        className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                        data-testid="tenant-variable-all-orgs-badge"
                      >
                        {t('tenantVariablesPage.editor.allOrgs')}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">{t('tenantVariablesPage.editor.thisOrg')}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{variable.description}</td>
                  <td className="px-4 py-2 text-right">
                    {canManage(variable) && (
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => openEdit(variable)}
                          className="rounded-md p-1.5 hover:bg-muted"
                          aria-label={t('tenantVariablesPage.actions.edit')}
                          data-testid={`tenant-variable-edit-${variable.key}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void remove(variable.id)}
                          className="inline-flex items-center gap-1 rounded-md p-1.5 text-destructive hover:bg-destructive/10"
                          aria-label={
                            confirmDeleteId === variable.id
                              ? t('tenantVariablesPage.actions.confirmDelete')
                              : t('tenantVariablesPage.actions.delete')
                          }
                          data-testid={`tenant-variable-delete-${variable.key}`}
                        >
                          <Trash2 className="h-4 w-4" />
                          {confirmDeleteId === variable.id && (
                            <span className="text-xs font-medium">{t('tenantVariablesPage.actions.confirmDelete')}</span>
                          )}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
