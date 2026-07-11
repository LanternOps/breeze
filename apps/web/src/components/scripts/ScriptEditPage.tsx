import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, History } from 'lucide-react';
import ScriptForm, { type ScriptFormValues, type ScriptSubmitValues } from './ScriptForm';
import { mappingToRows } from './ScriptFormSchema';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { ScopeBadge } from '../shared/ScopeBadge';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { getJwtClaims } from '@/lib/authScope';
import Breadcrumbs from '../layout/Breadcrumbs';

type ScriptEditPageProps = {
  scriptId?: string;
};

type ScriptScope = {
  orgId: string | null;
  partnerId: string | null;
  isSystem: boolean;
};

export default function ScriptEditPage({ scriptId }: ScriptEditPageProps) {
  const { t } = useTranslation('scripts');
  const [script, setScript] = useState<ScriptFormValues | null>(null);
  const [scriptScope, setScriptScope] = useState<ScriptScope | null>(null);
  const [loading, setLoading] = useState(!!scriptId);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const isNew = !scriptId;
  const { organizations } = useOrgStore();
  const { scope: jwtScope } = getJwtClaims();

  const fetchScript = useCallback(async () => {
    if (!scriptId) return;

    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth(`/scripts/${scriptId}`);
      if (!response.ok) {
        if (response.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        throw new Error(t('scriptEditPage.errors.fetch'));
      }
      const data = await response.json();
      const scriptData = data.script ?? data;
      const scopeOrgId: string | null = scriptData.orgId ?? null;
      setScript({
        name: scriptData.name,
        description: scriptData.description || '',
        category: scriptData.category,
        language: scriptData.language,
        osTypes: scriptData.osTypes,
        content: scriptData.content || '',
        parameters: scriptData.parameters || [],
        timeoutSeconds: scriptData.timeoutSeconds || 300,
        runAs: scriptData.runAs || 'system',
        exitCodeSeverityMapping: mappingToRows(scriptData.exitCodeSeverityMapping),
        // Seed the "Available to" re-scope picker from the current scope
        // (issue #1734): org_id NULL = partner-wide ("All Orgs"), else a
        // specific org. The picker only renders for partner-scope users.
        availability: scopeOrgId ? 'org' : 'partner',
        orgId: scopeOrgId ?? undefined,
      });
      setScriptScope({
        orgId: scopeOrgId,
        partnerId: scriptData.partnerId ?? null,
        isSystem: scriptData.isSystem ?? false,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('scriptEditPage.errors.generic'));
    } finally {
      setLoading(false);
    }
  }, [scriptId, t]);

  useEffect(() => {
    fetchScript();
  }, [fetchScript]);

  const handleSubmit = async (values: ScriptSubmitValues) => {
    setSubmitting(true);
    setError(undefined);

    try {
      const url = isNew ? '/scripts' : `/scripts/${scriptId}`;
      const method = isNew ? 'POST' : 'PUT';

      type ScriptPayload = Omit<ScriptSubmitValues, 'availability' | 'orgId'> & {
        availability?: 'org' | 'partner';
        orgId?: string | null;
      };
      const { availability: _availability, orgId: _orgId, ...baseValues } = values;
      let payload: ScriptPayload = baseValues;
      if (isNew) {
        if (values.availability === 'org') {
          // Org-specific script: use the selected orgId from the form or fall back to the current org
          const orgId = values.orgId || useOrgStore.getState().currentOrgId || undefined;
          payload = { ...baseValues, availability: 'org', orgId };
        } else {
          // Partner-wide (default) or single-org user: let the backend resolve
          payload = { ...baseValues, availability: 'partner' };
        }
      } else {
        // Edit: forward the re-scope fields only for partner-scope users whose
        // scope actually differs from the script's current scope (issue #1734).
        // Org-scope users can't re-scope (the picker is hidden and the backend
        // 403s them), so strip the seeded `availability`/`orgId` for them.
        const canRescope =
          jwtScope === 'partner' && !scriptScope?.isSystem && _availability !== undefined;
        if (canRescope) {
          const targetOrgId = _availability === 'org' ? (_orgId || undefined) : null;
          const scopeUnchanged = (scriptScope?.orgId ?? null) === (targetOrgId ?? null);
          if (!scopeUnchanged) {
            payload = { ...baseValues, availability: _availability, orgId: targetOrgId };
          }
        }
      }

      const response = await fetchWithAuth(url, {
        method,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        let errorMessage = t('scriptEditPage.errors.save');
        try {
          const data = await response.json();
          if (data.error) errorMessage = data.error;
        } catch { /* non-JSON response body (e.g. proxy error page) */ }
        throw new Error(errorMessage);
      }

      showToast({ type: 'success', message: isNew ? t('scriptEditPage.toast.created') : t('scriptEditPage.toast.saved') });
      void navigateTo('/scripts');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('scriptEditPage.errors.generic'));
      throw err; // re-throw so ScriptForm knows the save failed
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = () => {
    void navigateTo('/scripts');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">{t('scriptEditPage.loading')}</p>
        </div>
      </div>
    );
  }

  if (error && !script && !isNew) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <div className="mt-4 flex justify-center gap-3">
          <a
            href="/scripts"
            className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            {t('scriptEditPage.actions.backToScripts')}
          </a>
          <button
            type="button"
            onClick={fetchScript}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t('common:actions.retry')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Breadcrumbs items={[
        { label: t('scriptEditPage.breadcrumb.scripts'), href: '/scripts' },
        { label: isNew ? t('scriptEditPage.breadcrumb.new') : (script?.name || t('scriptEditPage.breadcrumb.edit')) }
      ]} />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <a
            href="/scripts"
            className="flex h-10 w-10 items-center justify-center rounded-md border hover:bg-muted"
          >
            <ArrowLeft className="h-5 w-5" />
          </a>
          <h1 className="text-xl font-semibold tracking-tight">
            {isNew ? t('scriptEditPage.title.new') : (script?.name || t('scriptEditPage.title.edit'))}
          </h1>
          {!isNew && scriptScope && (
            <ScopeBadge
              orgId={scriptScope.orgId}
              partnerId={scriptScope.partnerId}
              isSystem={scriptScope.isSystem}
              orgName={organizations.find(o => o.id === scriptScope.orgId)?.name}
            />
          )}
        </div>
        {!isNew && (
          <a
            href={`/scripts/${scriptId}/executions`}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium transition hover:bg-muted"
          >
            <History className="h-4 w-4" />
            {t('scriptEditPage.actions.executionHistory')}
          </a>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <ScriptForm
        onSubmit={handleSubmit}
        onCancel={handleCancel}
        defaultValues={script || undefined}
        submitLabel={isNew ? t('scriptEditPage.actions.create') : t('scriptEditPage.actions.saveChanges')}
        loading={submitting}
        isNew={isNew}
        isSystemScript={scriptScope?.isSystem ?? false}
      />
    </div>
  );
}
