import '@/lib/i18n';
import { useCallback, useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { navigateTo } from '@/lib/navigation';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { handleActionError, runAction } from '../../lib/runAction';

const READ_SCOPES = [
  'organizations:read', 'sites:read', 'devices:read', 'inventory:read',
  'configuration:read', 'scripts:read', 'backup-configuration:read', 'custom-fields:read',
] as const;
// Provisioning write scopes (#3243): opt-in per principal, NEVER part of the
// default selection — a default-scoped principal must stay read-only.
const WRITE_SCOPES = ['organizations:write', 'sites:write', 'enrollment-keys:write', 'contracts:write', 'tickets:write'] as const;
// Opt-in read scopes: offered, never pre-selected (alerts:read exposes alert
// titles/messages, tickets:read exposes ticket bodies/comments, across every
// org the principal reaches).
// device-status:read (#7577) exposes live online/last-seen/agent-version state
// and is not implied by devices:read.
const OPT_IN_READ_SCOPES = ['alerts:read', 'tickets:read', 'device-status:read'] as const;
// MCP scopes: opt-in, never pre-selected. They admit the principal's key to
// the MCP endpoint across every org of the partner; nothing on the Partner API.
const MCP_SCOPES = ['ai:read', 'ai:write', 'ai:execute', 'ai:execute_admin'] as const;
const AVAILABLE_SCOPES = [...READ_SCOPES, ...OPT_IN_READ_SCOPES, ...WRITE_SCOPES, ...MCP_SCOPES] as const;

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
  // The user who created the principal. Only they may issue or rotate its
  // keys or widen it (the API answers 403 SERVICE_PRINCIPAL_OWNER_REQUIRED to
  // anyone else); name is null when the owner's user row isn't visible.
  owner: { id: string; name: string | null };
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
  name: '', description: '', scopes: [...READ_SCOPES], expiresAt: '', sourceCidrs: '',
};

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

// <input type="datetime-local"> reads and writes wall-clock time in the
// browser's zone, so seed it with the local time of the stored instant.
function toDateTimeLocal(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function principalPayload(draft: PrincipalDraft) {
  return {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    scopes: draft.scopes,
    expiresAt: draft.expiresAt ? new Date(draft.expiresAt).toISOString() : null,
    sourceCidrs: draft.sourceCidrs.split(/[\n,]/).map((value) => value.trim()).filter(Boolean),
  };
}

// An edit sends only the fields the user changed. Re-sending an untouched
// expiry would truncate it to the minute, and the API treats any later expiry
// or other loosening as an owner-only change.
function changedFields(draft: PrincipalDraft, original: PrincipalDraft) {
  const next = principalPayload(draft);
  const before = principalPayload(original);
  const changed: Partial<ReturnType<typeof principalPayload>> = {};
  if (next.name !== before.name) changed.name = next.name;
  if (next.description !== before.description) changed.description = next.description;
  if ([...next.scopes].sort().join() !== [...before.scopes].sort().join()) changed.scopes = next.scopes;
  if (draft.expiresAt !== original.expiresAt) changed.expiresAt = next.expiresAt;
  if (next.sourceCidrs.join() !== before.sourceCidrs.join()) changed.sourceCidrs = next.sourceCidrs;
  return changed;
}

// Mirrors the expiry / source-CIDR half of the API's patchWidensPrincipal:
// pushing out or clearing an existing expiry, or clearing or adding to an
// existing CIDR list, is owner-only. (Scope additions are blocked at the
// checkbox; the page has no re-enable control.)
function editLoosensRestrictions(draft: PrincipalDraft, original: PrincipalDraft): boolean {
  if (original.expiresAt && draft.expiresAt !== original.expiresAt) {
    if (!draft.expiresAt || new Date(draft.expiresAt).getTime() > new Date(original.expiresAt).getTime()) return true;
  }
  const before = principalPayload(original).sourceCidrs;
  const next = principalPayload(draft).sourceCidrs;
  if (before.length > 0 && (next.length === 0 || next.some((cidr) => !before.includes(cidr)))) return true;
  return false;
}

export default function PartnerServicePrincipalsPage() {
  const { t } = useTranslation('settings');
  const currentUserId = useAuthStore((state) => state.user?.id);
  const [principals, setPrincipals] = useState<Principal[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [editing, setEditing] = useState<Principal | 'new' | null>(null);
  const [draft, setDraft] = useState<PrincipalDraft>(EMPTY_DRAFT);
  const [originalDraft, setOriginalDraft] = useState<PrincipalDraft>(EMPTY_DRAFT);
  const [issueTarget, setIssueTarget] = useState<Principal | null>(null);
  const [keyName, setKeyName] = useState('');
  const [issuing, setIssuing] = useState(false);
  const [rotatingKeyId, setRotatingKeyId] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyKey = async () => {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  // enrollment-keys:write mints device-join credentials, so the API returns 403
  // and a SQL CHECK rejects the row unless the principal carries both a future
  // expiry and a non-empty source-CIDR allowlist. Gate Save on the same pair so
  // the operator sees the requirement before the request fails.
  const writeScopeMissingRestrictions = draft.scopes.includes('enrollment-keys:write') && (
    !draft.expiresAt || !draft.sourceCidrs.split(/[\n,]/).some((value) => value.trim().length > 0)
  );

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

  // UX only: the API enforces ownership. These helpers just keep the page
  // from offering actions that can only come back 403.
  const isOwner = (principal: Principal) => Boolean(currentUserId) && principal.owner?.id === currentUserId;
  const ownerName = (principal: Principal) => principal.owner?.name ?? t('partnerServicePrincipals.unknownOwner');

  const closeReveal = () => setNewKey(null);
  const openCreate = () => { setEditing('new'); setDraft({ ...EMPTY_DRAFT, scopes: [...READ_SCOPES] }); };
  const openEdit = (principal: Principal) => {
    const seeded: PrincipalDraft = {
      name: principal.name,
      description: principal.description ?? '',
      scopes: [...principal.scopes],
      expiresAt: principal.expiresAt ? toDateTimeLocal(principal.expiresAt) : '',
      sourceCidrs: principal.sourceCidrs.join('\n'),
    };
    setEditing(principal);
    setDraft(seeded);
    setOriginalDraft(seeded);
  };

  const savePrincipal = async () => {
    if (!editing || !draft.name.trim() || draft.scopes.length === 0) return;
    const creating = editing === 'new';
    const payload = creating ? principalPayload(draft) : changedFields(draft, originalDraft);
    if (!creating && Object.keys(payload).length === 0) {
      setEditing(null);
      return;
    }
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
    // A refusal answers fast, so without the in-flight guard a double-click
    // sent two requests and toasted the same refusal twice (#8368).
    if (!issueTarget || !keyName.trim() || issuing) return;
    setIssuing(true);
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
    } finally {
      setIssuing(false);
    }
  };

  const rotateKey = async (principal: Principal, key: PrincipalKey) => {
    // A second rotate of the same key would hit an already-rotated key.
    if (rotatingKeyId) return;
    setRotatingKeyId(key.id);
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
    } finally {
      setRotatingKeyId(null);
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

  const editingNonOwner = editing && editing !== 'new' && !isOwner(editing) ? editing : null;
  const nonOwnerLoosens = editingNonOwner !== null && editLoosensRestrictions(draft, originalDraft);

  // Keep the one-time secret outside list-state branches. A slow or failed
  // refresh must never unmount the reveal before the user explicitly closes it.
  const keyReveal = newKey && <div className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4"><div className="w-full max-w-lg space-y-4 rounded-lg border bg-card p-6 shadow-lg"><h2 className="font-semibold">{t('partnerServicePrincipals.copyNow')}</h2><p className="text-sm text-muted-foreground">{t('partnerServicePrincipals.oneTimeWarning')}</p><pre className="overflow-x-auto rounded bg-muted p-3 text-sm">{newKey}</pre><div className="flex justify-end gap-2"><button data-testid="copy-key" className="inline-flex items-center gap-1.5 rounded border px-3 py-2" onClick={() => void copyKey()}>{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}{copied ? t('partnerServicePrincipals.copied') : t('partnerServicePrincipals.copy')}</button><button data-testid="close-key-reveal" className="rounded bg-primary px-3 py-2 text-primary-foreground" onClick={closeReveal}>{t('partnerServicePrincipals.done')}</button></div></div></div>;

  if (loading) return <><p className="py-10 text-center text-muted-foreground">{t('partnerServicePrincipals.loading')}</p>{keyReveal}</>;
  if (loadError) return <><div className="py-10 text-center"><p>{t('partnerServicePrincipals.loadFailed')}</p><button className="mt-3 rounded border px-3 py-2" onClick={() => void load()}>{t('partnerServicePrincipals.retry')}</button></div>{keyReveal}</>;

  return <><div className="space-y-6" data-testid="partner-service-principals-page">
    <div className="flex items-start justify-between gap-4">
      <div><h1 className="text-xl font-semibold">{t('partnerServicePrincipals.title')}</h1><p className="text-sm text-muted-foreground">{t('partnerServicePrincipals.description')}</p></div>
      <button data-testid="create-principal" className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground" onClick={openCreate}>{t('partnerServicePrincipals.create')}</button>
    </div>

    {principals.length === 0 && <p className="rounded border p-6 text-center text-muted-foreground">{t('partnerServicePrincipals.empty')}</p>}
    {principals.map((principal) => <section key={principal.id} className="rounded-lg border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="font-semibold">{principal.name}</h2><p className="text-sm text-muted-foreground">{principal.description}</p><span className="text-xs uppercase">{principal.status}</span>
          <p className="mt-1 text-xs text-muted-foreground" data-testid={`principal-owner-${principal.id}`}>{t('partnerServicePrincipals.owner')}: <span className="text-foreground">{ownerName(principal)}</span></p>
          <div className="mt-2 flex flex-wrap items-center gap-1" data-testid={`principal-scopes-${principal.id}`}>
            <span className="text-xs text-muted-foreground">{t('partnerServicePrincipals.scopes')}:</span>
            {principal.scopes.length === 0
              ? <span className="text-xs text-muted-foreground">{t('partnerServicePrincipals.noScopes')}</span>
              : principal.scopes.map((scope) => <span key={scope} className="rounded-full border bg-muted px-2 py-0.5 font-mono text-xs">{scope}</span>)}
          </div>
        </div>
        <div className="flex gap-2">
          <button className="rounded border px-3 py-1.5 text-sm" onClick={() => openEdit(principal)}>{t('partnerServicePrincipals.edit')}</button>
          {principal.status === 'active' && <button data-testid={`disable-principal-${principal.id}`} className="rounded border px-3 py-1.5 text-sm" onClick={() => void disablePrincipal(principal)}>{t('partnerServicePrincipals.disable')}</button>}
          <span title={isOwner(principal) ? undefined : t('partnerServicePrincipals.ownerOnlyTooltip', { owner: ownerName(principal) })}><button data-testid={`issue-key-${principal.id}`} disabled={principal.status !== 'active' || !isOwner(principal)} className="rounded border px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50" onClick={() => { setIssueTarget(principal); setKeyName(''); }}>{t('partnerServicePrincipals.issueKey')}</button></span>
        </div>
      </div>
      <div className="mt-4 overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left"><th className="py-2">{t('partnerServicePrincipals.keyName')}</th><th>{t('partnerServicePrincipals.prefix')}</th><th>{t('partnerServicePrincipals.status')}</th><th className="text-right">{t('partnerServicePrincipals.actions')}</th></tr></thead><tbody>
        {principal.keys.map((key) => <tr key={key.id} className="border-b last:border-0"><td className="py-2">{key.name}</td><td className="font-mono">{key.keyPrefix}…</td><td>{key.status}</td><td className="space-x-2 text-right">{key.status === 'active' && <><span title={isOwner(principal) ? undefined : t('partnerServicePrincipals.ownerOnlyTooltip', { owner: ownerName(principal) })}><button data-testid={`rotate-key-${key.id}`} disabled={!isOwner(principal) || rotatingKeyId === key.id} className="underline disabled:cursor-not-allowed disabled:no-underline disabled:opacity-50" onClick={() => void rotateKey(principal, key)}>{t('partnerServicePrincipals.rotate')}</button></span><button data-testid={`revoke-key-${key.id}`} className="underline" onClick={() => void revokeKey(principal, key)}>{t('partnerServicePrincipals.revoke')}</button></>}</td></tr>)}
      </tbody></table></div>
    </section>)}

    {editing && <div className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4"><div className="w-full max-w-lg space-y-4 rounded-lg border bg-card p-6 shadow-lg">
      <h2 className="font-semibold">{editing === 'new' ? t('partnerServicePrincipals.create') : t('partnerServicePrincipals.edit')}</h2>
      <label className="block text-sm">{t('partnerServicePrincipals.name')}<input className="mt-1 w-full rounded border bg-background p-2" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
      <label className="block text-sm">{t('partnerServicePrincipals.principalDescription')}<textarea className="mt-1 w-full rounded border bg-background p-2" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
      <fieldset><legend className="text-sm">{t('partnerServicePrincipals.scopes')}</legend>{editingNonOwner && <p data-testid="owner-only-edit-notice" className="mt-1 text-xs text-muted-foreground">{t('partnerServicePrincipals.ownerOnlyEditNotice', { owner: ownerName(editingNonOwner) })}</p>}<div className="mt-1 grid grid-cols-2 gap-1">{AVAILABLE_SCOPES.map((scope) => {
        // A non-owner may remove a scope the principal holds but not add one.
        const addBlocked = editingNonOwner !== null && !editingNonOwner.scopes.includes(scope);
        return <label key={scope} className={`text-xs${addBlocked ? ' cursor-not-allowed opacity-50' : ''}`} title={addBlocked && editingNonOwner ? t('partnerServicePrincipals.ownerOnlyScopeTooltip', { owner: ownerName(editingNonOwner) }) : undefined}><input type="checkbox" data-testid={`scope-checkbox-${scope}`} disabled={addBlocked} checked={draft.scopes.includes(scope)} onChange={(event) => setDraft({ ...draft, scopes: event.target.checked ? [...draft.scopes, scope] : draft.scopes.filter((item) => item !== scope) })} /> {scope}</label>;
      })}</div>{writeScopeMissingRestrictions && <p data-testid="write-scope-restrictions-required" className="mt-1 text-xs text-destructive">{t('partnerServicePrincipals.writeScopeRestrictionsRequired')}</p>}</fieldset>
      <label className="block text-sm">{t('partnerServicePrincipals.sourceCidrs')}<textarea className="mt-1 w-full rounded border bg-background p-2 font-mono" value={draft.sourceCidrs} onChange={(event) => setDraft({ ...draft, sourceCidrs: event.target.value })} /></label>
      <label className="block text-sm">{t('partnerServicePrincipals.expiresAt')}<input type="datetime-local" className="mt-1 w-full rounded border bg-background p-2" value={draft.expiresAt} onChange={(event) => setDraft({ ...draft, expiresAt: event.target.value })} /></label>
      {nonOwnerLoosens && editingNonOwner && <p data-testid="owner-only-widening" className="text-xs text-destructive">{t('partnerServicePrincipals.ownerOnlyWidening', { owner: ownerName(editingNonOwner) })}</p>}
      <div className="flex justify-end gap-2"><button className="rounded border px-3 py-2" onClick={() => setEditing(null)}>{t('partnerServicePrincipals.cancel')}</button><button data-testid="save-principal" disabled={writeScopeMissingRestrictions || nonOwnerLoosens} className="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" onClick={() => void savePrincipal()}>{t('partnerServicePrincipals.save')}</button></div>
    </div></div>}

    {issueTarget && <div className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4"><div className="w-full max-w-md space-y-4 rounded-lg border bg-card p-6 shadow-lg"><h2 className="font-semibold">{t('partnerServicePrincipals.issueKey')}</h2><label className="block text-sm">{t('partnerServicePrincipals.keyName')}<input aria-label={t('partnerServicePrincipals.keyName')} className="mt-1 w-full rounded border bg-background p-2" value={keyName} onChange={(event) => setKeyName(event.target.value)} /></label><div className="flex justify-end gap-2"><button className="rounded border px-3 py-2" onClick={() => { setIssueTarget(null); setKeyName(''); }}>{t('partnerServicePrincipals.cancel')}</button><button data-testid="confirm-issue-key" disabled={issuing} className="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" onClick={() => void issueKey()}>{t('partnerServicePrincipals.issue')}</button></div></div></div>}

  </div>{keyReveal}</>;
}
