import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, History } from 'lucide-react';
import ScriptForm, { type ScriptFormValues } from './ScriptForm';

type ScriptEditPageProps = {
  scriptId?: string;
};

export default function ScriptEditPage({ scriptId }: ScriptEditPageProps) {
  const [script, setScript] = useState<ScriptFormValues | null>(null);
  const [loading, setLoading] = useState(!!scriptId);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const isNew = !scriptId;

  const fetchScript = useCallback(async () => {
    if (!scriptId) return;

    try {
      setLoading(true);
      setError(undefined);
      const response = await fetch(`/api/scripts/${scriptId}`);
      if (!response.ok) {
        throw new Error('Failed to fetch script');
      }
      const data = await response.json();
      const scriptData = data.script ?? data;
      setScript({
        name: scriptData.name,
        description: scriptData.description || '',
        category: scriptData.category,
        language: scriptData.language,
        osTypes: scriptData.osTypes,
        content: scriptData.content || '',
        parameters: scriptData.parameters || [],
        timeoutSeconds: scriptData.timeoutSeconds || 300,
        runAs: scriptData.runAs || 'system'
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [scriptId]);

  useEffect(() => {
    fetchScript();
  }, [fetchScript]);

  const handleSubmit = async (values: ScriptFormValues) => {
    setSubmitting(true);
    setError(undefined);

    try {
      const url = isNew ? '/api/scripts' : `/api/scripts/${scriptId}`;
      const method = isNew ? 'POST' : 'PUT';

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values)
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to save script');
      }

      window.location.href = '/scripts';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = () => {
    window.location.href = '/scripts';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading script...</p>
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
            Back to Scripts
          </a>
          <button
            type="button"
            onClick={fetchScript}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <a
            href="/scripts"
            className="flex h-10 w-10 items-center justify-center rounded-md border hover:bg-muted"
          >
            <ArrowLeft className="h-5 w-5" />
          </a>
          <div>
            <h1 className="text-2xl font-bold">
              {isNew ? 'New Script' : 'Edit Script'}
            </h1>
            <p className="text-muted-foreground">
              {isNew
                ? 'Create a new script for your devices.'
                : 'Update the script configuration.'}
            </p>
          </div>
        </div>
        {!isNew && (
          <a
            href={`/scripts/${scriptId}/executions`}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium transition hover:bg-muted"
          >
            <History className="h-4 w-4" />
            Execution History
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
        submitLabel={isNew ? 'Create Script' : 'Save Changes'}
        loading={submitting}
      />
    </div>
  );
}
