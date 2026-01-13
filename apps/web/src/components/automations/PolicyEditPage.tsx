import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft } from 'lucide-react';
import PolicyForm, { type PolicyFormValues } from './PolicyForm';

type Site = { id: string; name: string };
type Group = { id: string; name: string };
type Tag = { id: string; name: string };
type Script = { id: string; name: string };

type PolicyEditPageProps = {
  policyId?: string;
  isNew?: boolean;
};

export default function PolicyEditPage({ policyId, isNew = false }: PolicyEditPageProps) {
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [defaultValues, setDefaultValues] = useState<Partial<PolicyFormValues>>();
  const [sites, setSites] = useState<Site[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [scripts, setScripts] = useState<Script[]>([]);

  const fetchPolicy = useCallback(async () => {
    if (!policyId || isNew) return;

    try {
      setLoading(true);
      setError(undefined);
      const response = await fetch(`/api/policies/${policyId}`);
      if (!response.ok) {
        throw new Error('Failed to fetch policy');
      }
      const data = await response.json();
      const policy = data.policy ?? data;

      // Transform policy to form values
      setDefaultValues({
        name: policy.name,
        description: policy.description,
        targetType: policy.targetType ?? 'all',
        targetIds: policy.targetIds ?? [],
        rules: policy.rules ?? [{ type: 'required_software' }],
        enforcementLevel: policy.enforcementLevel ?? 'monitor',
        remediationScriptId: policy.remediationScriptId ?? '',
        checkIntervalMinutes: policy.checkIntervalMinutes ?? 60
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [policyId, isNew]);

  const fetchSites = useCallback(async () => {
    try {
      const response = await fetch('/api/sites');
      if (response.ok) {
        const data = await response.json();
        setSites(data.sites ?? data ?? []);
      }
    } catch {
      // Silently fail
    }
  }, []);

  const fetchGroups = useCallback(async () => {
    try {
      const response = await fetch('/api/groups');
      if (response.ok) {
        const data = await response.json();
        setGroups(data.groups ?? data ?? []);
      }
    } catch {
      // Silently fail
    }
  }, []);

  const fetchTags = useCallback(async () => {
    try {
      const response = await fetch('/api/tags');
      if (response.ok) {
        const data = await response.json();
        setTags(data.tags ?? data ?? []);
      }
    } catch {
      // Silently fail
    }
  }, []);

  const fetchScripts = useCallback(async () => {
    try {
      const response = await fetch('/api/scripts');
      if (response.ok) {
        const data = await response.json();
        setScripts(data.scripts ?? data ?? []);
      }
    } catch {
      // Silently fail
    }
  }, []);

  useEffect(() => {
    fetchPolicy();
    fetchSites();
    fetchGroups();
    fetchTags();
    fetchScripts();
  }, [fetchPolicy, fetchSites, fetchGroups, fetchTags, fetchScripts]);

  const handleSubmit = async (values: PolicyFormValues) => {
    setSaving(true);
    setError(undefined);

    try {
      // Transform form values to API format
      const payload = {
        name: values.name,
        description: values.description,
        targetType: values.targetType,
        targetIds: values.targetType !== 'all' ? values.targetIds : undefined,
        rules: values.rules,
        enforcementLevel: values.enforcementLevel,
        remediationScriptId: values.enforcementLevel === 'enforce' ? values.remediationScriptId : undefined,
        checkIntervalMinutes: values.checkIntervalMinutes,
        enabled: true
      };

      const url = isNew ? '/api/policies' : `/api/policies/${policyId}`;
      const method = isNew ? 'POST' : 'PUT';

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to save policy');
      }

      window.location.href = '/policies';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    window.location.href = '/policies';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading policy...</p>
        </div>
      </div>
    );
  }

  if (error && !defaultValues && !isNew) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchPolicy}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <a
          href="/policies"
          className="flex h-10 w-10 items-center justify-center rounded-md border hover:bg-muted"
        >
          <ArrowLeft className="h-5 w-5" />
        </a>
        <div>
          <h1 className="text-2xl font-bold">
            {isNew ? 'Create Policy' : 'Edit Policy'}
          </h1>
          <p className="text-muted-foreground">
            {isNew
              ? 'Define compliance rules and enforcement behavior.'
              : 'Modify the policy configuration.'}
          </p>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <PolicyForm
        onSubmit={handleSubmit}
        onCancel={handleCancel}
        defaultValues={defaultValues}
        submitLabel={isNew ? 'Create Policy' : 'Save Changes'}
        loading={saving}
        sites={sites}
        groups={groups}
        tags={tags}
        scripts={scripts}
      />
    </div>
  );
}
