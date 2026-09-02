import { Fragment, useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, ShieldCheck } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, handleActionError, runAction } from '../../lib/runAction';

type EvidenceCard = {
  partner: {
    id: string;
    name: string;
    slug: string;
    plan: string;
    status: string;
    trustState: string;
  };
  signup: { ip: string | null; ipClass: string; asn: number | null };
  emailDomain: { domain: string | null; ageDays: null; hasMx: boolean | null };
  identity: {
    userName: string | null;
    userEmail: string | null;
    cardholderName: string | null;
    namesMatch: boolean | null;
  };
  billing: {
    distinctPaymentMethods: number;
    failedAttempts: number;
    region: string | null;
  };
  devices: Array<{
    hostname: string;
    enrollmentIpClass: string;
    isVirtual: boolean;
    enrollmentIp: string | null;
  }>;
  denials24h: number;
  matchedSuspendedAxes: Array<'email_domain' | 'billing_card_fingerprint'>;
};

type TrustQueueRow = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  trustState: string;
  trustReason: string | null;
  trustChangedAt: string | null;
  trustReviewRequestedAt: string | null;
  createdAt: string;
  signupIp: string | null;
  signupIpClass: string;
  signupIpAsn: number | null;
  deviceCount: number;
  card?: EvidenceCard;
};

type QueueResponse = {
  partners: TrustQueueRow[];
  nextCursor: string | null;
};

type LoadState = 'loading' | 'ready' | 'unauthorized' | 'error';
type TrustAction = 'approve' | 'restrict' | 'suspend';

function formatDate(value: string | null): string {
  if (!value) return 'Not requested';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const displayValue = (value: string | number | null) => value ?? 'Not available';
const displayBoolean = (value: boolean | null) => value === null ? 'Not available' : value ? 'Yes' : 'No';

function EvidenceCardDetails({ card }: { card: EvidenceCard }) {
  return (
    <div className="space-y-5" data-testid={`trust-queue-card-${card.partner.id}`}>
      <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div><dt className="text-muted-foreground">User name</dt><dd className="font-medium">{displayValue(card.identity.userName)}</dd></div>
        <div><dt className="text-muted-foreground">Cardholder name</dt><dd className="font-medium">{displayValue(card.identity.cardholderName)}</dd></div>
        <div><dt className="text-muted-foreground">Names match</dt><dd className="font-medium">{displayBoolean(card.identity.namesMatch)}</dd></div>
        <div><dt className="text-muted-foreground">Billing region</dt><dd className="font-medium">{displayValue(card.billing.region)}</dd></div>
        <div><dt className="text-muted-foreground">Payment methods</dt><dd className="font-medium">{card.billing.distinctPaymentMethods}</dd></div>
        <div><dt className="text-muted-foreground">Payment failures</dt><dd className="font-medium">{card.billing.failedAttempts}</dd></div>
        <div><dt className="text-muted-foreground">Denials in last 24 h</dt><dd className="font-medium">{card.denials24h}</dd></div>
        <div>
          <dt className="text-muted-foreground">Matched suspended axes</dt>
          <dd className="font-medium">
            {card.matchedSuspendedAxes.length
              ? card.matchedSuspendedAxes.map((axis) => axis === 'email_domain' ? 'Email domain' : 'Billing card fingerprint').join(', ')
              : 'None'}
          </dd>
        </div>
      </dl>

      <div>
        <h3 className="text-sm font-semibold">Devices</h3>
        {card.devices.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No enrolled devices</p>
        ) : (
          <div className="mt-2 overflow-x-auto rounded-md border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                <tr><th className="px-3 py-2">Hostname</th><th className="px-3 py-2">Enrollment IP class</th><th className="px-3 py-2">Virtual</th></tr>
              </thead>
              <tbody className="divide-y">
                {card.devices.map((device, index) => (
                  <tr key={`${device.hostname}-${index}`}>
                    <td className="px-3 py-2 font-medium">{device.hostname}</td>
                    <td className="px-3 py-2">{device.enrollmentIpClass}</td>
                    <td className="px-3 py-2">{device.isVirtual ? 'Yes' : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default function TrustQueue() {
  const [rows, setRows] = useState<TrustQueueRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [actingOn, setActingOn] = useState<string | null>(null);

  const loadPage = useCallback(async (cursor?: string) => {
    if (cursor) setLoadingMore(true);
    else setLoadState('loading');

    try {
      // Cards are requested with each bounded page. Expansion is therefore
      // instant and never triggers an unbounded per-row request waterfall.
      const url = `/admin/trust/queue?limit=50&card=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const response = await fetchWithAuth(url);
      if (response.status === 401 || response.status === 403) {
        setLoadState('unauthorized');
        return;
      }
      if (!response.ok) {
        setLoadState('error');
        return;
      }
      const body = await response.json() as QueueResponse;
      setRows((current) => cursor ? [...current, ...body.partners] : body.partners);
      setNextCursor(body.nextCursor);
      setLoadState('ready');
    } catch {
      setLoadState('error');
    } finally {
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  const act = async (row: TrustQueueRow, action: TrustAction) => {
    const reason = window.prompt(`Reason for ${action === 'approve' ? 'approving' : action === 'restrict' ? 'restricting' : 'suspending'} ${row.name}:`);
    if (reason === null) return;

    let confirmEmail: string | null = null;
    if (action === 'suspend') {
      confirmEmail = window.prompt('Confirm your platform-admin account email:');
      if (confirmEmail === null) return;
    }

    let override: true | undefined;
    if (action === 'approve' && row.trustState === 'restricted') {
      if (!window.confirm('This partner is restricted. Approve with an override?')) return;
      override = true;
    }

    const endpoint = action === 'approve'
      ? `/admin/partners/${encodeURIComponent(row.id)}/trust/promote`
      : action === 'restrict'
        ? `/admin/partners/${encodeURIComponent(row.id)}/trust/restrict`
        : `/admin/partners/${encodeURIComponent(row.id)}/suspend-for-abuse`;
    const body = action === 'suspend'
      ? { reason, confirmEmail }
      : { reason, ...(override ? { override } : {}) };

    setActingOn(row.id);
    try {
      await runAction({
        request: () => fetchWithAuth(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        errorFallback: `Unable to ${action} partner`,
        successMessage: action === 'approve'
          ? 'Partner approved'
          : action === 'restrict'
            ? 'Partner restricted'
            : 'Partner suspended',
      });

      if (action === 'approve') {
        setRows((current) => current.filter((candidate) => candidate.id !== row.id));
      } else {
        setRows((current) => current.map((candidate) => candidate.id === row.id
          ? {
              ...candidate,
              trustState: action === 'restrict' ? 'restricted' : candidate.trustState,
              status: action === 'suspend' ? 'suspended' : candidate.status,
              trustReason: reason,
              trustChangedAt: new Date().toISOString(),
            }
          : candidate));
      }
    } catch (error) {
      if (error instanceof ActionError && (error.status === 401 || error.status === 403)) {
        setLoadState('unauthorized');
      } else {
        handleActionError(error, `Unable to ${action} partner`);
      }
    } finally {
      setActingOn(null);
    }
  };

  if (loadState === 'loading') {
    return <p className="py-12 text-center text-sm text-muted-foreground">Loading partner trust queue…</p>;
  }
  if (loadState === 'unauthorized') {
    return <p className="rounded-lg border bg-card p-6" data-testid="trust-queue-requires-platform-admin">Sign in as a platform admin</p>;
  }
  if (loadState === 'error') {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center" role="alert">
        <p className="text-sm text-destructive">Unable to load the partner trust queue</p>
        <button type="button" onClick={() => void loadPage()} className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Retry</button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Partner trust queue</h1>
        <p className="mt-1 text-sm text-muted-foreground">Review partner evidence and take an operator action.</p>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border bg-card p-12 text-center" data-testid="trust-queue-empty">
          <ShieldCheck className="mx-auto h-12 w-12 text-muted-foreground/40" />
          <h2 className="mt-4 text-lg font-semibold">The trust queue is empty</h2>
          <p className="mt-2 text-sm text-muted-foreground">There are no partners awaiting trust review.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full min-w-[1100px] border-collapse text-left text-sm">
            <thead className="bg-muted/40 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="w-10 px-3 py-3"><span className="sr-only">Evidence</span></th>
                <th className="px-3 py-3">Partner</th>
                <th className="px-3 py-3">Plan</th>
                <th className="px-3 py-3">Trust state</th>
                <th className="px-3 py-3">Reason</th>
                <th className="px-3 py-3">Changed</th>
                <th className="px-3 py-3">Signup IP</th>
                <th className="px-3 py-3">Devices</th>
                <th className="px-3 py-3">Review requested</th>
                <th className="px-3 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isExpanded = expanded.has(row.id);
                const isActing = actingOn === row.id;
                return (
                  <Fragment key={row.id}>
                    <tr className="border-t" data-testid={`trust-queue-row-${row.id}`}>
                      <td className="px-3 py-3 align-top">
                        <button
                          type="button"
                          onClick={() => setExpanded((current) => {
                            const next = new Set(current);
                            if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
                            return next;
                          })}
                          aria-expanded={isExpanded}
                          aria-label={`${isExpanded ? 'Hide' : 'Show'} evidence for ${row.name}`}
                          data-testid={`trust-queue-expand-${row.id}`}
                          className="rounded p-1 hover:bg-muted"
                        >
                          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </button>
                      </td>
                      <td className="px-3 py-3 align-top"><span className="font-medium">{row.name}</span><div className="text-xs text-muted-foreground">{row.slug}</div></td>
                      <td className="px-3 py-3 align-top">{row.plan}</td>
                      <td className="px-3 py-3 align-top">{row.trustState}</td>
                      <td className="max-w-56 px-3 py-3 align-top text-muted-foreground">{row.trustReason ?? 'Not available'}</td>
                      <td className="px-3 py-3 align-top text-muted-foreground">{formatDate(row.trustChangedAt)}</td>
                      <td className="px-3 py-3 align-top"><span>{row.signupIpClass}</span><div className="text-xs text-muted-foreground">ASN {displayValue(row.signupIpAsn)}</div></td>
                      <td className="px-3 py-3 align-top">{row.deviceCount}</td>
                      <td className="px-3 py-3 align-top text-muted-foreground">{formatDate(row.trustReviewRequestedAt)}</td>
                      <td className="px-3 py-3 align-top">
                        <div className="flex justify-end gap-2">
                          <button type="button" disabled={isActing} onClick={() => void act(row, 'approve')} className="rounded-md bg-emerald-600 px-3 py-2 text-xs font-medium text-white disabled:opacity-60">Approve</button>
                          <button type="button" disabled={isActing} onClick={() => void act(row, 'restrict')} className="rounded-md border px-3 py-2 text-xs font-medium disabled:opacity-60">Restrict</button>
                          <button type="button" disabled={isActing} onClick={() => void act(row, 'suspend')} className="rounded-md bg-destructive px-3 py-2 text-xs font-medium text-destructive-foreground disabled:opacity-60">Suspend</button>
                        </div>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="border-t bg-muted/20">
                        <td colSpan={10} className="px-6 py-5">
                          {row.card ? <EvidenceCardDetails card={row.card} /> : <p className="text-sm text-muted-foreground">Evidence is not available.</p>}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {nextCursor && (
        <div className="text-center">
          <button
            type="button"
            onClick={() => void loadPage(nextCursor)}
            disabled={loadingMore}
            className="rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-60"
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
