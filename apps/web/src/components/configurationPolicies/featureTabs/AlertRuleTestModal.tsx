import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { extractApiError } from '@/lib/apiError';
import { asList } from '@/lib/asList';
import type { Condition } from './AlertRuleTab';

type TestConditionResult = { condition: string; result: boolean; reason: string };

/**
 * The verdict the API actually returns for
 * POST /configuration-policies/:id/alert-rules/test.
 *
 * `wouldTrigger` mirrors the two halves the firing path applies — does this
 * policy provide the device's alert rules (`targetMatch`), and does the
 * evaluator say the conditions are met — and `targetReason` /
 * `conditionResults` explain which half produced a negative. It is NOT a
 * promise that an alert row appears: the config-policy firing path is
 * evaluateDeviceAlertsFromPolicy (NOT createAlert — that one owns the
 * standalone-rule path), which additionally skips a device inside a suppressing
 * maintenance window and applies cooldown, open-alert dedup and flapping
 * suppression. None of that is simulated — hence the caveat rendered alongside
 * a positive verdict.
 *
 * There is deliberately no `success` / `message` pair here — reading those
 * invented fields is what made every test report "Test Passed" (#3752), and
 * shipping the fix to an unroutable component is what made it invisible (#3988).
 */
type RuleTestVerdict = {
  wouldTrigger: boolean;
  targetMatch: boolean;
  targetReason?: string;
  conditionResults: TestConditionResult[];
  device?: { hostname?: string };
};

type TestState =
  | { status: 'error'; message: string }
  | { status: 'verdict'; verdict: RuleTestVerdict };

type TestDevice = { id: string; name: string };

type AlertRuleTestModalProps = {
  /** Configuration policy that owns the rule being tested. */
  policyId: string;
  /** Rule name, for the modal subtitle only. */
  ruleName: string;
  /**
   * The conditions currently on screen — including edits that have not been
   * saved. Testing the draft rather than a persisted row is the point: config
   * policy alert rules carry no stable id to address, and a tech tuning a
   * threshold wants a verdict on the number they just typed.
   *
   * Typed as the editor's own `Condition` — deliberately wider than
   * `alertRuleConditionSchema` so a legacy retired type still round-trips — so
   * a caller cannot hand this modal something that is not a condition at all
   * and discover it only as a 400.
   */
  conditions: Condition[];
  onClose: () => void;
};

export default function AlertRuleTestModal({
  policyId,
  ruleName,
  conditions,
  onClose,
}: AlertRuleTestModalProps) {
  const { t } = useTranslation('alerts');
  const [devices, setDevices] = useState<TestDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [devicesError, setDevicesError] = useState<string>();
  const [deviceId, setDeviceId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [testResult, setTestResult] = useState<TestState | null>(null);

  // The endpoint evaluates a rule against ONE device and requires a deviceId
  // body, so the modal has to ask which device before it can test anything.
  useEffect(() => {
    let cancelled = false;

    const loadDevices = async () => {
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
        if (cancelled) return;
        setDevices(
          asList(data, 'devices').map(
            (d: { id: string; hostname?: string; displayName?: string }) => ({
              id: d.id,
              name: d.displayName || d.hostname || d.id,
            })
          )
        );
      } catch (err) {
        if (cancelled) return;
        setDevicesError(
          err instanceof Error ? err.message : t('alertRulesPage.failedToLoadDevices')
        );
      } finally {
        if (!cancelled) setDevicesLoading(false);
      }
    };

    void loadDevices();
    return () => {
      cancelled = true;
    };
  }, [t]);

  const handleRunTest = async () => {
    if (!deviceId) return;

    setTestResult(null);
    setSubmitting(true);

    try {
      // runaction-exempt: the verdict panel below IS the outcome surface — both
      // the failure and the negative verdict render inline, and a toast would
      // report "done" for a test whose whole payload is the answer.
      const response = await fetchWithAuth(
        `/configuration-policies/${policyId}/alert-rules/test`,
        {
          method: 'POST',
          body: JSON.stringify({ deviceId, conditions }),
        }
      );

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
      // assume. Defaulting a missing field to `true` is exactly how every test
      // used to come back green.
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
          device: data.device,
        },
      });
    } catch (err) {
      setTestResult({
        status: 'error',
        message: err instanceof Error ? err.message : t('alertRulesPage.anErrorOccurred'),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">{t('alertRulesPage.testAlertRule')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('alertRulesPage.testing')}{' '}
          <span data-testid="alert-rule-test-rule-name" className="font-medium">
            {ruleName}
          </span>
        </p>

        <div className="mt-4">
          <label htmlFor="policy-alert-rule-test-device" className="block text-sm font-medium">
            {t('alertRulesPage.testAgainstDevice')}
          </label>
          <select
            id="policy-alert-rule-test-device"
            data-testid="alert-rule-test-device"
            value={deviceId}
            disabled={devicesLoading || submitting}
            onChange={(e) => {
              // Drop the previous verdict: it belongs to the device that was
              // selected when it was computed. Leaving it on screen beside a new
              // selection is the same lie in a new costume.
              setTestResult(null);
              setDeviceId(e.target.value);
            }}
            className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value="">
              {devicesLoading
                ? t('alertRulesPage.loadingDevices')
                : t('alertRulesPage.selectADevice')}
            </option>
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
          </select>
          {devicesError && <p className="mt-2 text-sm text-destructive">{devicesError}</p>}
          {!devicesLoading && !devicesError && devices.length === 0 && (
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
            data-testid="alert-rule-test-verdict"
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

            {/* Name the device the verdict was computed for, so a verdict can
                never be read as belonging to a different selection. */}
            {testResult.verdict.device?.hostname && (
              <p className="mt-1 text-sm">
                {t('alertRulesPage.evaluatedAgainst', {
                  hostname: testResult.verdict.device.hostname,
                })}
              </p>
            )}

            {testResult.verdict.wouldTrigger && (
              <p className="mt-1 text-sm">{t('alertRulesPage.fireSuppressionNote')}</p>
            )}

            {/* Why a negative happened: the policy not applying to this device is
                a completely different remedy from a condition not being met. */}
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
            onClick={onClose}
            className="h-10 rounded-md border px-4 text-sm font-medium transition hover:bg-muted"
          >
            {t('alertRulesPage.close')}
          </button>
          <button
            type="button"
            onClick={handleRunTest}
            disabled={!deviceId || submitting || devicesLoading}
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('alertRulesPage.runTest')}
          </button>
        </div>
      </div>
    </div>
  );
}
