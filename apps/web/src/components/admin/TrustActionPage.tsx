import { useEffect, useState, type FormEvent } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, runAction } from '../../lib/runAction';

type InvalidReason = 'bad_signature' | 'expired' | 'used' | 'operator_mismatch';
type TrustAction = 'approve' | 'suspend';

interface EvidenceCard {
  partner: {
    id: string;
    name: string;
    slug: string;
    plan: string;
    status: string;
    trustState: string;
  };
  signup: { ip: string | null; ipClass: string; asn: number | null };
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
}

type ValidPreview = {
  valid: true;
  action: TrustAction;
  partner: { id: string; name: string; slug: string; plan: string; trustState: string };
  card: EvidenceCard;
};

type PageState =
  | { kind: 'loading' }
  | { kind: 'unauthorized' }
  | { kind: 'invalid'; reason: InvalidReason }
  | { kind: 'error' }
  | { kind: 'ready'; preview: ValidPreview }
  | { kind: 'success'; trustState: string };

const invalidReasonCopy: Record<InvalidReason, string> = {
  expired: 'This link has expired',
  used: 'This link was already used',
  operator_mismatch: 'This link was issued to a different operator',
  bad_signature: 'This link is not valid',
};

const displayValue = (value: string | number | null) => value ?? 'Not available';
const displayBoolean = (value: boolean | null) => value === null ? 'Not available' : value ? 'Yes' : 'No';
const displayAxis = (axis: EvidenceCard['matchedSuspendedAxes'][number]) =>
  axis === 'email_domain' ? 'Email domain' : 'Billing card fingerprint';

export default function TrustActionPage() {
  const [state, setState] = useState<PageState>({ kind: 'loading' });
  const [token, setToken] = useState('');
  const [totp, setTotp] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const queryToken = new URLSearchParams(window.location.search).get('token') ?? '';
    setToken(queryToken);
    let active = true;

    void (async () => {
      try {
        const response = await fetchWithAuth(
          `/admin/trust/act/preview?token=${encodeURIComponent(queryToken)}`,
        );
        if (!active) return;
        if (response.status === 401 || response.status === 403) {
          setState({ kind: 'unauthorized' });
          return;
        }
        if (!response.ok) {
          setState({ kind: 'error' });
          return;
        }
        const body = await response.json() as ValidPreview | { valid: false; reason: InvalidReason };
        if (!active) return;
        setState(body.valid ? { kind: 'ready', preview: body } : { kind: 'invalid', reason: body.reason });
      } catch {
        if (active) setState({ kind: 'error' });
      }
    })();

    return () => { active = false; };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (state.kind !== 'ready' || totp.length !== 6 || submitting) return;
    setSubmitting(true);
    try {
      const result = await runAction<{ trustState?: string; status?: string }>({
        request: () => fetchWithAuth('/admin/trust/act', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, totp }),
        }),
        errorFallback: 'Unable to complete the trust action',
        successMessage: 'Trust action completed',
      });
      setState({ kind: 'success', trustState: result.trustState ?? result.status ?? 'updated' });
    } catch (error) {
      // runAction has already surfaced API and network failures.
      if (!(error instanceof ActionError)) console.error(error);
    } finally {
      setSubmitting(false);
    }
  };

  if (state.kind === 'loading') {
    return <p className="py-12 text-center text-sm text-muted-foreground">Loading trust action…</p>;
  }
  if (state.kind === 'unauthorized') {
    return <p className="rounded-lg border bg-card p-6">Sign in as a platform admin to continue</p>;
  }
  if (state.kind === 'invalid') {
    return <p className="rounded-lg border bg-card p-6">{invalidReasonCopy[state.reason]}</p>;
  }
  if (state.kind === 'error') {
    return <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-destructive">Unable to load this trust action</p>;
  }
  if (state.kind === 'success') {
    return (
      <div className="rounded-lg border bg-card p-6" data-testid="trust-action-success">
        <h1 className="text-xl font-semibold">Trust action completed</h1>
        <p className="mt-2 text-sm text-muted-foreground">Resulting trust state: <strong className="text-foreground">{state.trustState}</strong></p>
      </div>
    );
  }

  const { preview } = state;
  const { card } = preview;
  const actionLabel = preview.action === 'approve' ? 'Approve partner' : 'Suspend partner';

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{actionLabel}</h1>
        <p className="mt-1 text-sm text-muted-foreground">Review the partner evidence before confirming this action.</p>
      </div>

      <section className="rounded-lg border bg-card p-6" aria-labelledby="partner-summary-heading">
        <h2 id="partner-summary-heading" className="text-lg font-semibold">Partner summary</h2>
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div><dt className="text-muted-foreground">Partner</dt><dd className="font-medium">{preview.partner.name} ({preview.partner.slug})</dd></div>
          <div><dt className="text-muted-foreground">Plan</dt><dd className="font-medium">{preview.partner.plan}</dd></div>
          <div><dt className="text-muted-foreground">Trust state</dt><dd className="font-medium">{preview.partner.trustState}</dd></div>
          <div><dt className="text-muted-foreground">Signup IP class</dt><dd className="font-medium">{card.signup.ipClass}</dd></div>
          <div><dt className="text-muted-foreground">Signup ASN</dt><dd className="font-medium">{displayValue(card.signup.asn)}</dd></div>
          <div><dt className="text-muted-foreground">Denials in last 24 h</dt><dd className="font-medium">{card.denials24h}</dd></div>
        </dl>
      </section>

      <section className="rounded-lg border bg-card p-6" aria-labelledby="identity-billing-heading">
        <h2 id="identity-billing-heading" className="text-lg font-semibold">Identity and billing</h2>
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
          <div><dt className="text-muted-foreground">User name</dt><dd className="font-medium">{displayValue(card.identity.userName)}</dd></div>
          <div><dt className="text-muted-foreground">Cardholder name</dt><dd className="font-medium">{displayValue(card.identity.cardholderName)}</dd></div>
          <div><dt className="text-muted-foreground">Names match</dt><dd className="font-medium">{displayBoolean(card.identity.namesMatch)}</dd></div>
          <div><dt className="text-muted-foreground">Payment methods</dt><dd className="font-medium">{card.billing.distinctPaymentMethods}</dd></div>
          <div><dt className="text-muted-foreground">Payment failures</dt><dd className="font-medium">{card.billing.failedAttempts}</dd></div>
          <div><dt className="text-muted-foreground">Matched suspended axes</dt><dd className="font-medium">{card.matchedSuspendedAxes.length ? card.matchedSuspendedAxes.map(displayAxis).join(', ') : 'None'}</dd></div>
        </dl>
      </section>

      <section className="overflow-hidden rounded-lg border bg-card" aria-labelledby="devices-heading">
        <h2 id="devices-heading" className="p-6 pb-3 text-lg font-semibold">Devices</h2>
        {card.devices.length === 0 ? (
          <p className="px-6 pb-6 text-sm text-muted-foreground">No enrolled devices</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                <tr><th className="px-6 py-3">Hostname</th><th className="px-6 py-3">Enrollment IP class</th><th className="px-6 py-3">Virtual</th></tr>
              </thead>
              <tbody className="divide-y">
                {card.devices.map((device, index) => (
                  <tr key={`${device.hostname}-${index}`}>
                    <td className="px-6 py-3 font-medium">{device.hostname}</td>
                    <td className="px-6 py-3">{device.enrollmentIpClass}</td>
                    <td className="px-6 py-3">{device.isVirtual ? 'Yes' : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <form onSubmit={submit} className="rounded-lg border bg-card p-6">
        <label htmlFor="trust-action-totp" className="block text-sm font-medium">Six-digit TOTP code</label>
        <input
          id="trust-action-totp"
          data-testid="trust-action-totp"
          type="text"
          inputMode="numeric"
          pattern="[0-9]{6}"
          autoComplete="one-time-code"
          autoFocus
          maxLength={6}
          value={totp}
          onChange={(event) => setTotp(event.target.value.replace(/\D/g, '').slice(0, 6))}
          className="mt-2 h-10 w-48 rounded-md border bg-background px-3 font-mono text-lg tracking-widest"
          required
        />
        <button
          type="submit"
          disabled={totp.length !== 6 || submitting}
          className="mt-4 block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? 'Confirming…' : actionLabel}
        </button>
      </form>
    </div>
  );
}
