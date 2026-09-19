import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../shared/Dialog';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { runAction, handleActionError, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';

type ConfigPolicy = { id: string; name: string };
type Site = { id: string; name: string };
type Group = { id: string; name: string };

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

type TargetLevel = 'organization' | 'site' | 'device_group';

export interface DeployMonitorDialogProps {
  monitorId: string;
  /**
   * The monitor's own `orgId`, or `null`/`undefined` for a partner-wide
   * monitor. Used as the `createPolicyFor.targetId` when deploying at
   * organization level — the API requires a UUID `targetId` for every level,
   * including 'organization' (`monitorDefinitions.ts` `createPolicyFor`
   * schema).
   */
  orgId?: string | null;
  open: boolean;
  onClose: () => void;
  onDeployed: () => void;
}

export default function DeployMonitorDialog({ monitorId, orgId, open, onClose, onDeployed }: DeployMonitorDialogProps) {
  const { t } = useTranslation('monitoring');
  // Org-owned monitor: deploy to its own org. Partner-wide monitor (orgId
  // null): fall back to whichever org is currently selected in the app chrome.
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const organizationTargetId = orgId ?? currentOrgId ?? null;
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [policies, setPolicies] = useState<ConfigPolicy[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedPolicyId, setSelectedPolicyId] = useState('');
  const [level, setLevel] = useState<TargetLevel>('organization');
  const [targetId, setTargetId] = useState('');
  const [policyName, setPolicyName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    void fetchWithAuth('/configuration-policies?status=active')
      .then((res) => (res.ok ? res.json() : { data: [] }))
      .then((data) => setPolicies(Array.isArray(data?.data) ? data.data : []))
      .catch(() => setPolicies([]));
    void fetchWithAuth('/orgs/sites')
      .then((res) => (res.ok ? res.json() : { data: [] }))
      .then((data) => setSites(data.data ?? data.sites ?? []))
      .catch(() => setSites([]));
    void fetchWithAuth('/groups')
      .then((res) => (res.ok ? res.json() : { data: [] }))
      .then((data) => setGroups(data.data ?? data.groups ?? []))
      .catch(() => setGroups([]));
  }, [open]);

  useEffect(() => {
    if (mode !== 'new') return;
    const targetName =
      level === 'organization'
        ? undefined
        : level === 'site'
          ? sites.find((s) => s.id === targetId)?.name
          : groups.find((g) => g.id === targetId)?.name;
    if (targetName) setPolicyName(`Monitors — ${targetName}`);
  }, [mode, level, targetId, sites, groups]);

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(undefined);
    try {
      const body =
        mode === 'existing'
          ? { configPolicyId: selectedPolicyId }
          : {
              createPolicyFor: {
                level,
                targetId: level === 'organization' ? (organizationTargetId ?? '') : targetId,
                name: policyName || undefined,
              },
            };
      await runAction({
        request: () =>
          fetchWithAuth(`/monitor-definitions/${monitorId}/attachments`, {
            method: 'POST',
            body: JSON.stringify(body),
          }),
        errorFallback: t('deploy.errors.attach'),
        successMessage: t('deploy.attached'),
        onUnauthorized: UNAUTHORIZED,
      });
      onDeployed();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      handleActionError(err, t('deploy.errors.attach'));
      setError(err instanceof Error ? err.message : t('deploy.errors.attach'));
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  const canSubmit =
    mode === 'existing'
      ? !!selectedPolicyId
      : level === 'organization'
        ? !!organizationTargetId
        : !!targetId;

  return (
    <Dialog open={open} onClose={onClose} title={t('deploy.title')} labelledBy="deploy-monitor-dialog-title">
      <div className="space-y-4" data-testid="deploy-monitor-dialog">
        <h2 id="deploy-monitor-dialog-title" className="text-sm font-semibold">
          {t('deploy.title')}
        </h2>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              checked={mode === 'existing'}
              onChange={() => setMode('existing')}
              data-testid="deploy-monitor-mode-existing"
            />
            {t('deploy.existingPolicy')}
          </label>
          {mode === 'existing' && (
            <select
              data-testid="deploy-monitor-existing-select"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              value={selectedPolicyId}
              onChange={(e) => setSelectedPolicyId(e.target.value)}
            >
              <option value="">{t('deploy.selectPolicy')}</option>
              {policies.map((policy) => (
                <option key={policy.id} value={policy.id}>
                  {policy.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              checked={mode === 'new'}
              onChange={() => setMode('new')}
              data-testid="deploy-monitor-mode-new"
            />
            {t('deploy.newPolicy')}
          </label>
          {mode === 'new' && (
            <div className="space-y-2 pl-6">
              <select
                data-testid="deploy-monitor-level-select"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                value={level}
                onChange={(e) => {
                  setLevel(e.target.value as TargetLevel);
                  setTargetId('');
                }}
              >
                {(['organization', 'site', 'device_group'] as const).map((lvl) => (
                  <option key={lvl} value={lvl}>
                    {t(/* i18n-dynamic */ `deploy.levels.${lvl}`)}
                  </option>
                ))}
              </select>
              {level === 'organization' && !organizationTargetId && (
                <p className="text-sm text-destructive" data-testid="deploy-monitor-no-org">
                  {t('deploy.noOrgSelected')}
                </p>
              )}
              {level === 'site' && (
                <select
                  data-testid="deploy-monitor-target-select"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  value={targetId}
                  onChange={(e) => setTargetId(e.target.value)}
                >
                  <option value="">{t('deploy.selectTarget')}</option>
                  {sites.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.name}
                    </option>
                  ))}
                </select>
              )}
              {level === 'device_group' && (
                <select
                  data-testid="deploy-monitor-target-select"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  value={targetId}
                  onChange={(e) => setTargetId(e.target.value)}
                >
                  <option value="">{t('deploy.selectTarget')}</option>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
              )}
              <input
                data-testid="deploy-monitor-policy-name"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                placeholder={t('deploy.policyName')}
                value={policyName}
                onChange={(e) => setPolicyName(e.target.value)}
              />
            </div>
          )}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted">
            {t('deploy.cancel')}
          </button>
          <button
            type="button"
            data-testid="deploy-monitor-submit"
            disabled={submitting || !canSubmit}
            onClick={() => void handleSubmit()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('deploy.attach')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
