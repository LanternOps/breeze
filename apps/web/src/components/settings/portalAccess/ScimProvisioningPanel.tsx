import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { ActionError, runAction } from '@/lib/runAction';
import { showToast } from '../../shared/Toast';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { isPortalScimStatusView, type PortalScimStatusView, type PortalScimTokenView } from './types';

export interface ScimProvisioningPanelProps {
  orgId: string;
  canEdit: boolean;
}

const statusUrl = (orgId: string) => `/orgs/organizations/${orgId}/portal-scim`;
const toLogin = () => void navigateTo('/login', { replace: true });

/** The token routes' refusal codes (routes/orgPortalScim.ts). */
const ERROR_KEYS: Record<string, string> = {
  PORTAL_SCIM_TENANT_NOT_PROVEN: 'portalScim.errors.tenantNotProven',
  PORTAL_SCIM_TOKEN_LIMIT: 'portalScim.errors.limit',
  PORTAL_SCIM_TOKEN_NOT_FOUND: 'portalScim.errors.notFound',
};

function scimErrorMessage(code: string, t: TFunction): string | undefined {
  const key = ERROR_KEYS[code];
  return key ? t(/* i18n-dynamic */ key) : undefined;
}

type LoadState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; view: PortalScimStatusView };

function CopyField({ testId, label, value }: { testId: string; label: string; value: string }) {
  const { t } = useTranslation('settings');
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.warn('[ScimProvisioningPanel] copy failed', err);
      showToast({ type: 'error', message: t('portalScim.copyFailed') });
    }
  };
  return (
    <div className="space-y-1">
      <label htmlFor={`${testId}-input`} className="text-xs font-medium">{label}</label>
      <div className="flex gap-2">
        <input
          id={`${testId}-input`}
          data-testid={testId}
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded-md border bg-muted/30 px-2 py-1 font-mono text-xs"
        />
        <button
          type="button"
          data-testid={`${testId}-copy`}
          onClick={() => void copy()}
          className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted/50"
        >
          {copied ? t('portalScim.copied') : t('portalScim.copy')}
        </button>
      </div>
    </div>
  );
}

/**
 * Microsoft Entra provisioning (SCIM) for one org (portal registration W9
 * #11386, plan D11, D12): the Tenant URL, the org's provisioning tokens and
 * what SCIM has provisioned. A token is a per-org credential, not a policy
 * setting — it is never inherited. Creating one needs the org's Microsoft
 * tenant to be proven (the Microsoft panel above); its secret is shown exactly
 * once.
 */
export function ScimProvisioningPanel({ orgId, canEdit }: ScimProvisioningPanelProps) {
  const { t } = useTranslation('settings');
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<PortalScimTokenView | null>(null);
  const [busy, setBusy] = useState<'create' | 'revoke' | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = (seq.current += 1);
    try {
      const res = await fetchWithAuth(statusUrl(orgId));
      if (mine !== seq.current) return;
      if (res.status === 401) { toLogin(); return; }
      if (!res.ok) throw new Error(`portal scim load failed: ${res.status}`);
      const body = (await res.json()) as { data?: unknown };
      if (mine !== seq.current) return;
      if (!isPortalScimStatusView(body.data)) throw new Error('portal scim load returned an unexpected body');
      setState({ status: 'ready', view: body.data });
    } catch (err) {
      if (mine !== seq.current) return;
      console.warn('[ScimProvisioningPanel] load failed', err);
      setState({ status: 'error' });
    }
  }, [orgId]);

  useEffect(() => {
    void load();
    return () => { seq.current += 1; };
  }, [load]);

  const handleError = (err: unknown, fallback: string) => {
    if (err instanceof ActionError) return; // runAction toasted it (or redirected on 401)
    console.error('[ScimProvisioningPanel] action failed', err);
    showToast({ type: 'error', message: fallback });
  };

  const create = async () => {
    setBusy('create');
    try {
      const body = await runAction<{ data: { token: string } }>({
        request: () => fetchWithAuth(`${statusUrl(orgId)}/tokens`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: label.trim() }),
        }),
        errorFallback: t('portalScim.errors.create'),
        successMessage: t('portalScim.toasts.created'),
        parseSuccess: (data) => {
          const token = (data as { data?: { token?: unknown } } | null)?.data?.token;
          if (typeof token !== 'string') throw new Error('unexpected token body');
          return { data: { token } };
        },
        friendly: (code) => scimErrorMessage(code, t),
        onUnauthorized: toLogin,
      });
      setSecret(body.data.token);
      setCreating(false);
      setLabel('');
      await load();
    } catch (err) {
      handleError(err, t('portalScim.errors.create'));
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (tokenId: string) => {
    setBusy('revoke');
    try {
      await runAction({
        request: () => fetchWithAuth(`${statusUrl(orgId)}/tokens/${tokenId}`, { method: 'DELETE' }),
        errorFallback: t('portalScim.errors.revoke'),
        successMessage: t('portalScim.toasts.revoked'),
        friendly: (code) => scimErrorMessage(code, t),
        onUnauthorized: toLogin,
      });
      setRevoking(null);
      await load();
    } catch (err) {
      handleError(err, t('portalScim.errors.revoke'));
    } finally {
      setBusy(null);
    }
  };

  if (state.status === 'loading') {
    return <section data-testid="portal-scim" className="rounded-lg border p-4 text-sm text-muted-foreground">{t('portalScim.loading')}</section>;
  }
  if (state.status === 'error') {
    return (
      <section data-testid="portal-scim" className="rounded-lg border p-4 text-sm">
        <p data-testid="portal-scim-error" className="text-destructive">{t('portalScim.errors.load')}</p>
      </section>
    );
  }

  const { view } = state;
  const live = view.tokens.filter((tk) => !tk.revokedAt);

  return (
    <section data-testid="portal-scim" className="space-y-3 rounded-lg border p-4">
      <div>
        <h3 className="text-sm font-semibold">{t('portalScim.title')}</h3>
        <p className="text-xs text-muted-foreground">{t('portalScim.description')}</p>
      </div>

      {!view.tenant.proven ? (
        <p data-testid="portal-scim-needs-tenant" className="text-sm text-muted-foreground">{t('portalScim.needsTenant')}</p>
      ) : (
        <>
          {view.baseUrl
            ? <CopyField testId="portal-scim-base-url" label={t('portalScim.tenantUrl')} value={view.baseUrl} />
            : <p className="text-xs text-muted-foreground">{t('portalScim.noBaseUrl')}</p>}
          <p data-testid="portal-scim-counts" className="text-xs text-muted-foreground">
            {t('portalScim.counts', { provisioned: view.counts.provisioned, deactivated: view.counts.deactivated })}
          </p>
        </>
      )}

      {secret && (
        <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
          <p className="text-xs font-medium">{t('portalScim.secretOnce')}</p>
          <CopyField testId="portal-scim-secret" label={t('portalScim.secretToken')} value={secret} />
          <button
            type="button"
            data-testid="portal-scim-secret-done"
            onClick={() => setSecret(null)}
            className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted/50"
          >
            {t('portalScim.secretDone')}
          </button>
        </div>
      )}

      {live.length > 0 && (
        <ul className="divide-y rounded-md border text-sm">
          {live.map((tk) => (
            <li key={tk.id} data-testid="portal-scim-token-row" className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate font-medium">{tk.label} <span className="font-mono text-xs text-muted-foreground">…{tk.hint}</span></p>
                <p className="text-xs text-muted-foreground">
                  {tk.lastUsedAt
                    ? t('portalScim.lastUsed', { date: new Date(tk.lastUsedAt).toLocaleString() })
                    : t('portalScim.neverUsed')}
                  {!tk.usable && (
                    <span data-testid="portal-scim-token-unusable" className="ml-2 text-destructive">{t('portalScim.notWorking')}</span>
                  )}
                </p>
              </div>
              {canEdit && (
                <button
                  type="button"
                  data-testid="portal-scim-revoke"
                  onClick={() => setRevoking(tk)}
                  className="shrink-0 rounded-md border px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
                >
                  {t('portalScim.revoke')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && view.tenant.proven && (
        creating ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 space-y-1">
              <label htmlFor="portal-scim-label" className="text-xs font-medium">{t('portalScim.label')}</label>
              <input
                id="portal-scim-label"
                data-testid="portal-scim-label"
                value={label}
                maxLength={100}
                onChange={(e) => setLabel(e.target.value)}
                className="w-full rounded-md border px-2 py-1 text-sm"
              />
            </div>
            <button
              type="button"
              data-testid="portal-scim-create-submit"
              disabled={busy === 'create' || label.trim().length === 0}
              onClick={() => void create()}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {t('portalScim.createSubmit')}
            </button>
            <button
              type="button"
              onClick={() => { setCreating(false); setLabel(''); }}
              className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted/50"
            >
              {t('portalScim.cancel')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            data-testid="portal-scim-create"
            onClick={() => setCreating(true)}
            className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted/50"
          >
            {t('portalScim.create')}
          </button>
        )
      )}

      <ConfirmDialog
        open={revoking !== null}
        onClose={() => { if (busy !== 'revoke') setRevoking(null); }}
        onConfirm={() => { if (revoking) void revoke(revoking.id); }}
        title={t('portalScim.revokeConfirm.title')}
        message={t('portalScim.revokeConfirm.message', { label: revoking?.label ?? '' })}
        confirmLabel={t('portalScim.revoke')}
        variant="destructive"
        isLoading={busy === 'revoke'}
        confirmTestId="portal-scim-revoke-confirm"
        dialogTestId="portal-scim-revoke-dialog"
      />
    </section>
  );
}
