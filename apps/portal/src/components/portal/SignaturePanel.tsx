import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT } from './ui';


function today(): string {
  const d = new Date();
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

interface SignaturePanelProps {
  /** Called with the typed signer name once name + agreement are provided. */
  onAccept: (signerName: string) => void | Promise<void>;
  /** Called ONLY after the customer confirms the inline decline block. */
  onDecline: (reason?: string) => void | Promise<void>;
  busy: boolean;
  /** Prefixes the data-testids so existing public/authed selectors keep working. */
  testIdPrefix: string;
}

/**
 * "Sign here" panel for accepting a proposal. The signer types their full legal
 * name, sees it rendered as a signature on a dated signature line, and must tick
 * the agreement box — typing the name is the electronic signature. The captured
 * name flows to the accept endpoint (name + IP + timestamp are recorded server
 * side in quote_acceptances). Shared by the public link and the authed portal so
 * both sign identically.
 *
 * Declining is a second, confirmed step. It used to fire straight from the
 * Decline button via window.prompt(), which returns null on Cancel/Escape — so
 * backing out of the prompt still declined the proposal irreversibly. The
 * confirm block below is the only path to onDecline().
 */
export function SignaturePanel({ onAccept, onDecline, busy, testIdPrefix }: SignaturePanelProps) {
  const [name, setName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [touched, setTouched] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  // The signature date is the signer's local day, which the server can't know:
  // SSR rendered it in the container's zone and the browser re-rendered it in
  // the customer's, tripping a hydration mismatch across midnight. Render it
  // only once mounted so server and first client paint agree (empty), then
  // fill in the local date.
  const [date, setDate] = useState('');
  useEffect(() => setDate(today()), []);

  const trimmed = name.trim();
  const canSign = trimmed.length > 0 && agreed && !busy;
  const hintId = `${testIdPrefix}-sign-hint`;
  const showHint = touched && !canSign && !busy;

  const submit = () => {
    setTouched(true);
    if (!canSign) return;
    void onAccept(trimmed);
  };

  const confirmDecline = () => {
    if (busy) return;
    const reason = declineReason.trim();
    onDecline(reason.length > 0 ? reason : undefined);
  };

  return (
    <div className="rounded-xl border bg-card p-5 sm:p-6" data-testid={`${testIdPrefix}-sign`}>
      <h3 className="text-sm font-semibold text-foreground">Accept &amp; sign</h3>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Type your full legal name to sign and accept this proposal.
      </p>

      <div className="mt-4 space-y-1.5">
        <label htmlFor={`${testIdPrefix}-signer`} className="text-xs font-medium text-foreground">Full name</label>
        <input
          id={`${testIdPrefix}-signer`}
          data-testid={`${testIdPrefix}-signer`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setTouched(true)}
          disabled={busy}
          autoComplete="name"
          placeholder="Your full name"
          className={cn(INPUT, "mt-0")}
        />
      </div>

      {/* Signature line — the typed name rendered as a signature, with the date. */}
      <div className="mt-4 rounded-lg border bg-muted/20 px-4 pb-3 pt-6">
        <div className="flex min-h-12 items-end border-b border-foreground/30 pb-1.5">
          <span
            data-testid={`${testIdPrefix}-signature-preview`}
            /* .signature-preview carries the cursive stack (a class, not an
               inline fontFamily — see lib/docAccent.ts). */
            className="signature-preview text-3xl leading-none text-foreground"
          >
            {trimmed || ' '}
          </span>
        </div>
        <div className="mt-2 flex items-center justify-between text-xs uppercase tracking-wide text-muted-foreground">
          <span>Signature</span>
          <span>{date}</span>
        </div>
      </div>

      <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-sm">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          disabled={busy}
          data-testid={`${testIdPrefix}-agree`}
          // border-input (== --border, a near-white slate) rendered the box as a
          // barely-visible outline on the white card — customers couldn't see the
          // agreement checkbox. Use a contrasty, theme-aware border instead.
          className="mt-0.5 h-4 w-4 shrink-0 rounded border border-muted-foreground/50 text-primary focus:ring-primary/40"
        />
        <span className="leading-relaxed text-muted-foreground">
          I have reviewed this proposal and agree to its terms. Typing my name above is my electronic signature.
        </span>
      </label>

      {showHint && (
        <p
          id={hintId}
          role="alert"
          className="mt-2 text-xs font-medium text-destructive-on-tint"
          data-testid={`${testIdPrefix}-sign-hint`}
        >
          {trimmed.length === 0 ? 'Please type your full name to sign.' : 'Please confirm you agree to the terms.'}
        </p>
      )}

      {declining ? (
        <div
          className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 p-4"
          data-testid={`${testIdPrefix}-decline-panel`}
        >
          <h4 className="text-sm font-semibold text-destructive-on-tint">Decline this proposal?</h4>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            This tells the sender you are not going ahead. You cannot accept the proposal afterwards.
          </p>

          <div className="mt-3 space-y-1.5">
            <label htmlFor={`${testIdPrefix}-decline-reason`} className="text-xs font-medium text-foreground">
              Let them know why (optional)
            </label>
            <textarea
              id={`${testIdPrefix}-decline-reason`}
              data-testid={`${testIdPrefix}-decline-reason`}
              value={declineReason}
              onChange={(e) => setDeclineReason(e.target.value)}
              disabled={busy}
              rows={3}
              maxLength={2000}
              className={cn(INPUT, "mt-0")}
            />
          </div>

          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              data-testid={`${testIdPrefix}-decline-confirm`}
              onClick={confirmDecline}
              disabled={busy}
              className={cn(BTN_PRIMARY, "bg-destructive text-destructive-foreground hover:bg-destructive/90")}
            >
              {busy ? 'Declining' : 'Yes, decline'}
            </button>
            <button
              type="button"
              data-testid={`${testIdPrefix}-decline-cancel`}
              onClick={() => setDeclining(false)}
              disabled={busy}
              // Focus lands on the safe option, so Enter/Space on arrival backs
              // out rather than declining.
              autoFocus
              className={BTN_SECONDARY}
            >
              Keep reviewing
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            data-testid={`${testIdPrefix}-accept`}
            onClick={submit}
            // Deliberately NOT `disabled={!canSign}`: a disabled button takes no
            // focus and no click, so submit()'s setTouched(true) could never run
            // from here and the hint above only ever appeared via the name
            // field's onBlur. A keyboard user tabbed past Accept to Decline
            // without ever learning what was missing. Stay reachable, refuse in
            // submit(), and point at the hint.
            aria-disabled={!canSign}
            aria-describedby={showHint ? hintId : undefined}
            disabled={busy}
            className={cn(BTN_PRIMARY, !canSign && 'opacity-50')}
          >
            {busy ? 'Signing' : 'Accept & sign'}
          </button>
          <button
            type="button"
            data-testid={`${testIdPrefix}-decline`}
            onClick={() => setDeclining(true)}
            disabled={busy}
            className={BTN_SECONDARY}
          >
            Decline
          </button>
        </div>
      )}
    </div>
  );
}

export default SignaturePanel;
