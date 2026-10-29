import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { extractApiError } from '@/lib/apiError';
import { ActionError, handleActionError, runAction } from '@/lib/runAction';
import { AssignmentFilterBadges, assignmentFilterPayload } from './AssignmentRoleOsFilters';

type Assignment = {
  id: string;
  level: string;
  targetId: string;
  roleFilter?: string[] | null;
  osFilter?: string[] | null;
};
type Props = {
  policyId: string;
  assignments: Assignment[];
  roleFilter: string[];
  osFilter: string[];
  disabled: boolean;
  onChanged: () => void | Promise<void>;
};
type Group = { id: string; name: string };

export default function PartnerGroupAssignmentSection({ policyId, assignments, roleFilter, osFilter, disabled, onChanged }: Props) {
  const { t } = useTranslation('policies');
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [error, setError] = useState<string>();
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(undefined);
    void (async () => {
      try {
        const response = await fetchWithAuth('/device-groups?ownerScope=partner', { skipOrgIdInjection: true });
        const body = await response.json();
        if (!response.ok) throw new Error(extractApiError(body, t('configurationPolicies.partnerGroupAssignment.failedToLoad')));
        if (!cancelled) setGroups(Array.isArray(body.data) ? body.data : []);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : t('configurationPolicies.partnerGroupAssignment.failedToLoad'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [policyId, t]);

  const groupAssignments = assignments.filter((assignment) => assignment.level === 'device_group');
  const availableGroups = groups.filter((group) => !groupAssignments.some((assignment) => assignment.targetId === group.id));
  const blocked = disabled || busy;
  const assign = async () => {
    if (blocked || !availableGroups.some((group) => group.id === selectedId)) return;
    setBusy(true);
    setError(undefined);
    try {
      await runAction({
        request: () => fetchWithAuth(`/configuration-policies/${policyId}/assignments`, {
          method: 'POST',
          body: JSON.stringify({ level: 'device_group', targetId: selectedId, priority: 0, ...assignmentFilterPayload(roleFilter, osFilter) }),
        }),
        errorFallback: t('configurationPolicies.partnerGroupAssignment.failedToAssign'),
        successMessage: t('configurationPolicies.partnerGroupAssignment.assigned'),
      });
      setSelectedId('');
      await onChanged();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      handleActionError(err, t('configurationPolicies.partnerGroupAssignment.failedToAssign'));
      setError(err instanceof Error ? err.message : t('configurationPolicies.partnerGroupAssignment.failedToAssign'));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (assignment: Assignment) => {
    if (blocked) return;
    setBusy(true);
    setError(undefined);
    try {
      await runAction({
        request: () => fetchWithAuth(`/configuration-policies/${policyId}/assignments/${assignment.id}`, { method: 'DELETE' }),
        errorFallback: t('configurationPolicies.partnerGroupAssignment.failedToRemove'),
        successMessage: t('configurationPolicies.partnerGroupAssignment.removed'),
      });
      await onChanged();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      handleActionError(err, t('configurationPolicies.partnerGroupAssignment.failedToRemove'));
      setError(err instanceof Error ? err.message : t('configurationPolicies.partnerGroupAssignment.failedToRemove'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-testid="policy-partner-groups" className="rounded-lg border bg-card p-6 shadow-xs">
      <h2 className="text-lg font-semibold">{t('configurationPolicies.partnerGroupAssignment.title')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('configurationPolicies.partnerGroupAssignment.description')}</p>
      {groupAssignments.length > 0 && (
        <ul className="mt-4 divide-y rounded-md border">
          {groupAssignments.map((assignment) => (
            <li key={assignment.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <span className="block break-words">{groups.find((group) => group.id === assignment.targetId)?.name ?? assignment.targetId}</span>
                <AssignmentFilterBadges roleFilter={assignment.roleFilter} osFilter={assignment.osFilter} />
              </div>
              <button type="button" data-testid={`policy-partner-group-remove-${assignment.targetId}`} disabled={blocked} onClick={() => void remove(assignment)} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50">
                {t('configurationPolicies.partnerGroupAssignment.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {loading && <p role="status" className="mt-4 text-sm text-muted-foreground">{t('configurationPolicies.partnerGroupAssignment.loading')}</p>}
      {loadError && <p role="alert" className="mt-4 text-sm text-destructive">{loadError}</p>}
      {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
      {!loading && !loadError && groups.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground"><a href="/devices/groups#owner=partner" className="text-primary underline underline-offset-4">{t('configurationPolicies.partnerGroupAssignment.empty')}</a></p>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          <select data-testid="policy-partner-group-select" aria-label={t('configurationPolicies.partnerGroupAssignment.selectGroup')} value={selectedId} onChange={(event) => setSelectedId(event.target.value)} disabled={blocked || loading || !!loadError} className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring">
            <option value="">{t('configurationPolicies.partnerGroupAssignment.selectGroup')}</option>
            {availableGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
          <button type="button" data-testid="policy-partner-group-assign" onClick={() => void assign()} disabled={blocked || loading || !!loadError || !availableGroups.some((group) => group.id === selectedId)} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">{t('configurationPolicies.partnerGroupAssignment.assign')}</button>
        </div>
      )}
    </section>
  );
}
