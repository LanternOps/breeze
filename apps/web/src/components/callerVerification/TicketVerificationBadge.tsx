import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { freshForTicket, type TicketVerification } from '@/lib/api/callerVerification';
import { useCallerVerificationEnabled } from '@/lib/useCallerVerificationEnabled';

type Props = { orgId: string; ticketId: string; /** Bump to re-read after a verification change. */ revision?: number };
type BadgeState = 'fresh' | 'consumed' | 'stale' | 'pending' | 'failed' | 'none' | 'loadFailed';

const FAILED = new Set(['rejected_by_user', 'wrong_choice', 'undeliverable']);

/** Ticket-header freshness badge, driven only by the server's ticket projection. */
export function TicketVerificationBadge(props: Props) {
  return useCallerVerificationEnabled() ? <LoadedBadge key={`${props.orgId}:${props.ticketId}`} {...props} /> : null;
}

function stateOf(data: TicketVerification): BadgeState {
  const r = data.row;
  if (!r) return 'none';
  if (data.isConsumed) return 'consumed';
  if (r.status === 'verified') return data.isFresh ? 'fresh' : 'stale';
  if (r.status === 'pending') return 'pending';
  if (FAILED.has(r.status)) return 'failed';
  return 'none';
}

const tone: Record<BadgeState, string> = {
  fresh: 'border-success/40 bg-success/10 text-success',
  consumed: 'border-border text-muted-foreground',
  stale: 'border-border text-muted-foreground',
  pending: 'border-warning/40 bg-warning/10 text-warning',
  failed: 'border-destructive/40 bg-destructive/10 text-destructive',
  none: 'border-border text-muted-foreground',
  loadFailed: 'border-border text-muted-foreground',
};

function LoadedBadge({ orgId, ticketId, revision }: Props) {
  const { t } = useTranslation('callerVerificationTech');
  const [data, setData] = useState<TicketVerification | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    freshForTicket(orgId, ticketId, controller.signal)
      .then((result) => { if (!controller.signal.aborted) { setData(result); setFailed(false); } })
      .catch(() => { if (!controller.signal.aborted) { setData(null); setFailed(true); } });
    return () => controller.abort();
  }, [orgId, ticketId, revision]);

  if (!data && !failed) return null;
  const state: BadgeState = failed || !data ? 'loadFailed' : stateOf(data);
  const label = state === 'fresh' ? t('badge.fresh', { tier: data!.row!.tier }) : t(/* i18n-dynamic */ `badge.${state}`);
  const decided = data?.row?.decidedAt;
  return (
    <span data-testid="cv-badge" data-state={state} title={t('badge.label')}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${tone[state]}`}>
      {label}
      {state === 'fresh' && decided && <span className="font-normal opacity-80">· {new Date(decided).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
    </span>
  );
}
