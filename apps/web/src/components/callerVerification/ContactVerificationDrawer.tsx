import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Drawer } from '@/components/shared/Drawer';
import { showToast } from '@/components/shared/Toast';
import { ActionError } from '@/lib/runAction';
import { useAuthStore } from '@/stores/auth';
import {
  attestDestination, bindContact, contactHistory, directoryUsers, fenceOverride, syncDirectory, unbindContact,
  type ContactHistory, type DirectorySearch, type DirectoryUser,
} from '@/lib/api/callerVerification';
import { VerifyCallerModal } from './VerifyCallerModal';

const REASON_MIN = 20;
const fmt = (iso: string) => new Date(iso).toLocaleString();

/** runAction already toasted ActionErrors (and 401 redirects); only the unexpected need one. */
function reportUnexpected(err: unknown, fallback: string) {
  if (!(err instanceof ActionError)) showToast({ type: 'error', message: fallback });
}

interface Props { orgId: string; contactId: string; contactName?: string | null; onClose: () => void }

/**
 * Per-contact verification management: history, fence override, directory
 * bindings, destination confirmation and directory sync. Mount only when the
 * runtime flag is on (the host checks `useCallerVerificationEnabled`).
 */
export function ContactVerificationDrawer({ orgId, contactId, contactName, onClose }: Props) {
  const { t } = useTranslation('callerVerificationTech');
  const userId = useAuthStore((s) => s.user?.id);
  const [data, setData] = useState<ContactHistory | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    contactHistory(orgId, contactId, controller.signal)
      .then((d) => { if (!controller.signal.aborted) setData(d); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [orgId, contactId, reload]);

  const refresh = useCallback(() => setReload((n) => n + 1), []);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); refresh(); return true; } catch (err) { reportUnexpected(err, t('errors.saveFailed')); return false; } finally { setBusy(false); }
  }, [refresh, t]);

  const activeEntra = data?.bindings.filter((b) => !b.revokedAt && b.entraOid) ?? [];
  return (
    <Drawer open onClose={onClose} title={contactName ? `${t('drawer.title')} · ${contactName}` : t('drawer.title')} width="max-w-lg"
      dataTestId="cv-drawer" closeDisabled={busy}>
      <div className="flex-1 space-y-6 overflow-y-auto px-5 py-4 text-sm">
        <div className="flex justify-end">
          <button type="button" data-testid="cv-drawer-verify" onClick={() => setVerifying(true)}
            className="h-9 rounded-md bg-primary px-3 text-primary-foreground">{t('open')}</button>
        </div>
        {failed && (
          <div role="alert" className="space-y-2 text-destructive">
            <p>{t('drawer.loadFailed')}</p>
            <button type="button" className="underline" onClick={refresh}>{t('retry')}</button>
          </div>
        )}
        {!failed && !data && <p className="text-muted-foreground">{t('loading')}</p>}
        {data && (
          <>
            {data.fencedUntil && <FenceBanner until={data.fencedUntil} busy={busy}
              onSubmit={(reason) => run(() => fenceOverride(orgId, contactId, reason))} />}

            <section className="space-y-2">
              <h3 className="font-semibold">{t('drawer.history')}</h3>
              {data.rows.length === 0
                ? <p className="text-muted-foreground">{t('drawer.noHistory')}</p>
                : (
                  <ul data-testid="cv-history" className="divide-y rounded-md border">
                    {data.rows.map((r) => (
                      <li key={r.id} className="flex items-start justify-between gap-3 px-3 py-2">
                        <span>
                          <span className="block font-medium">{t(/* i18n-dynamic */ `status.${r.status}`)}</span>
                          <span className="block text-xs text-muted-foreground">
                            {t(/* i18n-dynamic */ `methods.${r.method}`)} · {t(/* i18n-dynamic */ `actions.${r.actionScope}`)} ·{' '}
                            {r.initiatedByUserId === userId ? t('drawer.byYou') : t('drawer.byTechnician', { technician: r.technicianLabel })}
                          </span>
                        </span>
                        <span className="shrink-0 text-right text-xs text-muted-foreground">
                          <span className="block">{t('tier', { tier: r.tier })}</span>
                          <span className="block">{fmt(r.createdAt)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
            </section>

            <section className="space-y-2">
              <h3 className="font-semibold">{t('drawer.bindings')}</h3>
              {data.bindings.length === 0
                ? <p className="text-muted-foreground">{t('drawer.noBindings')}</p>
                : (
                  <ul className="divide-y rounded-md border">
                    {data.bindings.map((b) => (
                      <li key={b.id} className="flex items-center justify-between gap-3 px-3 py-2">
                        <span>
                          <span className="block font-medium">{b.upnSnapshot ?? b.osUsername ?? b.entraOid ?? '—'}</span>
                          <span className="block text-xs text-muted-foreground">
                            {t(/* i18n-dynamic */ `drawer.bindingSource.${b.source}`)}{b.revokedAt ? ` · ${t('drawer.revoked')}` : ''}
                          </span>
                        </span>
                        {!b.revokedAt && (
                          <button type="button" data-testid={`cv-unbind-${b.id}`} disabled={busy}
                            className="text-xs text-destructive underline disabled:opacity-50"
                            onClick={() => void run(() => unbindContact(orgId, contactId, b.id))}>{t('drawer.unbind')}</button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              <DirectoryLink orgId={orgId} busy={busy} onLink={(u) => run(() => bindContact(orgId, contactId, u))} />
              {activeEntra.length > 0 && (
                <div className="rounded-md border p-3">
                  <p className="font-medium">{t('drawer.syncTitle')}</p>
                  <p className="mb-2 text-xs text-muted-foreground">{t('drawer.syncHelp')}</p>
                  <button type="button" data-testid="cv-sync" disabled={busy} className="h-8 rounded-md border px-3 text-xs disabled:opacity-50"
                    onClick={() => void run(() => syncDirectory(orgId, activeEntra.map((b) => ({ contactId, entraOid: b.entraOid! }))))}>
                    {t('drawer.sync')}
                  </button>
                </div>
              )}
            </section>

            <section className="space-y-2">
              <h3 className="font-semibold">{t('drawer.destinations')}</h3>
              {data.destinations.length === 0
                ? <p className="text-muted-foreground">{t('drawer.noDestinations')}</p>
                : (
                  <ul className="divide-y rounded-md border">
                    {data.destinations.map((d) => (
                      <li key={d.id} className="flex items-center justify-between gap-3 px-3 py-2">
                        <span>
                          <span className="block text-xs text-muted-foreground">{t(/* i18n-dynamic */ `drawer.destinationKind.${d.kind}`)}</span>
                          <span className="block font-medium">{d.valueRedacted}</span>
                          <span className={`block text-xs ${d.established ? 'text-success' : 'text-warning'}`}>
                            {d.established ? t('drawer.established') : t('drawer.notEstablished')}
                            {d.attestedAt ? ` · ${t('drawer.attested', { time: fmt(d.attestedAt) })}` : ''}
                          </span>
                        </span>
                        {!d.attestedAt && (
                          <button type="button" data-testid={`cv-destination-attest-${d.id}`} disabled={busy} title={t('drawer.attestDestinationHelp')}
                            className="shrink-0 text-xs underline disabled:opacity-50"
                            onClick={() => void run(() => attestDestination(orgId, contactId, d.id))}>{t('drawer.attestDestination')}</button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              {data.destinations.some((d) => !d.attestedAt) && <p className="text-xs text-muted-foreground">{t('drawer.attestDestinationHelp')}</p>}
            </section>
          </>
        )}
      </div>
      {verifying && (
        <VerifyCallerModal orgId={orgId} initialContactId={contactId} lockContact
          onClose={() => { setVerifying(false); refresh(); }} />
      )}
    </Drawer>
  );
}

function FenceBanner({ until, busy, onSubmit }: { until: string; busy: boolean; onSubmit: (reason: string) => Promise<boolean> }) {
  const { t } = useTranslation('callerVerificationTech');
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  return (
    <div role="alert" className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-3">
      <p className="text-destructive">{t('drawer.fenced', { time: fmt(until) })}</p>
      {!open
        ? <button type="button" data-testid="cv-fence-open" className="text-xs underline" onClick={() => setOpen(true)}>{t('drawer.fenceOverride')}</button>
        : (
          <label className="block space-y-1">
            <span>{t('drawer.fenceReason')}</span>
            <textarea data-testid="cv-fence-reason" className="min-h-16 w-full rounded-md border bg-background p-2" maxLength={4000}
              value={reason} onChange={(e) => setReason(e.target.value)} />
            <span className="block text-xs text-muted-foreground">{t('drawer.fenceReasonHint')}</span>
            <button type="button" data-testid="cv-fence-submit" disabled={busy || reason.trim().length < REASON_MIN}
              className="h-8 rounded-md bg-destructive px-3 text-xs text-destructive-foreground disabled:opacity-50"
              onClick={() => void onSubmit(reason.trim()).then((ok) => { if (ok) { setOpen(false); setReason(''); } })}>
              {t('drawer.fenceSubmit')}
            </button>
          </label>
        )}
    </div>
  );
}

function DirectoryLink({ orgId, busy, onLink }: { orgId: string; busy: boolean; onLink: (u: DirectoryUser) => Promise<boolean> }) {
  const { t } = useTranslation('callerVerificationTech');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<DirectorySearch | null>(null);
  const [searching, setSearching] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    setSearching(true);
    setUnavailable(false);
    setResult(null);
    try {
      const r = await directoryUsers(orgId, q, c.signal);
      if (c.signal.aborted) return;
      if (!r.available) setUnavailable(true); else setResult(r);
    } catch {
      // 400/404 here means no usable directory for this session (unconfigured,
      // changed tenant, or a site-restricted technician) — never offer candidates.
      if (!c.signal.aborted) setUnavailable(true);
    } finally {
      if (!c.signal.aborted) setSearching(false);
    }
  };

  if (!open) {
    return <button type="button" data-testid="cv-link-open" className="text-xs underline" onClick={() => setOpen(true)}>{t('drawer.link')}</button>;
  }
  return (
    <div className="space-y-2 rounded-md border p-3">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <input data-testid="cv-directory-search" aria-label={t('drawer.searchDirectory')} placeholder={t('drawer.searchPlaceholder')}
          className="h-8 flex-1 rounded-md border bg-background px-2" maxLength={120} value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="submit" data-testid="cv-directory-submit" disabled={searching || !query.trim()}
          className="h-8 rounded-md border px-3 text-xs disabled:opacity-50">{t('drawer.search')}</button>
      </form>
      {unavailable && <p className="text-muted-foreground">{t('drawer.directoryUnavailable')}</p>}
      {result && result.users.length === 0 && <p className="text-muted-foreground">{t('drawer.noDirectoryResults')}</p>}
      {result?.truncated && <p className="text-xs text-muted-foreground">{t('drawer.directoryTruncated')}</p>}
      {result && result.users.length > 0 && (
        <ul className="divide-y rounded-md border">
          {result.users.map((u) => (
            <li key={u.entraOid} className="flex items-center justify-between gap-2 px-3 py-2">
              <span><span className="block font-medium">{u.displayName}</span><span className="block text-xs text-muted-foreground">{u.upn}</span></span>
              <button type="button" data-testid={`cv-directory-link-${u.entraOid}`} disabled={busy} className="text-xs underline disabled:opacity-50"
                onClick={() => void onLink(u).then((ok) => { if (ok) { setOpen(false); setResult(null); setQuery(''); } })}>
                {t('drawer.linkUser')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
