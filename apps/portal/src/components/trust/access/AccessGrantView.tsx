// Landing page for the emailed "your documents" link: exchanges the fragment token for the grant once, then
// lists downloadable documents. The token stays in component state only.
import { useEffect, useState } from 'react';
import { downloadGrantDocument, fetchGrant, type AccessGrant } from '@/lib/trustAccessApi';
import { formatTrustDate, pickTrustCopy } from '../trustCopy';
import { accessCopy } from './accessCopy';
import { useFragmentToken } from './useFragmentToken';

type Load = { kind: 'loading' } | { kind: 'bad' } | { kind: 'retry' } | { kind: 'ok'; grant: AccessGrant };

function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking in the same tick can cancel the download in some browsers; give the save a moment to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function AccessGrantView() {
  const { ready, token, locale } = useFragmentToken();
  const t = pickTrustCopy(accessCopy, locale);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!ready) return;
    if (!token) { setLoad({ kind: 'bad' }); return; }
    let cancelled = false;
    setLoad({ kind: 'loading' });
    void fetchGrant(token).then((grant) => {
      if (cancelled) return;
      setLoad(grant === 'retry' ? { kind: 'retry' } : grant ? { kind: 'ok', grant } : { kind: 'bad' });
    });
    return () => { cancelled = true; };
  }, [ready, token, attempt]);

  async function download(id: string, title: string) {
    if (!token) return;
    setBusyId(id);
    setFailed(false);
    const res = await downloadGrantDocument(token, id);
    setBusyId(null);
    if (!res) { setFailed(true); return; }
    save(res.blob, res.filename ?? title);
  }

  if (!ready) return null;

  return (
    <section className="mx-auto max-w-xl rounded-lg border bg-card p-6 text-sm" data-testid="trust-access-grant">
      <h1 className="mb-3 text-lg font-semibold">{t.grantHeading}</h1>
      {load.kind === 'loading' && <p className="text-muted-foreground">{t.loading}</p>}
      {load.kind === 'bad' && <p data-testid="trust-access-invalid" role="alert">{t.invalid}</p>}
      {load.kind === 'retry' && (
        <div role="alert">
          <p className="mb-3 text-destructive" data-testid="trust-access-retry">{t.retry}</p>
          <button type="button" onClick={() => setAttempt((n) => n + 1)} className="rounded-md border px-3 py-2 font-medium doc-accent-text hover:underline" data-testid="trust-access-retry-button">
            {t.tryAgain}
          </button>
        </div>
      )}
      {load.kind === 'ok' && (
        <>
          <p className="mb-3 text-muted-foreground" data-testid="trust-access-expires">{t.expires(formatTrustDate(load.grant.expiresAt, locale))}</p>
          {load.grant.documents.length === 0 && <p>{t.grantEmpty}</p>}
          <ul className="divide-y rounded-lg border">
            {load.grant.documents.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-4 px-4 py-3" data-testid={`trust-access-doc-${d.id}`}>
                <div>
                  <span className="font-medium">{d.title}</span>
                  <p className="text-xs text-muted-foreground">{d.category} · {(d.byteSize / 1024).toFixed(0)} KB</p>
                </div>
                <button type="button" disabled={busyId === d.id} onClick={() => void download(d.id, d.title)} className="text-xs doc-accent-text hover:underline disabled:opacity-50" data-testid={`trust-access-download-${d.id}`}>
                  {busyId === d.id ? t.downloading : t.downloadDoc}
                </button>
              </li>
            ))}
          </ul>
          {failed && <p className="mt-3 text-destructive" role="alert" data-testid="trust-access-download-error">{t.downloadFailed}</p>}
        </>
      )}
    </section>
  );
}
