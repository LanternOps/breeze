import { useEffect, useRef, useState } from 'react';
import { copyFor } from './callerVerifyMessages';

export interface CallerRequest {
  verificationId: string;
  username: string;
  technicianName: string;
  orgName: string;
  actionLabel: string;
  targetLabel: string;
  reverseCode: string;
  choices: string[];
  timeoutMs: number;
  /**
   * Optional absolute expiry (#8668). Informational here: the Rust side has
   * already clamped `deadlineMs` to it (or refused to open the window), so the
   * countdown below never derives from `timeoutMs` or this field.
   */
  deadlineAt?: string;
}

/**
 * Partner branding from `/api/v1/helper/config`. `logoSha256` (W04) is
 * `branding.logo.sha256`: the logo the agent also syncs to Assist as bytes.
 * Absent on an older API.
 */
export type Branding = { partnerName: string; logoUrl: string | null; logoSha256?: string | null } | null;

/** The logo to draw, as resolved by `resolveCallerLogo` (callerVerifyLogo.ts). */
export type CallerLogo = { src: string; kind: 'blob' | 'https' } | null;

export interface CallerVerifyWindowProps {
  req: CallerRequest;
  /** Fixed unix-ms deadline owned by the Rust side; never restarted on render. */
  deadlineMs: number;
  branding: Branding;
  /**
   * The resolved logo (W04): the synced bytes as a `blob:` URL, or the https
   * `logoUrl`, or null for none. Omitted: today's rule (https `logoUrl` only).
   */
  logo?: CallerLogo;
  locale: string;
  onDecision: (choice: string) => Promise<void>;
}

function hasProtocol(url: string | null | undefined, protocol: 'https:' | 'blob:'): url is string {
  if (!url) return false;
  try {
    return new URL(url).protocol === protocol;
  } catch {
    return false;
  }
}

/** Only a local `blob:` URL or an `https:` URL is ever drawn. */
function logoSrc(branding: Branding, logo: CallerLogo | undefined): string | null {
  if (logo === undefined) return hasProtocol(branding?.logoUrl, 'https:') ? branding!.logoUrl : null;
  if (!logo) return null;
  return hasProtocol(logo.src, logo.kind === 'blob' ? 'blob:' : 'https:') ? logo.src : null;
}

export function CallerVerifyWindow({ req, deadlineMs, branding, logo: resolved, locale, onDecision }: CallerVerifyWindowProps) {
  const copy = copyFor(locale);
  const sent = useRef(false);
  const timeoutTried = useRef(false);
  const [remaining, setRemaining] = useState(() => Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const submit = async (choice: string) => {
    if (sent.current) return;
    sent.current = true;
    setBusy(true);
    setError(false);
    try {
      await onDecision(choice);
    } catch {
      sent.current = false;
      setBusy(false);
      setError(true);
    }
  };
  const submitRef = useRef(submit);
  submitRef.current = submit;

  useEffect(() => {
    const tick = () => {
      const n = Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000));
      setRemaining(n);
      if (n === 0 && !timeoutTried.current) {
        timeoutTried.current = true;
        void submitRef.current('timeout');
      }
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [deadlineMs]);

  const partner = branding?.partnerName || 'Breeze';
  const logo = logoSrc(branding, resolved);
  const expired = remaining === 0;

  return (
    <main
      role="alertdialog"
      aria-labelledby="caller-title"
      data-testid="caller-verify"
      style={{ padding: 28, maxWidth: 500, margin: 'auto', fontFamily: 'Inter Variable, Inter, sans-serif' }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {logo && <img src={logo} alt="" referrerPolicy="no-referrer" style={{ maxWidth: 180, maxHeight: 56 }} />}
        <strong>{partner}</strong>
      </header>
      <h1 id="caller-title">{copy.title}</h1>
      <p>{copy.request(req.technicianName, req.orgName, req.actionLabel, req.targetLabel)}</p>
      <p style={{ fontSize: 48, fontWeight: 800, letterSpacing: 12, textAlign: 'center' }}>{req.reverseCode}</p>
      <div style={{ display: 'flex', gap: 16, justifyContent: 'center' }}>
        {req.choices.map((choice) => (
          <button
            key={choice}
            type="button"
            disabled={busy || expired}
            onClick={() => void submit(choice)}
            style={{ fontSize: 32, minWidth: 92, minHeight: 64 }}
          >
            {choice}
          </button>
        ))}
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => void submit('not_me')}
        style={{ marginTop: 24, minHeight: 44, width: '100%' }}
      >
        {copy.notMe}
      </button>
      <p aria-live="off">
        {remaining} {copy.remaining}
      </p>
      <p>{copy.safety(req.technicianName, partner)}</p>
      {error && <p role="alert">{copy.failed}</p>}
    </main>
  );
}
