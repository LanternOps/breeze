import { useCallback, useEffect, useState } from 'react';
import { ClipboardCheck } from 'lucide-react';
import { portalApi, type PortalApproval } from '@/lib/api';
import { approvalAskSentence } from '@/lib/approvalText';
import { cn } from '@/lib/utils';
import { ApprovalDecisionPanel } from './ApprovalDecisionPanel';
import { EmptyState, ErrorNotice, PageHeader, StatusMark, type MarkTone } from './ui';

interface ApprovalsListProps {
  approvals: PortalApproval[];
  error?: string | null;
}

function statusMark(a: PortalApproval): { tone: MarkTone; label: string } {
  switch (a.status) {
    case 'pending':
      return a.canDecide
        ? { tone: 'warning', label: 'Awaiting your decision' }
        : { tone: 'primary', label: 'Awaiting a decision' };
    case 'approved':
      return { tone: 'success', label: 'Approved' };
    case 'denied':
      return { tone: 'neutral', label: 'Declined' };
    case 'expired':
      return { tone: 'neutral', label: 'Expired' };
    case 'cancelled':
      return { tone: 'neutral', label: 'Cancelled' };
  }
}

/** Pending first (soonest to expire on top), then settled newest first. */
function sortApprovals(items: PortalApproval[]): PortalApproval[] {
  const time = (iso: string | null) => (iso ? Date.parse(iso) || 0 : 0);
  return [...items].sort((a, b) => {
    const ap = a.status === 'pending';
    const bp = b.status === 'pending';
    if (ap !== bp) return ap ? -1 : 1;
    if (ap) return time(a.expiresAt) - time(b.expiresAt);
    return time(b.decidedAt ?? b.requestedAt) - time(a.decidedAt ?? a.requestedAt);
  });
}

function readHashId(): string | null {
  if (typeof window === 'undefined') return null;
  const id = decodeURIComponent(window.location.hash.replace(/^#/, ''));
  return id || null;
}

/**
 * Work-approval requests (#8200). The selected request lives in
 * window.location.hash (`/approvals#<id>`), which is also the deep link the
 * notification email carries.
 */
export function ApprovalsList({ approvals: initial, error }: ApprovalsListProps) {
  const [approvals, setApprovals] = useState(initial);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => setSelectedId(readHashId());
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const reload = useCallback(async () => {
    const response = await portalApi.getApprovals({});
    // A failed refetch keeps what is on screen; the panel already told the
    // customer why their action did not go through.
    if (response.data?.data) setApprovals(response.data.data);
  }, []);

  const select = (id: string) => {
    window.location.hash = id;
    setSelectedId(id);
  };

  if (error) {
    return <ErrorNotice>{error}</ErrorNotice>;
  }

  const sorted = sortApprovals(approvals);

  return (
    <div>
      <PageHeader
        title="Approvals"
        lede="Work your IT team needs your go-ahead on before it is billed."
      />

      {sorted.length === 0 ? (
        <EmptyState
          data-testid="portal-approvals-empty"
          icon={<ClipboardCheck className="h-10 w-10" strokeWidth={1.5} />}
          title="No approval requests"
        >
          <p className="mt-1 text-sm text-muted-foreground">
            When your IT team needs your approval for extra work, it appears here.
          </p>
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border/70 border-y border-border/70">
          {sorted.map((a) => {
            const mark = statusMark(a);
            const selected = a.id === selectedId;
            return (
              <li key={a.id} className="py-1">
                <button
                  type="button"
                  data-testid="approval-row"
                  aria-expanded={selected}
                  onClick={() => select(a.id)}
                  className={cn(
                    'flex w-full flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-md px-3 py-3 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    selected && 'bg-accent/40'
                  )}
                >
                  <span className="min-w-0">
                    <span className="block font-semibold text-foreground">
                      {a.ticketNumber} <span className="font-normal">{a.ticketSubject}</span>
                    </span>
                    <span className="block text-sm text-muted-foreground">{approvalAskSentence(a)}</span>
                  </span>
                  <StatusMark tone={mark.tone} data-testid={`approval-status-${a.id}`}>
                    {mark.label}
                  </StatusMark>
                </button>
                {selected && (
                  <div className="px-3 pb-3 pt-2">
                    <ApprovalDecisionPanel approval={a} onChanged={reload} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default ApprovalsList;
