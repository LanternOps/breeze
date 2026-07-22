import { useMemo, useState } from 'react';

const SIGNATURE_FONT = '"Snell Roundhand", "Brush Script MT", "Segoe Script", "Apple Chancery", cursive';

function today(): string {
  const d = new Date();
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

interface SignaturePanelProps {
  /** Called with the typed signer name once name + agreement are provided. */
  onAccept: (signerName: string) => void | Promise<void>;
  onDecline: () => void;
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
 */
export function SignaturePanel({ onAccept, onDecline, busy, testIdPrefix }: SignaturePanelProps) {
  const [name, setName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [touched, setTouched] = useState(false);
  const date = useMemo(() => today(), []);

  const trimmed = name.trim();
  const canSign = trimmed.length > 0 && agreed && !busy;

  const submit = () => {
    setTouched(true);
    if (!canSign) return;
    void onAccept(trimmed);
  };

  return (
    <div className="rounded-xl border bg-card p-5 shadow-xs sm:p-6" data-testid={`${testIdPrefix}-sign`}>
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
          className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-hidden transition focus:border-primary focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
        />
      </div>

      {/* Signature line — the typed name rendered as a signature, with the date. */}
      <div className="mt-4 rounded-lg border bg-muted/20 px-4 pb-3 pt-6">
        <div className="flex min-h-12 items-end border-b border-foreground/30 pb-1.5">
          <span
            data-testid={`${testIdPrefix}-signature-preview`}
            style={{ fontFamily: SIGNATURE_FONT }}
            className="text-3xl leading-none text-foreground"
          >
            {trimmed || ' '}
          </span>
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px] uppercase tracking-wide text-muted-foreground">
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

      {touched && !canSign && !busy && (
        <p className="mt-2 text-xs text-destructive" data-testid={`${testIdPrefix}-sign-hint`}>
          {trimmed.length === 0 ? 'Please type your full name to sign.' : 'Please confirm you agree to the terms.'}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          data-testid={`${testIdPrefix}-accept`}
          onClick={submit}
          disabled={!canSign}
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? 'Working…' : 'Accept & sign'}
        </button>
        <button
          type="button"
          data-testid={`${testIdPrefix}-decline`}
          onClick={() => onDecline()}
          disabled={busy}
          className="inline-flex items-center justify-center rounded-md border px-4 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-50"
        >
          Decline
        </button>
      </div>
    </div>
  );
}

export default SignaturePanel;
