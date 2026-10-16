import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
// Initializes the shared i18next singleton. The public layout has no Sidebar
// (which is what pulls i18n in elsewhere), so without this every t() renders its raw key.
import '@/lib/i18n';
import { runAction } from '../../lib/runAction';
import ToastContainer from '../shared/Toast';

/**
 * Public, unauthenticated caller-verification card. The URL token is the only
 * credential: it is never written to browser storage, analytics or the console,
 * and every request omits credentials and the referrer.
 */
type Card = {
  status: 'pending';
  branding: { partnerName: string; logoUrl: string | null; accentColor: string | null; headline: string | null } | null;
  contactFirstName: string | null;
  technicianLabel: string;
  actionScope: 'reset_password' | 'disable_user' | 'any';
  targetLabel: string | null;
  reverseCode: string;
  choices: [string, string, string];
  expiresAt: string;
};

const API_BASE = (import.meta.env.PUBLIC_API_URL || '').trim();

export default function CallerVerifyCard({ token }: { token: string }) {
  const { t } = useTranslation('callerVerification');
  const [card, setCard] = useState<Card | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'expired' | 'disabled' | 'error'>('loading');
  const [received, setReceived] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [retry, setRetry] = useState(0);
  const inFlight = useRef(false);
  const url = `${API_BASE}/api/v1/verify/${encodeURIComponent(token)}`;

  useEffect(() => {
    const abort = new AbortController();
    setState('loading');
    void fetch(url, { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: abort.signal })
      .then(async (response) => {
        if (response.status === 404) { setState('disabled'); return; }
        if (!response.ok) throw new Error('load_failed');
        const data = await response.json();
        if (data.status !== 'pending') { setState('expired'); return; }
        setCard(data as Card);
        setState('ready');
      })
      .catch(() => { if (!abort.signal.aborted) setState('error'); });
    return () => abort.abort();
  }, [url, retry]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const seconds = card ? Math.max(0, Math.ceil((Date.parse(card.expiresAt) - now) / 1000)) : 0;
  const live = state === 'ready' && seconds > 0 && !received;

  async function choose(choice: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await runAction({
        request: () => fetch(url, {
          method: 'POST',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ choice }),
        }),
        treatUnauthorizedAsError: true,
        errorFallback: t('public.failed'),
        successMessage: t('public.received'),
        friendly: () => t('public.failed'),
      });
      setReceived(true);
      if (choice === 'not_me') setRejected(true);
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const partner = card?.branding?.partnerName ?? t('public.provider');
  const safeLogo = card?.branding?.logoUrl?.startsWith('https://') ? card.branding.logoUrl : undefined;

  return (
    <section className="space-y-5 rounded-xl border bg-card p-6" data-testid="caller-verify-card">
      <ToastContainer />
      <h2 className="text-xl font-semibold">{t('public.title')}</h2>
      {state === 'loading' && <p role="status">{t('public.loading')}</p>}
      {state === 'error' && (
        <>
          <p role="alert">{t('public.loadFailed')}</p>
          <button type="button" className="min-h-12 rounded-lg border px-4" onClick={() => setRetry((n) => n + 1)}>
            {t('public.retry')}
          </button>
        </>
      )}
      {card && (
        <>
          {safeLogo && <img src={safeLogo} alt={partner} referrerPolicy="no-referrer" className="max-h-12 max-w-full" />}
          {card.contactFirstName && <p>{t('public.hello', { name: card.contactFirstName })}</p>}
          <p>{t('public.request', { technician: card.technicianLabel, partner })}</p>
          <p className="break-words font-semibold">
            {t(/* i18n-dynamic */ `public.${card.actionScope}`, { target: card.targetLabel ?? t('public.target') })}
          </p>
          {live && (
            <>
              <p>{t('public.reverse')}</p>
              <p data-testid="caller-verify-reverse" className="text-center font-mono text-4xl tracking-widest">
                {card.reverseCode.split('').join(' ')}
              </p>
              <p>{t('public.choose')}</p>
              <div className="grid grid-cols-3 gap-3">
                {card.choices.map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    data-testid="caller-verify-choice"
                    disabled={busy}
                    onClick={() => void choose(choice)}
                    className="min-h-16 rounded-lg border text-2xl font-semibold focus-visible:outline focus-visible:outline-2 disabled:opacity-50"
                  >
                    {choice}
                  </button>
                ))}
              </div>
              <p>{t('public.expires', { seconds })}</p>
            </>
          )}
          <p>{t('public.caution', { technician: card.technicianLabel, partner })}</p>
        </>
      )}
      {(state === 'expired' || state === 'disabled' || (state === 'ready' && seconds === 0 && !received)) && (
        <p data-testid="caller-verify-expired">{t('public.expired')}</p>
      )}
      {received && <p role="status" data-testid="caller-verify-received">{t('public.received')}</p>}
      {failed && <p role="alert" data-testid="caller-verify-error">{t('public.failed')}</p>}
      {['ready', 'expired'].includes(state) && !rejected && (
        <button
          type="button"
          disabled={busy}
          data-testid="caller-verify-not-me"
          className="min-h-12 w-full rounded-lg border border-destructive px-4 text-destructive"
          onClick={() => void choose('not_me')}
        >
          {busy ? t('public.sending') : t('public.notMe')}
        </button>
      )}
    </section>
  );
}
