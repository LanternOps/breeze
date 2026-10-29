import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { fetchWithAuth } from '@/stores/auth';
import { useOrgStore } from '@/stores/orgStore';
import { groupApiErrorMessage } from './partnerGroups';

export interface PartnerGroupEvaluation {
  state: 'pending' | 'current' | 'partial';
  evaluatedAt: string | null;
  failedOrgs: number;
}

export function AllOrgsBadge({ groupId }: { groupId: string }) {
  const { t } = useTranslation('devices');
  return <span data-testid={`group-owner-badge-${groupId}`} className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{t('partnerGroups.allOrgs')}</span>;
}

export function PartnerGroupEvaluationStatus({ groupId, evaluation }: { groupId: string; evaluation: PartnerGroupEvaluation }) {
  const { t } = useTranslation('devices');
  const time = evaluation.evaluatedAt ? formatDateTime(evaluation.evaluatedAt) : t('partnerGroups.notEvaluated');
  return (
    <div data-testid={`group-evaluation-${groupId}`} className={evaluation.state === 'partial' ? 'mt-2 text-xs text-amber-700 dark:text-amber-400' : 'mt-2 text-xs text-muted-foreground'}>
      <p>{evaluation.state === 'pending' ? t('partnerGroups.pending') : evaluation.state === 'partial' ? t('partnerGroups.partial', { count: evaluation.failedOrgs, time }) : evaluation.evaluatedAt ? t('partnerGroups.current', { time }) : t('partnerGroups.notEvaluated')}</p>
      {evaluation.state === 'partial' && <p className="mt-1">{t('partnerGroups.retryHint')}</p>}
    </div>
  );
}

interface GroupMember { deviceId: string; orgId: string; hostname: string; displayName: string | null; status: string }

export function PartnerGroupMembers({ groupId }: { groupId: string }) {
  const { t } = useTranslation('devices');
  const organizations = useOrgStore((s) => s.organizations);
  const [expanded, setExpanded] = useState(false);
  const [members, setMembers] = useState<GroupMember[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!expanded) return;
    let active = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const response = await fetchWithAuth(`/device-groups/${groupId}/devices`);
        const body = await response.json();
        if (!response.ok) throw new Error(groupApiErrorMessage(body, t('partnerGroups.membersError')));
        if (active) setMembers(body.data ?? []);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : t('partnerGroups.membersError'));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [expanded, groupId, attempt, t]);

  return (
    <div className="space-y-2">
      <button type="button" data-testid={`partner-group-members-toggle-${groupId}`} aria-expanded={expanded} aria-controls={`partner-group-members-${groupId}`} onClick={() => setExpanded(!expanded)} className="text-sm text-primary hover:underline">
        {expanded ? t('partnerGroups.hideMembers') : t('partnerGroups.showMembers')}
      </button>
      {expanded && <div id={`partner-group-members-${groupId}`}>
        {loading ? <p role="status" className="text-sm text-muted-foreground">{t('partnerGroups.loading')}</p> : error ? <div role="alert" className="text-sm text-destructive"><p>{error}</p><button type="button" onClick={() => setAttempt(attempt + 1)} className="mt-1 underline">{t('partnerGroups.retry')}</button></div> : members?.length === 0 ? <p className="text-sm text-muted-foreground">{t('partnerGroups.emptyMembers')}</p> : <div className="overflow-x-auto"><table data-testid={`partner-group-members-${groupId}`} className="w-full text-left text-sm">
          <thead><tr className="border-b"><th scope="col" className="py-2 pr-3 font-medium">{t('partnerGroups.device')}</th><th scope="col" className="py-2 pr-3 font-medium">{t('partnerGroups.organizationColumn')}</th><th scope="col" className="py-2 font-medium">{t('partnerGroups.status')}</th></tr></thead>
          <tbody>{members?.map((member) => <tr key={member.deviceId} className="border-b last:border-0"><td className="py-2 pr-3">{member.displayName ?? member.hostname}</td><td className="py-2 pr-3">{organizations.find((org) => org.id === member.orgId)?.name ?? '—'}</td><td className="py-2">{member.status}</td></tr>)}</tbody>
        </table></div>}
      </div>}
    </div>
  );
}
