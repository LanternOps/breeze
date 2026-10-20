// Landing page for the emailed "confirm your request" link. Mail scanners prefetch links, so nothing is
// POSTed on load: the requester must click Confirm.
import { useState } from 'react';
import { verifyAccess } from '@/lib/trustAccessApi';
import { pickTrustCopy } from '../trustCopy';
import { accessCopy } from './accessCopy';
import { useFragmentToken } from './useFragmentToken';

type Phase = { kind: 'idle' } | { kind: 'busy' } | { kind: 'ok'; orgName: string } | { kind: 'bad' } | { kind: 'retry' };

export default function AccessVerifyView() {
  const { ready, token, locale } = useFragmentToken();
  const t = pickTrustCopy(accessCopy, locale);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  if (!ready) return null;

  async function confirm() {
    if (!token) return;
    setPhase({ kind: 'busy' });
    const res = await verifyAccess(token);
    // A transient failure keeps the Confirm button: the token was not consumed, and the fragment is gone, so
    // this page is the only place the requester can try again without reopening the email.
    setPhase(res === 'retry' ? { kind: 'retry' } : res ? { kind: 'ok', orgName: res.orgName } : { kind: 'bad' });
  }

  return (
    <section className="mx-auto max-w-xl rounded-lg border bg-card p-6 text-sm" data-testid="trust-access-verify">
      <h1 className="mb-3 text-lg font-semibold">{t.verifyHeading}</h1>
      {(!token || phase.kind === 'bad') && <p data-testid="trust-access-invalid" role="alert">{t.invalid}</p>}
      {phase.kind === 'ok' && <p data-testid="trust-access-verified" role="status">{t.verified(phase.orgName)}</p>}
      {phase.kind === 'retry' && <p className="mb-3 text-destructive" data-testid="trust-access-retry" role="alert">{t.retry}</p>}
      {token && (phase.kind === 'idle' || phase.kind === 'busy' || phase.kind === 'retry') && (
        <button type="button" disabled={phase.kind === 'busy'} onClick={confirm} className="rounded-md border px-3 py-2 font-medium doc-accent-text hover:underline disabled:opacity-50" data-testid="trust-access-confirm">
          {phase.kind === 'busy' ? t.verifyConfirming : t.verifyConfirm}
        </button>
      )}
    </section>
  );
}
