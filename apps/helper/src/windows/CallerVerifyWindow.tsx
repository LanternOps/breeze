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
}

export type Branding = { partnerName: string; logoUrl: string | null } | null;

export interface CallerVerifyWindowProps {
  req: CallerRequest;
  /** Fixed unix-ms deadline owned by the Rust side; never restarted on render. */
  deadlineMs: number;
  branding: Branding;
  locale: string;
  onDecision: (choice: string) => Promise<void>;
}

function isHttps(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

export function CallerVerifyWindow({ req, deadlineMs, branding, locale, onDecision }: CallerVerifyWindowProps) {
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
  const logo = isHttps(branding?.logoUrl) ? branding!.logoUrl : null;
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
