import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
import { Plus } from 'lucide-react';
import AlertRuleList, { type AlertRule } from './AlertRuleList';
import AlertsTabStrip from './AlertsTabStrip';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { extractApiError } from '@/lib/apiError';
import { asList } from '@/lib/asList';

type ModalMode = 'closed' | 'delete' | 'test';

type TestConditionResult = { condition: string; result: boolean; reason: string };

/**
 * The verdict the API actually returns for POST /alerts/rules/:id/test.
 *
 * `wouldTrigger` mirrors the condition + target evaluation the firing path
 * performs (`isActive && targetMatch && evaluation.triggered`); `targetMatch`
 * and `conditionResults` explain it. It is NOT a promise that an alert row
 * appears: `createAlert()` additionally applies cooldown, open-alert dedup and
 * flapping suppression, which this endpoint does not simulate — hence the
 * caveat rendered alongside a positive verdict.
 *
 * There is deliberately no `success` / `message` pair here — reading those
 * invented fields is what made every test report "Test Passed" (#3752).
 */
type RuleTestVerdict = {
  wouldTrigger: boolean;
  targetMatch: boolean;
  targetReason?: string;
  conditionResults: TestConditionResult[];
  rule?: { enabled?: boolean };
  device?: { hostname?: string };
};

type TestState =
  | { status: 'error'; message: string }
  | { status: 'verdict'; verdict: RuleTestVerdict };

type TestDevice = { id: string; name: string };

export default function AlertRulesPage() {
  const { t } = useTranslation('alerts');
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedRule, setSelectedRule] = useState<AlertRule | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [testResult, setTestResult] = useState<TestState | null>(null);
  const [testDevices, setTestDevices] = useState<TestDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [devicesError, setDevicesError] = useState<string>();
  const [testDeviceId, setTestDeviceId] = useState('');

  const fetchRules = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth('/alerts/rules');
      if (!response.ok) {
        if (response.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        const errData = await response.json().catch(() => null);
        throw new Error(extractApiError(errData, 'Failed to fetch alert rules'));
      }
      const data = await response.json();
      setRules(asList(data, 'rules'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  const handleEdit = (rule: AlertRule) => {
    void navigateTo(`/alerts/rules/${rule.id}`);
  };

  const handleDelete = (rule: AlertRule) => {
    setSelectedRule(rule);
    setModalMode('delete');
  };

  // The endpoint evaluates a rule against ONE device and requires a deviceId
  // body, so the modal has to ask which device before it can test anything.
  const handleTest = async (rule: AlertRule) => {
    setSelectedRule(rule);
    setTestResult(null);
    setTestDeviceId('');
    setDevicesError(undefined);
    setModalMode('test');

    setDevicesLoading(true);
    try {
      const response = await fetchWithAuth('/devices');
      if (!response.ok) {
        if (response.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        const errData = await response.json().catch(() => null);
        throw new Error(extractApiError(errData, t('alertRulesPage.failedToLoadDevices')));
      }
      const data = await response.json();
      setTestDevices(
        asList(data, 'devices').map((d: { id: string; hostname?: string; displayName?: string }) => ({
          id: d.id,
          name: d.displayName || d.hostname || d.id
        }))
      );
    } catch (err) {
      setDevicesError(err instanceof Error ? err.message : t('alertRulesPage.failedToLoadDevices'));
    } finally {
      setDevicesLoading(false);
    }
  };

  const handleRunTest = async () => {
    if (!selectedRule || !testDeviceId) return;

    setTestResult(null);
    setSubmitting(true);

    try {
      const response = await fetchWithAuth(`/alerts/rules/${selectedRule.id}/test`, {
        method: 'POST',
        body: JSON.stringify({ deviceId: testDeviceId })
      });

      if (!response.ok) {
        if (response.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        const errData = await response.json().catch(() => null);
        throw new Error(extractApiError(errData, t('alertRulesPage.failedToTestRule')));
      }

      // Read the verdict the server actually computes. `wouldTrigger` is the
      // boolean the firing path uses; a rule that would not fire must never
      // render as a pass (#3752).
      const data = (await response.json()) as Partial<RuleTestVerdict>;

      // A response with no verdict in it is a failure to report, not a pass to
      // assume. The previous code defaulted the missing field to `true`, which
      // is exactly how every test came back green.
      if (typeof data.wouldTrigger !== 'boolean') {
        throw new Error(t('alertRulesPage.testVerdictMissing'));
      }

      setTestResult({
        status: 'verdict',
        verdict: {
          wouldTrigger: data.wouldTrigger,
          targetMatch: data.targetMatch === true,
          targetReason: data.targetReason,
          conditionResults: Array.isArray(data.conditionResults) ? data.conditionResults : [],
          rule: data.rule,
          device: data.device
        }
      });
    } catch (err) {
      setTestResult({
        status: 'error',
        message: err instanceof Error ? err.message : t('alertRulesPage.anErrorOccurred')
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggle = async (rule: AlertRule, enabled: boolean) => {
    try {
      const response = await fetchWithAuth(`/alerts/rules/${rule.id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled })
      });

      if (!response.ok) {
        if (response.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        const errData = await response.json().catch(() => null);
        throw new Error(extractApiError(errData, `Failed to ${enabled ? 'enable' : 'disable'} rule`));
      }

      setRules(prev =>
        prev.map(r => (r.id === rule.id ? { ...r, enabled } : r))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    }
  };

  const handleCloseModal = () => {
    setModalMode('closed');
    setSelectedRule(null);
    setTestResult(null);
    setTestDevices([]);
    setTestDeviceId('');
    setDevicesError(undefined);
  };

  const handleConfirmDelete = async () => {
    if (!selectedRule) return;

    const ruleToDelete = selectedRule;
    handleCloseModal();

    // Deferred execution with undo — gives the user 5 seconds to cancel
    let cancelled = false;
    showToast({
      type: 'undo',
      message: t('alertRulesPage.deletingRule', { name: ruleToDelete.name }),
      duration: 5000,
      onUndo: () => {
        cancelled = true;
        showToast({ type: 'success', message: t('alertRulesPage.deletionCancelled'), duration: 2000 });
      }
    });

    setTimeout(async () => {
      if (cancelled) return;
      try {
        const response = await fetchWithAuth(`/alerts/rules/${ruleToDelete.id}`, {
          method: 'DELETE'
        });

        if (!response.ok) {
          if (response.status === 401) {
            void navigateTo('/login', { replace: true });
            return;
          }
          const errData = await response.json().catch(() => null);
          throw new Error(extractApiError(errData, 'Failed to delete rule'));
        }

        showToast({ type: 'success', message: `"${ruleToDelete.name}" deleted` });
        await fetchRules();
      } catch (err) {
        showToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to delete alert rule. Please try again.' });
      }
    }, 5000);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">{t('alertRulesPage.loadingAlertRules')}</p>
        </div>
      </div>
    );
  }

  if (error && rules.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchRules}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {t('alertRulesPage.tryAgain')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <AlertsTabStrip currentPath="/alerts/rules" />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('alertRulesPage.alertRules')}</h1>
          <p className="text-muted-foreground">{t('alertRulesPage.configureWhenAndHowAlertsAreTriggered')}</p>
        </div>
        <div className="flex items-center gap-3">
          <a
            href="/alerts/channels"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
          >
            {t('alertRulesPage.notificationChannels')}
          </a>
          <a
            href="/alerts/rules/new"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            {t('alertRulesPage.newRule')}
          </a>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <AlertRuleList
        rules={rules}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onTest={handleTest}
        onToggle={handleToggle}
        onCreate={() => {
          void navigateTo('/alerts/rules/new');
        }}
      />

      {/* Delete Confirmation Modal */}
      {modalMode === 'delete' && selectedRule && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-xs">
            <h2 className="text-lg font-semibold">{t('alertRulesPage.deleteAlertRule')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('alertRulesPage.areYouSureYouWantToDelete')} <span className="font-medium">{selectedRule.name}</span>{t('alertRulesPage.thisActionCannotBeUndone')}
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleCloseModal}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                {t('alertRulesPage.cancel')}
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={submitting}
                className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Test Result Modal */}
      {modalMode === 'test' && selectedRule && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-xs">
            <h2 className="text-lg font-semibold">{t('alertRulesPage.testAlertRule')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('alertRulesPage.testing')} <span className="font-medium">{selectedRule.name}</span>
            </p>

            <div className="mt-4">
              <label htmlFor="test-rule-device" className="block text-sm font-medium">
                {t('alertRulesPage.testAgainstDevice')}
              </label>
              <select
                id="test-rule-device"
                value={testDeviceId}
                disabled={devicesLoading || submitting}
                onChange={(e) => {
                  // Drop the previous verdict: it belongs to the device that
                  // was selected when it was computed. Leaving it on screen
                  // beside a new selection is the same lie in a new costume.
                  setTestResult(null);
                  setTestDeviceId(e.target.value);
                }}
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60"
              >
                <option value="">
                  {devicesLoading
                    ? t('alertRulesPage.loadingDevices')
                    : t('alertRulesPage.selectADevice')}
                </option>
                {testDevices.map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.name}
                  </option>
                ))}
              </select>
              {devicesError && (
                <p className="mt-2 text-sm text-destructive">{devicesError}</p>
              )}
              {!devicesLoading && !devicesError && testDevices.length === 0 && (
                <p className="mt-2 text-sm text-muted-foreground">
                  {t('alertRulesPage.noDevicesAvailable')}
                </p>
              )}
            </div>

            {submitting ? (
              <div className="mt-4 flex items-center gap-2">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                <span className="text-sm">{t('alertRulesPage.runningTest')}</span>
              </div>
            ) : testResult?.status === 'error' ? (
              <div className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-red-700">
                <p className="text-sm font-medium">{t('alertRulesPage.testFailed')}</p>
                <p className="mt-1 text-sm">{testResult.message}</p>
              </div>
            ) : testResult?.status === 'verdict' ? (
              <div
                className={`mt-4 rounded-md border p-3 ${
                  testResult.verdict.wouldTrigger
                    ? 'border-green-500/40 bg-green-500/10 text-green-700'
                    : 'border-amber-500/40 bg-amber-500/10 text-amber-700'
                }`}
              >
                <p className="text-sm font-medium">
                  {testResult.verdict.wouldTrigger
                    ? t('alertRulesPage.ruleWouldFire')
                    : t('alertRulesPage.ruleWouldNotFire')}
                </p>

                {/* Name the device the verdict was computed for, so a verdict
                    can never be read as belonging to a different selection. */}
                {testResult.verdict.device?.hostname && (
                  <p className="mt-1 text-sm">
                    {t('alertRulesPage.evaluatedAgainst', {
                      hostname: testResult.verdict.device.hostname
                    })}
                  </p>
                )}

                {testResult.verdict.wouldTrigger && (
                  <p className="mt-1 text-sm">{t('alertRulesPage.fireSuppressionNote')}</p>
                )}

                {testResult.verdict.rule?.enabled === false && (
                  <p className="mt-1 text-sm">{t('alertRulesPage.ruleIsDisabled')}</p>
                )}

                {testResult.verdict.targetReason && (
                  <p className="mt-1 text-sm">{testResult.verdict.targetReason}</p>
                )}

                {testResult.verdict.conditionResults.length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {testResult.verdict.conditionResults.map((condition, index) => (
                      <li key={`${condition.condition}-${index}`} className="text-sm">
                        {condition.result
                          ? t('alertRulesPage.conditionMet', { condition: condition.reason })
                          : t('alertRulesPage.conditionNotMet', { condition: condition.reason })}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-sm">{t('alertRulesPage.noConditionsEvaluated')}</p>
                )}
              </div>
            ) : null}

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleCloseModal}
                className="h-10 rounded-md border px-4 text-sm font-medium transition hover:bg-muted"
              >
                {t('alertRulesPage.close')}
              </button>
              <button
                type="button"
                onClick={handleRunTest}
                disabled={!testDeviceId || submitting || devicesLoading}
                className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t('alertRulesPage.runTest')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
