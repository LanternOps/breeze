import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Plus } from 'lucide-react';
import '@/lib/i18n';
import { navigateTo } from '@/lib/navigation';
import { getJwtClaims } from '@/lib/authScope';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';
import { StatusPill } from '../billing/shared/StatusPill';
import TemplateEditor from './TemplateEditor';
import {
  listContractTemplates,
  createContractTemplate,
  archiveContractTemplate,
  type ContractTemplateWithLatest,
  type TemplateOwnerScope,
} from '../../lib/api/contractTemplates';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

interface Organization {
  id: string;
  name: string;
}

const STATUS_ROLE = { active: 'success', archived: 'neutral' } as const;

export default function TemplatesTab() {
  const { t } = useTranslation('billing');
  const { scope, partnerId } = getJwtClaims();
  const isPartnerScope = scope === 'partner' && !!partnerId;

  const [templates, setTemplates] = useState<ContractTemplateWithLatest[]>([]);
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [orgNames, setOrgNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();

  // Create dialog state.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formOwnerScope, setFormOwnerScope] = useState<TemplateOwnerScope>(
    isPartnerScope ? 'partner' : 'organization',
  );
  const [formOrgId, setFormOrgId] = useState('');
  const [formError, setFormError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const res = await listContractTemplates({ includeArchived });
      if (res.status === 401) return UNAUTHORIZED();
      if (!res.ok) throw new Error(t('contracts.templatesTab.loadError'));
      const body = (await res.json().catch(() => null)) as { data: ContractTemplateWithLatest[] } | null;
      if (!body) throw new Error(t('contracts.templatesTab.loadError'));
      setTemplates(body.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('contracts.templatesTab.loadError'));
    } finally {
      setLoading(false);
    }
  }, [includeArchived, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetchWithAuth('/orgs/organizations');
        if (!res.ok) return;
        const body = (await res.json().catch(() => null)) as
          | { data?: Organization[]; organizations?: Organization[] }
          | null;
        const list = body?.data ?? body?.organizations ?? [];
        setOrgs(list);
        setOrgNames(Object.fromEntries(list.map((o) => [o.id, o.name])));
      } catch {
        // Cosmetic org-name enrichment only — a failed GET just leaves the org
        // column blank (and the create dialog without its org picker). No toast.
      }
    })();
  }, []);

  const openDialog = () => {
    setFormName('');
    setFormDescription('');
    setFormOwnerScope(isPartnerScope ? 'partner' : 'organization');
    setFormOrgId('');
    setFormError(undefined);
    setDialogOpen(true);
  };

  const submitCreate = async () => {
    const name = formName.trim();
    if (!name) {
      setFormError(t('contracts.templatesTab.createDialog.nameRequired'));
      return;
    }
    if (formOwnerScope === 'organization' && !formOrgId) {
      setFormError(t('contracts.templatesTab.createDialog.orgRequired'));
      return;
    }
    setFormError(undefined);
    setSubmitting(true);
    try {
      const created = await runAction<{ data: { id: string } }>({
        request: () =>
          createContractTemplate({
            name,
            description: formDescription.trim() || undefined,
            ownerScope: formOwnerScope,
            orgId: formOwnerScope === 'organization' ? formOrgId : undefined,
          }),
        errorFallback: t('contracts.templatesTab.createError'),
        successMessage: t('contracts.templatesTab.created'),
        onUnauthorized: UNAUTHORIZED,
      });
      setDialogOpen(false);
      await load();
      if (created?.data?.id) setSelectedId(created.data.id);
    } catch (err) {
      handleActionError(err, t('contracts.templatesTab.createError'));
    } finally {
      setSubmitting(false);
    }
  };

  const archive = async (id: string) => {
    try {
      await runAction({
        request: () => archiveContractTemplate(id),
        errorFallback: t('contracts.templatesTab.archiveError'),
        successMessage: t('contracts.templatesTab.archiveSuccess'),
        onUnauthorized: UNAUTHORIZED,
      });
      await load();
    } catch (err) {
      handleActionError(err, t('contracts.templatesTab.archiveError'));
    }
  };

  if (selectedId) {
    return (
      <TemplateEditor
        templateId={selectedId}
        onClose={() => {
          setSelectedId(undefined);
          void load();
        }}
      />
    );
  }

  const ownerLabel = (tpl: ContractTemplateWithLatest): string => {
    if (tpl.ownerScope === 'partner') return t('contracts.templatesTab.allOrgs');
    return orgNames[tpl.orgId] ?? t('contracts.templatesTab.ownerOrg');
  };

  return (
    <div className="space-y-4" data-testid="contract-templates-tab">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t('contracts.templatesTab.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('contracts.templatesTab.description')}</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-border"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
              data-testid="contract-templates-include-archived"
            />
            {t('contracts.templatesTab.includeArchived')}
          </label>
          <button
            type="button"
            onClick={openDialog}
            data-testid="contract-templates-create-btn"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            {t('contracts.templatesTab.newTemplate')}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16" data-testid="contract-templates-loading">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      ) : error ? (
        <div
          className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center text-sm text-destructive"
          data-testid="contract-templates-error"
        >
          {error}
        </div>
      ) : templates.length === 0 ? (
        <div
          className="rounded-lg border border-dashed p-10 text-center"
          data-testid="contract-templates-empty"
        >
          <FileText className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">{t('contracts.templatesTab.empty.title')}</p>
          <p className="text-sm text-muted-foreground">{t('contracts.templatesTab.empty.description')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t('contracts.templatesTab.columns.name')}</th>
                <th className="px-3 py-2 font-medium">{t('contracts.templatesTab.columns.owner')}</th>
                <th className="px-3 py-2 font-medium">{t('contracts.templatesTab.columns.status')}</th>
                <th className="px-3 py-2 font-medium">{t('contracts.templatesTab.columns.latestVersion')}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {templates.map((tpl) => (
                <tr key={tpl.id} data-testid="contract-template-row" className="border-t hover:bg-muted/20">
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => setSelectedId(tpl.id)}
                      className="font-medium text-primary hover:underline"
                      data-testid="contract-template-open"
                    >
                      {tpl.name}
                    </button>
                    {tpl.description && (
                      <div className="text-xs text-muted-foreground">{tpl.description}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {tpl.ownerScope === 'partner' ? (
                      <span
                        data-testid="contract-template-all-orgs-badge"
                        className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                      >
                        {t('contracts.templatesTab.allOrgs')}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{ownerLabel(tpl)}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <StatusPill
                      role={STATUS_ROLE[tpl.status]}
                      label={t(/* i18n-dynamic */ `contracts.templatesTab.status.${tpl.status}`)}
                    />
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {tpl.latestVersion
                      ? t('contracts.templatesTab.versionLabel', {
                          number: tpl.latestVersion.versionNumber,
                          status: t(/* i18n-dynamic */ `contracts.templateEditor.versionStatus.${tpl.latestVersion.status}`),
                        })
                      : t('contracts.templatesTab.noVersions')}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {tpl.status === 'active' && (
                      <button
                        type="button"
                        onClick={() => void archive(tpl.id)}
                        data-testid="contract-template-archive"
                        className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                      >
                        {t('contracts.templatesTab.archive')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div
            className="w-full max-w-md space-y-4 rounded-lg border bg-background p-5 shadow-lg"
            data-testid="contract-template-create-dialog"
          >
            <h3 className="text-base font-semibold">{t('contracts.templatesTab.createDialog.title')}</h3>

            <div className="space-y-1">
              <label htmlFor="tpl-name" className="text-sm font-medium">
                {t('contracts.templatesTab.createDialog.name')}
              </label>
              <input
                id="tpl-name"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder={t('contracts.templatesTab.createDialog.namePlaceholder')}
                data-testid="contract-template-name"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="tpl-description" className="text-sm font-medium">
                {t('contracts.templatesTab.createDialog.description')}
              </label>
              <input
                id="tpl-description"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder={t('contracts.templatesTab.createDialog.descriptionPlaceholder')}
                data-testid="contract-template-description"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>

            {isPartnerScope && (
              <fieldset className="space-y-2 rounded-md border p-3" data-testid="contract-template-owner">
                <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
                  {t('contracts.templatesTab.createDialog.scope')}
                </legend>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="ownerScope"
                    checked={formOwnerScope === 'partner'}
                    onChange={() => setFormOwnerScope('partner')}
                    data-testid="contract-template-owner-partner"
                  />
                  {t('contracts.templatesTab.createDialog.allOrganizations')}
                  <span className="text-muted-foreground">
                    {t('contracts.templatesTab.createDialog.partnerWide')}
                  </span>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="ownerScope"
                    checked={formOwnerScope === 'organization'}
                    onChange={() => setFormOwnerScope('organization')}
                    data-testid="contract-template-owner-org"
                  />
                  {t('contracts.templatesTab.createDialog.thisOrgOnly')}
                </label>
              </fieldset>
            )}

            {formOwnerScope === 'organization' && (
              <div className="space-y-1">
                <label htmlFor="tpl-org" className="text-sm font-medium">
                  {t('contracts.templatesTab.createDialog.organization')}
                </label>
                <select
                  id="tpl-org"
                  value={formOrgId}
                  onChange={(e) => setFormOrgId(e.target.value)}
                  data-testid="contract-template-org"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                >
                  <option value="">{t('contracts.templatesTab.createDialog.selectOrg')}</option>
                  {orgs.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {formError && (
              <p className="text-sm text-destructive" data-testid="contract-template-create-error">
                {formError}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setDialogOpen(false)}
                className="h-9 rounded-md border px-4 text-sm font-medium hover:bg-muted"
              >
                {t('contracts.templatesTab.createDialog.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void submitCreate()}
                disabled={submitting}
                data-testid="contract-template-create-submit"
                className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
              >
                {submitting
                  ? t('contracts.templatesTab.createDialog.creating')
                  : t('contracts.templatesTab.createDialog.create')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
