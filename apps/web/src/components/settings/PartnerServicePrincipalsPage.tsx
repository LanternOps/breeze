import '@/lib/i18n';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { navigateTo } from '@/lib/navigation';
import { fetchWithAuth } from '../../stores/auth';
import { handleActionError, runAction } from '../../lib/runAction';

const AVAILABLE_SCOPES = [
  'organizations:read', 'sites:read', 'devices:read', 'inventory:read',
  'configuration:read', 'scripts:read', 'backup-configuration:read', 'custom-fields:read',
] as const;

type PrincipalKey = {
  id: string;
  name: string;
  keyPrefix: string;
  status: 'active' | 'revoked';
  expiresAt: string | null;
  rateLimit: number;
  lastUsedAt?: string | null;
};

type Principal = {
  id: string;
  name: string;
  description: string | null;
  status: 'active' | 'disabled';
  scopes: string[];
  expiresAt: string | null;
  sourceCidrs: string[];
  keys: PrincipalKey[];
};

type PrincipalDraft = {
  name: string;
  description: string;
  scopes: string[];
  expiresAt: string;
  sourceCidrs: string;
};

const EMPTY_DRAFT: PrincipalDraft = {
  name: '', description: '', scopes: [...AVAILABLE_SCOPES], expiresAt: '', sourceCidrs: '',
};

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

export default function PartnerServicePrincipalsPage() {
  const { t } = useTranslation('settings');
  const [principals, setPrincipals] = useState<Principal[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [editing, setEditing] = useState<Principal | 'new' | null>(null);
  const [draft, setDraft] = useState<PrincipalDraft>(EMPTY_DRAFT);
  const [issueTarget, setIssueTarget] = useState<Principal | null>(null);
  const [keyName, setKeyName] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const response = await fetchWithAuth('/partner-service-principals');
      if (response.status === 401) {
        UNAUTHORIZED();
        return;
      }
      if (!response.ok) throw new Error('load failed');
      const body = await response.json() as { data?: Principal[] };
      setPrincipals(body.data ?? []);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const closeReveal = () => setNewKey(null);
  const openCreate = () => { setEditing('new'); setDraft({ ...EMPTY_DRAFT, scopes: [...AVAILABLE_SCOPES] }); };
  const openEdit = (principal: Principal) => {
    setEditing(principal);
    setDraft({
      name: principal.name,
      description: principal.description ?? '',
      scopes: [...principal.scopes],
      expiresAt: principal.expiresAt ? principal.expiresAt.slice(0, 16) : '',
      sourceCidrs: principal.sourceCidrs.join('\n'),
    });
  };

  const savePrincipal = async () => {
    if (!editing || !draft.name.trim() || draft.scopes.length === 0) return;
    const creating = editing === 'new';
    const payload = {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      scopes: draft.scopes,
      expiresAt: draft.expiresAt ? new Date(draft.expiresAt).toISOString() : null,
      sourceCidrs: draft.sourceCidrs.split(/[\n,]/).map((value) => value.trim()).filter(Boolean),
    };
    try {
      await runAction({
        request: () => fetchWithAuth(
          creating ? '/partner-service-principals' : `/partner-service-principals/${editing.id}`,
          { method: creating ? 'POST' : 'PATCH', body: JSON.stringify(payload) },
        ),
        errorFallback: t('partnerServicePrincipals.saveFailed'),
        successMessage: creating ? t('partnerServicePrincipals.created') : t('partnerServicePrincipals.updated'),
        onUnauthorized: UNAUTHORIZED,
      });
      setEditing(null);
      await load();
    } catch (error) {
      handleActionError(error, t('partnerServicePrincipals.saveFailed'));
    }
  };

  const disablePrincipal = async (principal: Principal) => {
    try {
      await runAction({
        request: () => fetchWithAuth(`/partner-service-principals/${principal.id}`, {
          method: 'PATCH', body: JSON.stringify({ status: 'disabled' }),
        }),
        errorFallback: t('partnerServicePrincipals.disableFailed'),
        successMessage: t('partnerServicePrincipals.disabled'),
        onUnauthorized: UNAUTHORIZED,
      });
      await load();
    } catch (error) {
      handleActionError(error, t('partnerServicePrincipals.disableFailed'));
    }
  };

  const issueKey = async () => {
    if (!issueTarget || !keyName.trim()) return;
    try {
      const issued = await runAction<{ key: string }>({
        request: () => fetchWithAuth(`/partner-service-principals/${issueTarget.id}/keys`, {
          method: 'POST', body: JSON.stringify({ name: keyName.trim() }),
        }),
        errorFallback: t('partnerServicePrincipals.issueFailed'),
        successMessage: t('partnerServicePrincipals.issued'),
        onUnauthorized: UNAUTHORIZED,
      });
      setIssueTarget(null);
      setKeyName('');
      setNewKey(issued.key);
      await load();
    } catch (error) {
      handleActionError(error, t('partnerServicePrincipals.issueFailed'));
    }
  };

  const rotateKey = async (principal: Principal, key: PrincipalKey) => {
    try {
      const rotated = await runAction<{ key: string }>({
        request: () => fetchWithAuth(`/partner-service-principals/${principal.id}/keys/${key.id}/rotate`, { method: 'POST' }),
        errorFallback: t('partnerServicePrincipals.rotateFailed'),
        successMessage: t('partnerServicePrincipals.rotated'),
        onUnauthorized: UNAUTHORIZED,
      });
      setNewKey(rotated.key);
      await load();
    } catch (error) {
      handleActionError(error, t('partnerServicePrincipals.rotateFailed'));
    }
  };

  const revokeKey = async (principal: Principal, key: PrincipalKey) => {
    try {
      await runAction({
        request: () => fetchWithAuth(`/partner-service-principals/${principal.id}/keys/${key.id}`, { method: 'DELETE' }),
        errorFallback: t('partnerServicePrincipals.revokeFailed'),
        successMessage: t('partnerServicePrincipals.revoked'),
        onUnauthorized: UNAUTHORIZED,
      });
      await load();
    } catch (error) {
      handleActionError(error, t('partnerServicePrincipals.revokeFailed'));
    }
  };

  // Keep the one-time secret outside list-state branches. A slow or failed
  // refresh must never unmount the reveal before the user explicitly closes it.
  const keyReveal = newKey && <div className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4"><div className="w-full max-w-lg space-y-4 rounded-lg border bg-card p-6 shadow-lg"><h2 className="font-semibold">{t('partnerServicePrincipals.copyNow')}</h2><p className="text-sm text-muted-foreground">{t('partnerServicePrincipals.oneTimeWarning')}</p><pre className="overflow-x-auto rounded bg-muted p-3 text-sm">{newKey}</pre><div className="text-right"><button data-testid="close-key-reveal" className="rounded bg-primary px-3 py-2 text-primary-foreground" onClick={closeReveal}>{t('partnerServicePrincipals.done')}</button></div></div></div>;

  if (loading) return <><p className="py-10 text-center text-muted-foreground">{t('partnerServicePrincipals.loading')}</p>{keyReveal}</>;
  if (loadError) return <><div className="py-10 text-center"><p>{t('partnerServicePrincipals.loadFailed')}</p><button className="mt-3 rounded border px-3 py-2" onClick={() => void load()}>{t('partnerServicePrincipals.retry')}</button></div>{keyReveal}</>;

  return <><div className="space-y-6" data-testid="partner-service-principals-page">
    <div className="flex items-start justify-between gap-4">
      <div><h1 className="text-xl font-semibold">{t('partnerServicePrincipals.title')}</h1><p className="text-sm text-muted-foreground">{t('partnerServicePrincipals.description')}</p></div>
      <button className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground" onClick={openCreate}>{t('partnerServicePrincipals.create')}</button>
    </div>

    {principals.length === 0 && <p className="rounded border p-6 text-center text-muted-foreground">{t('partnerServicePrincipals.empty')}</p>}
    {principals.map((principal) => <section key={principal.id} className="rounded-lg border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="font-semibold">{principal.name}</h2><p className="text-sm text-muted-foreground">{principal.description}</p><span className="text-xs uppercase">{principal.status}</span></div>
        <div className="flex gap-2">
          <button className="rounded border px-3 py-1.5 text-sm" onClick={() => openEdit(principal)}>{t('partnerServicePrincipals.edit')}</button>
          {principal.status === 'active' && <button data-testid={`disable-principal-${principal.id}`} className="rounded border px-3 py-1.5 text-sm" onClick={() => void disablePrincipal(principal)}>{t('partnerServicePrincipals.disable')}</button>}
          <button data-testid={`issue-key-${principal.id}`} disabled={principal.status !== 'active'} className="rounded border px-3 py-1.5 text-sm" onClick={() => { setIssueTarget(principal); setKeyName(''); }}>{t('partnerServicePrincipals.issueKey')}</button>
        </div>
      </div>
      <div className="mt-4 overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left"><th className="py-2">{t('partnerServicePrincipals.keyName')}</th><th>{t('partnerServicePrincipals.prefix')}</th><th>{t('partnerServicePrincipals.status')}</th><th className="text-right">{t('partnerServicePrincipals.actions')}</th></tr></thead><tbody>
        {principal.keys.map((key) => <tr key={key.id} className="border-b last:border-0"><td className="py-2">{key.name}</td><td className="font-mono">{key.keyPrefix}…</td><td>{key.status}</td><td className="space-x-2 text-right">{key.status === 'active' && <><button data-testid={`rotate-key-${key.id}`} className="underline" onClick={() => void rotateKey(principal, key)}>{t('partnerServicePrincipals.rotate')}</button><button data-testid={`revoke-key-${key.id}`} className="underline" onClick={() => void revokeKey(principal, key)}>{t('partnerServicePrincipals.revoke')}</button></>}</td></tr>)}
      </tbody></table></div>
    </section>)}

    {editing && <div className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4"><div className="w-full max-w-lg space-y-4 rounded-lg border bg-card p-6 shadow-lg">
      <h2 className="font-semibold">{editing === 'new' ? t('partnerServicePrincipals.create') : t('partnerServicePrincipals.edit')}</h2>
      <label className="block text-sm">{t('partnerServicePrincipals.name')}<input className="mt-1 w-full rounded border bg-background p-2" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
      <label className="block text-sm">{t('partnerServicePrincipals.principalDescription')}<textarea className="mt-1 w-full rounded border bg-background p-2" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
      <fieldset><legend className="text-sm">{t('partnerServicePrincipals.scopes')}</legend><div className="mt-1 grid grid-cols-2 gap-1">{AVAILABLE_SCOPES.map((scope) => <label key={scope} className="text-xs"><input type="checkbox" checked={draft.scopes.includes(scope)} onChange={(event) => setDraft({ ...draft, scopes: event.target.checked ? [...draft.scopes, scope] : draft.scopes.filter((item) => item !== scope) })} /> {scope}</label>)}</div></fieldset>
      <label className="block text-sm">{t('partnerServicePrincipals.sourceCidrs')}<textarea className="mt-1 w-full rounded border bg-background p-2 font-mono" value={draft.sourceCidrs} onChange={(event) => setDraft({ ...draft, sourceCidrs: event.target.value })} /></label>
      <label className="block text-sm">{t('partnerServicePrincipals.expiresAt')}<input type="datetime-local" className="mt-1 w-full rounded border bg-background p-2" value={draft.expiresAt} onChange={(event) => setDraft({ ...draft, expiresAt: event.target.value })} /></label>
      <div className="flex justify-end gap-2"><button className="rounded border px-3 py-2" onClick={() => setEditing(null)}>{t('partnerServicePrincipals.cancel')}</button><button className="rounded bg-primary px-3 py-2 text-primary-foreground" onClick={() => void savePrincipal()}>{t('partnerServicePrincipals.save')}</button></div>
    </div></div>}

    {issueTarget && <div className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4"><div className="w-full max-w-md space-y-4 rounded-lg border bg-card p-6 shadow-lg"><h2 className="font-semibold">{t('partnerServicePrincipals.issueKey')}</h2><label className="block text-sm">{t('partnerServicePrincipals.keyName')}<input aria-label={t('partnerServicePrincipals.keyName')} className="mt-1 w-full rounded border bg-background p-2" value={keyName} onChange={(event) => setKeyName(event.target.value)} /></label><div className="flex justify-end gap-2"><button className="rounded border px-3 py-2" onClick={() => { setIssueTarget(null); setKeyName(''); }}>{t('partnerServicePrincipals.cancel')}</button><button data-testid="confirm-issue-key" className="rounded bg-primary px-3 py-2 text-primary-foreground" onClick={() => void issueKey()}>{t('partnerServicePrincipals.issue')}</button></div></div></div>}

  </div>{keyReveal}</>;
}
