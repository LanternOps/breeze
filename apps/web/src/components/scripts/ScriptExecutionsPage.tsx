import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Play } from 'lucide-react';
import ExecutionHistory, { type ScriptExecution } from './ExecutionHistory';
import ExecutionDetails from './ExecutionDetails';
import ScriptExecutionModal, { type Site } from './ScriptExecutionModal';
import type { Script } from './ScriptList';
import type { ScriptParameter } from './ScriptForm';
import { fetchWithAuth } from '../../stores/auth';
import { extractApiError } from '@/lib/apiError';
import { navigateTo } from '@/lib/navigation';
import Breadcrumbs from '../layout/Breadcrumbs';
import { asList } from '@/lib/asList';
import { deviceScriptsHref, scriptExecutionsHref } from '@/lib/deviceScriptsLink';
import type { ScriptAdmissionResult } from '@breeze/shared';
import { handleActionError } from '@/lib/runAction';
import { requestScriptExecutionCancel } from '@/lib/cancelScriptExecution';
import { usePermissions } from '@/lib/permissions';
// Initializes the shared i18next singleton. Islands hydrate independently, so
// an island that hydrates before whichever other island happens to pull i18n in
// would otherwise render raw keys (and mismatch the SSR markup).
import '../../lib/i18n';

type ScriptExecutionsPageProps = {
  scriptId: string;
};

type ScriptWithDetails = Script & {
  parameters?: ScriptParameter[];
  content?: string;
};

// #4767 — mirrors the ScriptTestRunner.tsx poll cadence. While any execution
// is `running` or `cancelling` the list can go stale (a stop resolving, or a
// run simply finishing) with nothing else on this page to re-trigger a fetch.
const POLL_INTERVAL_MS = 2000;

export default function ScriptExecutionsPage({ scriptId }: ScriptExecutionsPageProps) {
  const { t } = useTranslation('scripts');
  const { permissions } = usePermissions();
  const [script, setScript] = useState<ScriptWithDetails | null>(null);
  const [executions, setExecutions] = useState<ScriptExecution[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [selectedExecution, setSelectedExecution] = useState<ScriptExecution | null>(null);
  const [showExecuteModal, setShowExecuteModal] = useState(false);
  // #4885 "Run again" — carries the clicked execution's device + parameters
  // into the next open of the execute modal. Cleared on close so a later
  // "Run Script" from the toolbar (not tied to any past execution) opens
  // blank again.
  const [runAgainSeed, setRunAgainSeed] = useState<{
    deviceIds: string[];
    parameters: Record<string, string | number | boolean>;
  } | null>(null);

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
      const list = asList(data, 'executions') as ScriptExecution[];
      setExecutions(list);
      // #4767 review: the details modal holds its own snapshot
      // (selectedExecution), so without this a Stop/Force-stop clicked from
      // INSIDE the modal never reflects back into it — the header would keep
      // reading "Running" and stay clickable after a successful cancel,
      // inviting a second request that only ever gets a 409.
      setSelectedExecution((prev) => {
        if (!prev) return prev;
        const updated = list.find((e) => e.id === prev.id);
        return updated ? { ...prev, ...updated } : prev;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('scriptExecutionsPage.errors.generic'));
    } finally {
      setLoading(false);
    }
  }, [scriptId, t]);

  const fetchSites = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/orgs/sites');
      if (response.ok) {
        const data = await response.json();
        setSites(asList(data, 'sites'));
      }
    } catch {
      // Silently fail
    }
  }, []);

  useEffect(() => {
    fetchScript();
    fetchExecutions();
    fetchSites();
  }, [fetchScript, fetchExecutions, fetchSites]);

  // #4767 — poll while a Stop is in flight (or a run is simply still going) so
  // "Stopping…" doesn't freeze forever once the device (or the reaper) settles
  // it. Keyed on a boolean rather than the executions array itself so the
  // interval isn't torn down and recreated on every poll tick.
  const hasActiveExecutions = useMemo(
    () => executions.some((execution) => execution.status === 'running' || execution.status === 'cancelling'),
    [executions],
  );
  useEffect(() => {
    if (!hasActiveExecutions) return;
    const timer = setInterval(() => {
      fetchExecutions();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hasActiveExecutions, fetchExecutions]);

  const handleCancel = useCallback(async (execution: ScriptExecution, graceSeconds: number) => {
    try {
      await requestScriptExecutionCancel({
        executionId: execution.id,
        graceSeconds,
        errorFallback: t('executionHistory.errors.cancelFailed'),
        noLongerCancellableMessage: t('executionHistory.errors.noLongerCancellable'),
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      await fetchExecutions();
    } catch (err) {
      handleActionError(err, t('executionHistory.errors.cancelFailed'));
    }
  }, [t, fetchExecutions]);

  const handleViewDetails = (execution: ScriptExecution) => {
    // Open immediately with the list row, then upgrade with the full record —
    // the list endpoint omits stdout/stderr to keep its payload small.
    setSelectedExecution(execution);
    void (async () => {
      try {
        const response = await fetchWithAuth(`/scripts/executions/${execution.id}`);
        if (!response.ok) {
          if (response.status === 401) void navigateTo('/login', { replace: true });
          return;
        }
        const detail = await response.json();
        setSelectedExecution(prev =>
          prev && prev.id === execution.id ? { ...prev, ...detail } : prev
        );
      } catch {
        // Keep the list row; the modal still shows status/metadata.
      }
    })();
  };

  const handleCloseDetails = () => {
    setSelectedExecution(null);
  };

  // #4885 — re-open the execute flow pre-filled with this execution's device
  // and the runtime parameters it was submitted with, instead of the operator
  // re-picking both from scratch.
  const handleRunAgain = (execution: ScriptExecution) => {
    setSelectedExecution(null);
    setRunAgainSeed({
      deviceIds: [execution.deviceId],
      parameters: execution.parameters ?? {}
    });
    setShowExecuteModal(true);
  };

  const handleCloseExecuteModal = () => {
    setShowExecuteModal(false);
    setRunAgainSeed(null);
  };

  const handleExecute = async (
    _scriptId: string,
    deviceIds: string[],
    parameters: Record<string, string | number | boolean>,
    runAs: 'system' | 'user'
  ) => {
    // runaction-exempt: this throws to ScriptExecutionModal, which renders the
    // failure (or the per-target admission result) inline in its own form —
    // a toast on top would be redundant, not a silent failure.
    const response = await fetchWithAuth(`/scripts/${scriptId}/execute`, {
      method: 'POST',
      body: JSON.stringify({ deviceIds, parameters, runAs })
    });

    if (!response.ok) {
      if (response.status === 401) {
        void navigateTo('/login', { replace: true });
        throw new Error(t('scriptExecutionsPage.errors.execute'));
      }
      const data = await response.json();
      throw new Error(extractApiError(data, t('scriptExecutionsPage.errors.execute')));
    }

    const admission = await response.json() as ScriptAdmissionResult;
    const admittedTargets = admission.targets.filter(target => target.admission === 'admitted');
    if (admittedTargets.length > 0) {
      await fetchExecutions();
      // #4886 mirror — same post-run navigation as ScriptsPage's library run:
      // a single-device run (which is what "Run again" always seeds) jumps to
      // that device's Scripts tab with the new execution highlighted; a
      // multi-device run has no single "the" device, so it stays on this
      // execution-history page (already the right place) via a self-navigate
      // that picks up the just-fetched row.
      if (deviceIds.length === 1) {
        void navigateTo(deviceScriptsHref(deviceIds[0]!, admittedTargets[0]?.executionId));
      } else {
        void navigateTo(scriptExecutionsHref(scriptId));
      }
    }
    return admission;
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
            onClick={() => { setRunAgainSeed(null); setShowExecuteModal(true); }}
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
        onCancel={handleCancel}
        permissions={permissions}
        showScriptName={false}
      />

      {/* Execution Details Modal */}
      {selectedExecution && (
        <ExecutionDetails
          execution={selectedExecution}
          isOpen={true}
          onClose={handleCloseDetails}
          onRunAgain={handleRunAgain}
          onCancel={handleCancel}
          permissions={permissions}
        />
      )}

      {/* Execute Modal */}
      {showExecuteModal && script && (
        <ScriptExecutionModal
          script={script}
          sites={sites}
          isOpen={true}
          onClose={handleCloseExecuteModal}
          onExecute={handleExecute}
          initialDeviceIds={runAgainSeed?.deviceIds}
          initialParameters={runAgainSeed?.parameters}
        />
      )}
    </div>
  );
}
