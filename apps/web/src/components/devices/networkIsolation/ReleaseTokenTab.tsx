import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../../stores/auth';
import { formatDateTime } from '../../../lib/dateTimeFormat';
import { runAction, handleActionError } from '../../../lib/runAction';
import { isolationRefusalCopy } from './isolationEligibility';
import '../../../lib/i18n';

interface IssuedToken { token: string; expiresAt: string; qrCodeDataUrl: string }

const QR_PREFIX = 'data:image/png;base64,';

function parseIssued(data: unknown): IssuedToken {
  const body = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const { token, expiresAt, qrCodeDataUrl } = body;
  if (typeof token !== 'string' || token.length === 0) throw new Error('invalid_token');
  if (typeof expiresAt !== 'string' || !Number.isFinite(new Date(expiresAt).getTime())) throw new Error('invalid_token');
  if (typeof qrCodeDataUrl !== 'string' || !qrCodeDataUrl.startsWith(QR_PREFIX)) throw new Error('invalid_token');
  return { token, expiresAt, qrCodeDataUrl };
}

/** The token is held in component state only, fetched by an explicit audited click, never stored. */
export default function ReleaseTokenTab({ deviceId, isolationId, generation }: { deviceId: string; isolationId: string; generation?: number }) {
  const { t } = useTranslation('devices');
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const request = useRef(0);
  useEffect(() => {
    setIssued(null); setError(false); setBusy(false); setCopyState('idle');
    return () => { request.current += 1; };
  }, [deviceId, isolationId, generation]);
  useEffect(() => {
    if (!issued) return;
    const remaining = new Date(issued.expiresAt).getTime() - Date.now();
    const timer = setTimeout(() => setIssued(null), Math.max(0, Math.min(remaining, 2_147_483_647)));
    return () => clearTimeout(timer);
  }, [issued]);
  useEffect(() => {
    if (copyState !== 'copied') return;
    const timer = setTimeout(() => setCopyState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [copyState]);

  async function toggle() {
    if (busy) return;
    if (issued) { setIssued(null); setCopyState('idle'); return; }
    const currentRequest = ++request.current;
    setBusy(true); setError(false); setCopyState('idle');
    try {
      const result = await runAction<IssuedToken>({
        request: () => fetchWithAuth(`/devices/${deviceId}/network-isolation/${isolationId}/release-token`, { method: 'POST' }),
        errorFallback: t('networkIsolation.tokenError'),
        friendly: (code, _message, body) => code === 'release_token_unavailable'
          ? t('networkIsolation.tokenUnavailable')
          : isolationRefusalCopy(code, t, body),
        parseSuccess: parseIssued,
      });
      if (request.current === currentRequest) setIssued(result);
    } catch (err) {
      handleActionError(err, t('networkIsolation.tokenError'));
      if (request.current === currentRequest) setError(true);
    } finally {
      if (request.current === currentRequest) setBusy(false);
    }
  }

  async function copy() {
    if (!issued) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard_unavailable');
      await navigator.clipboard.writeText(issued.token);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  }

  return <div className="space-y-2 text-sm">
    <button type="button" data-testid="isolation-issue-token" disabled={busy} aria-expanded={Boolean(issued)} onClick={() => void toggle()} className="rounded-md border px-3 py-1.5 hover:bg-muted disabled:opacity-50">
      {busy ? t('common:states.loading') : t(/* i18n-dynamic */ issued ? 'networkIsolation.hideToken' : 'networkIsolation.issueToken')}
    </button>
    {error && <p role="alert" className="text-destructive">{t('networkIsolation.tokenError')}</p>}
    {issued && <div className="space-y-2 rounded-md border bg-background p-3" data-testid="isolation-token">
      <textarea readOnly rows={4} data-testid="isolation-release-token" aria-label={t('networkIsolation.tokenLabel')} value={issued.token} onFocus={(e) => e.currentTarget.select()} className="w-full resize-none rounded-md border bg-muted/30 p-2 font-mono text-xs break-all" />
      <div className="flex items-center gap-2">
        <button type="button" data-testid="isolation-copy-token" onClick={() => void copy()} className="rounded-md border px-3 py-1.5 hover:bg-muted">
          {copyState === 'copied' ? t('networkIsolation.tokenCopied') : t('networkIsolation.copyToken')}
        </button>
      </div>
      {copyState === 'error' && <p role="alert" className="text-destructive">{t('networkIsolation.tokenCopyError')}</p>}
      <img data-testid="isolation-token-qr" src={issued.qrCodeDataUrl} alt={t('networkIsolation.tokenQrAlt')} width={160} height={160} className="h-40 w-40 bg-white p-1" />
      <p className="text-xs text-muted-foreground">{t('networkIsolation.tokenValidUntil', { date: formatDateTime(issued.expiresAt) })}</p>
      <p className="text-xs text-muted-foreground">{t('networkIsolation.tokenCommandHint')} <code className="font-mono">breeze-agent containment release --token &lt;token&gt;</code></p>
    </div>}
  </div>;
}
