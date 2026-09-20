import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { usePermissions } from '../../lib/permissions';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { runAction } from '../../lib/runAction';
import { formatMoney } from './shared/format';

type Coverage = 'billable' | 'included' | 'non_billable';
type Rule = { workTypeId: string; coverage: Coverage; hourlyRate: string | null; minimumMinutes: number | null };
type Profile = {
  id: string; name: string; currencyCode: string; isActive: boolean; isDefault: boolean;
  baseCoverage: Coverage; baseHourlyRate: string | null; baseMinimumMinutes: number | null;
  roundingIncrementMinutes: number | null; rules: Rule[];
};

/** Assignment and catalog are separate API resources. Save participates in the
 * parent's page Save; the selector never mutates on change. */
export function useOrgBillingProfile(orgId: string, currency: string, busy = false) {
  const { t } = useTranslation('billing');
  const { can } = usePermissions();
  const canRead = can('billing_profiles', 'read');
  const canWrite = can('billing_profiles', 'write');
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [workTypes, setWorkTypes] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedId, setSelectedId] = useState('');
  const [savedId, setSavedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!canRead) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    setError(false);
    void (async () => {
      try {
        const responses = await Promise.all([
          fetchWithAuth('/billing-profiles'),
          fetchWithAuth(`/orgs/organizations/${orgId}/billing-profile`),
          fetchWithAuth('/billing-profiles/work-types'),
        ]);
        if (responses.some(response => response.status === 401)) {
          void navigateTo(loginPathWithNext(), { replace: true });
          return;
        }
        if (responses.some(response => !response.ok)) throw new Error('Profile load failed');
        const [catalog, assignment, types] = await Promise.all(responses.map(response => response.json()));
        if (!Array.isArray(catalog.profiles) || !Array.isArray(types.workTypes)) throw new Error('Invalid profile response');
        if (!cancelled) {
          setProfiles(catalog.profiles);
          setWorkTypes(types.workTypes);
          const id = assignment.assignment?.billingProfileId ?? '';
          setSelectedId(id); setSavedId(id);
        }
      } catch { if (!cancelled) setError(true); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [orgId, canRead, generation]);

  const save = useCallback(async () => {
    if (!canWrite || loading || error || selectedId === savedId) return false;
    await runAction({
      request: () => fetchWithAuth(`/orgs/organizations/${orgId}/billing-profile`, selectedId
        ? { method: 'PUT', body: JSON.stringify({ billingProfileId: selectedId }) }
        : { method: 'DELETE' }),
      errorFallback: t('orgBillingProfile.saveError'),
      onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true }),
    });
    setSavedId(selectedId);
    return true;
  }, [orgId, canWrite, loading, error, selectedId, savedId, t]);

  const assigned = profiles.find(profile => profile.id === selectedId);
  const fallback = profiles.find(profile => profile.isActive && profile.isDefault && profile.currencyCode === currency);
  // Mirrors the API's whole-card selection; individual rows never inherit from
  // another profile. No preview endpoint currently exposes the resolved card.
  const resolved = assigned?.isActive && assigned.currencyCode === currency ? assigned : fallback;
  const outcome = (coverage: Coverage, rate: string | null, minimum: number | null) => {
    const label = coverage === 'billable'
      ? rate === null ? t('orgBillingProfile.noRate') : t('orgBillingProfile.billable', { rate: formatMoney(rate, resolved!.currencyCode) })
      : coverage === 'included' ? t('orgBillingProfile.included') : t('orgBillingProfile.nonBillable');
    return minimum && coverage === 'billable' ? t('orgBillingProfile.minimum', { outcome: label, minutes: minimum }) : label;
  };
  const panel = !canRead ? null : (
    <div className="mt-4" data-testid="org-billing-profile-panel">
      <label htmlFor="org-billing-profile" className="text-sm font-medium">{t('orgBillingProfile.label')}</label>
      {error ? <p className="mt-1 text-sm text-destructive" role="alert">{t('orgBillingProfile.loadError')} <button type="button" className="underline" data-testid="org-billing-profile-retry" onClick={() => setGeneration(value => value + 1)}>{t('common:actions.retry')}</button></p> : (
        <select id="org-billing-profile" data-testid="org-billing-profile" value={selectedId} disabled={busy || loading || !canWrite} onChange={event => setSelectedId(event.target.value)} className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm disabled:opacity-50">
          <option value="">{loading ? t('common:states.loading') : t('orgBillingProfile.inherit', { name: fallback?.name ?? t('orgBillingProfile.noProfile') })}</option>
          {profiles.filter(profile => (profile.isActive && profile.currencyCode === currency) || profile.id === selectedId).map(profile => <option key={profile.id} value={profile.id} disabled={!profile.isActive || profile.currencyCode !== currency}>{profile.name} ({profile.currencyCode})</option>)}
          {selectedId && !assigned && <option value={selectedId} disabled>{t('orgBillingProfile.unavailable')}</option>}
        </select>
      )}
      {!error && !loading && selectedId && (!assigned?.isActive || assigned.currencyCode !== currency) && <p role="status" data-testid="org-billing-profile-mismatch" className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">{t('orgBillingProfile.mismatch')}</p>}
      {!error && !loading && resolved && <div className="mt-3 text-sm" data-testid="org-billing-profile-rates">
        <p className="font-medium">{t('orgBillingProfile.resolved', { name: resolved.name })}</p>
        <dl className="mt-2 space-y-1">
          <div className="flex flex-wrap justify-between gap-2"><dt>{t('orgBillingProfile.allOtherWork')}</dt><dd>{outcome(resolved.baseCoverage, resolved.baseHourlyRate, resolved.baseMinimumMinutes)}</dd></div>
          {resolved.rules.map(rule => <div key={rule.workTypeId} className="flex flex-wrap justify-between gap-2"><dt>{workTypes.find(type => type.id === rule.workTypeId)?.name ?? t('orgBillingProfile.archivedWorkType')}</dt><dd>{outcome(rule.coverage, rule.hourlyRate, rule.minimumMinutes)}</dd></div>)}
        </dl>
        {resolved.roundingIncrementMinutes !== null && <p className="mt-2 text-muted-foreground">{t('orgBillingProfile.rounding', { minutes: resolved.roundingIncrementMinutes })}</p>}
      </div>}
    </div>
  );
  return { panel, save };
}
