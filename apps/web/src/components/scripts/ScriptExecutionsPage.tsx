import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Play } from 'lucide-react';
import ExecutionHistory, { type ScriptExecution } from './ExecutionHistory';
import ExecutionDetails from './ExecutionDetails';
import ScriptExecutionModal, { type Device, type Site } from './ScriptExecutionModal';
import type { Script } from './ScriptList';
import type { ScriptParameter } from './ScriptForm';
import { fetchWithAuth } from '../../stores/auth';
import { extractApiError } from '@/lib/apiError';
import { navigateTo } from '@/lib/navigation';
import Breadcrumbs from '../layout/Breadcrumbs';

type ScriptExecutionsPageProps = {
  scriptId: string;
};

type ScriptWithDetails = Script & {
  parameters?: ScriptParameter[];
  content?: string;
};

export default function ScriptExecutionsPage({ scriptId }: ScriptExecutionsPageProps) {
  const { t } = useTranslation('scripts');
  const [script, setScript] = useState<ScriptWithDetails | null>(null);
  const [executions, setExecutions] = useState<ScriptExecution[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [selectedExecution, setSelectedExecution] = useState<ScriptExecution | null>(null);
  const [showExecuteModal, setShowExecuteModal] = useState(false);

  const fetchScript = useCallback(async () => {
    try {
      const response = await fetchWithAuth(`/scripts/${scriptId}`);
      if (!response.ok) {
        if (response.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        throw new Error(t('scriptExecutionsPage.errors.fetchScript'));
      }
      const data = await response.json();
      setScript(data.script ?? data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('scriptExecutionsPage.errors.generic'));
    }
  }, [scriptId, t]);

  const fetchExecutions = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth(`/scripts/${scriptId}/executions`);
      if (!response.ok) {
        if (response.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        throw new Error(t('scriptExecutionsPage.errors.fetchExecutions'));
      }
      const data = await response.json();
      setExecutions(data.data ?? data.executions ?? (Array.isArray(data) ? data : []));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('scriptExecutionsPage.errors.generic'));
    } finally {
      setLoading(false);
    }
  }, [scriptId, t]);

  const fetchDevices = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/devices');
      if (response.ok) {
        const data = await response.json();
        setDevices(data.data ?? data.devices ?? (Array.isArray(data) ? data : []));
      }
    } catch {
      // Silently fail
    }
  }, []);

  const fetchSites = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/orgs/sites');
      if (response.ok) {
        const data = await response.json();
        setSites(data.data ?? data.sites ?? (Array.isArray(data) ? data : []));
      }
    } catch {
      // Silently fail
    }
  }, []);

  useEffect(() => {
    fetchScript();
    fetchExecutions();
    fetchDevices();
    fetchSites();
  }, [fetchScript, fetchExecutions, fetchDevices, fetchSites]);

  const handleViewDetails = (execution: ScriptExecution) => {
    setSelectedExecution(execution);
  };

  const handleCloseDetails = () => {
    setSelectedExecution(null);
  };

  const handleExecute = async (
    _scriptId: string,
    deviceIds: string[],
    parameters: Record<string, string | number | boolean>,
    runAs: 'system' | 'user'
  ) => {
    const response = await fetchWithAuth(`/scripts/${scriptId}/execute`, {
      method: 'POST',
      body: JSON.stringify({ deviceIds, parameters, runAs })
    });

    if (!response.ok) {
      if (response.status === 401) {
        void navigateTo('/login', { replace: true });
        return;
      }
      const data = await response.json();
      throw new Error(extractApiError(data, t('scriptExecutionsPage.errors.execute')));
    }

    // Refresh executions list
    await fetchExecutions();
  };

  if (loading && !script) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">{t('scriptExecutionsPage.loading')}</p>
        </div>
      </div>
    );
  }

  if (error && executions.length === 0 && !script) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <div className="mt-4 flex justify-center gap-3">
          <a
            href="/scripts"
            className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            {t('scriptExecutionsPage.actions.backToScripts')}
          </a>
          <button
            type="button"
            onClick={() => {
              fetchScript();
              fetchExecutions();
            }}
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
        { label: t('scriptExecutionsPage.breadcrumb.scripts'), href: '/scripts' },
        { label: script?.name || t('scriptExecutionsPage.breadcrumb.script'), href: `/scripts/${scriptId}` },
        { label: t('scriptExecutionsPage.breadcrumb.executions') }
      ]} />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <a
            href={`/scripts/${scriptId}`}
            className="flex h-10 w-10 items-center justify-center rounded-md border hover:bg-muted"
          >
            <ArrowLeft className="h-5 w-5" />
          </a>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{t('scriptExecutionsPage.title')}</h1>
            <p className="text-muted-foreground">
              {script?.name || t('common:states.loading')}
            </p>
          </div>
        </div>
        {script && (
          <button
            type="button"
            onClick={() => setShowExecuteModal(true)}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
          >
            <Play className="h-4 w-4" />
            {t('scriptExecutionsPage.actions.runScript')}
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {script && (
        <div className="rounded-md border bg-muted/20 p-4">
          <div className="grid gap-4 sm:grid-cols-4">
            <div>
              <p className="text-xs font-medium text-muted-foreground">{t('scriptExecutionsPage.fields.language')}</p>
              <p className="text-sm font-medium capitalize">{t(/* i18n-dynamic */ `scriptExecutionsPage.languages.${script.language}`)}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">{t('scriptExecutionsPage.fields.category')}</p>
              <p className="text-sm font-medium">{script.category}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">{t('scriptExecutionsPage.fields.targetOs')}</p>
              <p className="text-sm font-medium">{script.osTypes.map(os => t(/* i18n-dynamic */ `scriptExecutionsPage.os.${os}`)).join(', ')}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">{t('common:labels.status')}</p>
              <p className="text-sm font-medium capitalize">{script.status ? t(/* i18n-dynamic */ `scriptExecutionsPage.status.${script.status}`) : t('common:states.unknown')}</p>
            </div>
          </div>
          {script.description && (
            <p className="mt-3 text-sm text-muted-foreground">{script.description}</p>
          )}
        </div>
      )}

      <ExecutionHistory
        executions={executions}
        onViewDetails={handleViewDetails}
        showScriptName={false}
      />

      {/* Execution Details Modal */}
      {selectedExecution && (
        <ExecutionDetails
          execution={selectedExecution}
          isOpen={true}
          onClose={handleCloseDetails}
        />
      )}

      {/* Execute Modal */}
      {showExecuteModal && script && (
        <ScriptExecutionModal
          script={script}
          devices={devices}
          sites={sites}
          isOpen={true}
          onClose={() => setShowExecuteModal(false)}
          onExecute={handleExecute}
        />
      )}
    </div>
  );
}
