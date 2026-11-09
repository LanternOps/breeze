import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { ActionError, runAction } from '@/lib/runAction';
import { showToast } from '../../shared/Toast';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import {
  isPortalEntraTenantView,
  type PortalEntraProofLink,
  type PortalEntraTenantView,
} from './types';

export interface EntraTenantPanelProps {
  orgId: string;
  /** After a proof or a removal: the policy view's `entraTenantProven` has changed. */
  onChanged?: () => void;
}

const ID = 'entra-tenant';
const tenantUrl = (orgId: string) => `/orgs/organizations/${orgId}/portal-entra-tenant`;
const toLogin = () => void navigateTo('/login', { replace: true });

/** The tenant routes' refusal codes (W04a `orgPortalEntraTenant.ts`, `portalEntraTenantProof.ts`). */
const ERROR_KEYS: Record<string, string> = {
  PORTAL_ENTRA_TENANT_PROVEN_ELSEWHERE: 'portalAccessPolicy.entraTenant.errors.provenElsewhere',
  PORTAL_ENTRA_ORG_HAS_OTHER_TENANT: 'portalAccessPolicy.entraTenant.errors.orgHasOtherTenant',
  PORTAL_ENTRA_NO_VERIFIED_CONNECTION: 'portalAccessPolicy.entraTenant.errors.noVerifiedConnection',
  PORTAL_ENTRA_TENANT_HINT_REQUIRED: 'portalAccessPolicy.entraTenant.errors.hintRequired',
  PORTAL_ENTRA_TENANT_HINT_INVALID: 'portalAccessPolicy.entraTenant.errors.hintInvalid',
  PORTAL_ENTRA_TENANT_HINT_LOOKUP_FAILED: 'portalAccessPolicy.entraTenant.errors.hintLookupFailed',
  PORTAL_ENTRA_PROTECTED_ORG: 'portalAccessPolicy.entraTenant.errors.protectedOrg',
  // The routes answer the shared PROTECTED_ORG_ERROR body, whose code is ORG_PROTECTED.
  ORG_PROTECTED: 'portalAccessPolicy.entraTenant.errors.protectedOrg',
};

function entraErrorMessage(code: string, t: TFunction): string | undefined {
  const key = ERROR_KEYS[code];
  return key ? t(/* i18n-dynamic */ key) : undefined;
}

const VIA_KEYS: Record<string, string> = {
  m365_connection: 'portalAccessPolicy.entraTenant.via.m365_connection',
  proof_run: 'portalAccessPolicy.entraTenant.via.proof_run',
};

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'not_configured' }
  | { status: 'ready'; tenant: PortalEntraTenantView };

function CopyField({ testId, label, value }: { testId: string; label: string; value: string }) {
  const { t } = useTranslation('settings');
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.warn('[EntraTenantPanel] copy failed', err);
      showToast({ type: 'error', message: t('portalAccessPolicy.entraTenant.toasts.copyFailed') });
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
          {copied ? t('portalAccessPolicy.entraTenant.copied') : t('portalAccessPolicy.entraTenant.copy')}
        </button>
      </div>
    </div>
  );
}

/**
 * The org's Microsoft tenant proof (portal registration W4 #11381, spec §5.4),
 * shown under the Microsoft row of the Sign-in & registration card. Proof is a
 * fact about the org, not a setting: it is never inherited. Renders nothing
 * while the deployment has no portal Entra app (the routes answer 404
 * `PORTAL_ENTRA_NOT_CONFIGURED`).
 */
export function EntraTenantPanel({ orgId, onChanged }: EntraTenantPanelProps) {
  const { t } = useTranslation('settings');
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [hint, setHint] = useState('');
  const [link, setLink] = useState<PortalEntraProofLink | null>(null);
  const [busy, setBusy] = useState<'prove' | 'link' | 'remove' | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = (seq.current += 1);
    setState({ status: 'loading' });
    try {
      const res = await fetchWithAuth(tenantUrl(orgId));
      if (mine !== seq.current) return;
      if (res.status === 401) { toLogin(); return; }
      if (res.status === 404) {
        const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
        if (mine !== seq.current) return;
        if (body?.code === 'PORTAL_ENTRA_NOT_CONFIGURED') { setState({ status: 'not_configured' }); return; }
      }
      if (!res.ok) throw new Error(`portal entra tenant load failed: ${res.status}`);
      const body = (await res.json()) as { data?: unknown };
      if (mine !== seq.current) return;
      if (!isPortalEntraTenantView(body.data)) throw new Error('portal entra tenant load returned an unexpected body');
      const tenant = body.data;
      setState({ status: 'ready', tenant });
      setHint(tenant.tenantId ?? tenant.connectionTenantId ?? '');
    } catch (err) {
      if (mine !== seq.current) return;
      console.warn('[EntraTenantPanel] load failed', err);
      setState({ status: 'error' });
    }
  }, [orgId]);

  useEffect(() => {
    void load();
    return () => { seq.current += 1; };
  }, [load]);

  const handleError = (err: unknown, fallback: string) => {
    if (err instanceof ActionError) return; // runAction toasted it (or redirected on 401)
    console.error('[EntraTenantPanel] action failed', err);
    showToast({ type: 'error', message: fallback });
  };

  const proveFromConnection = async () => {
    setBusy('prove');
    try {
      await runAction({
        request: () => fetchWithAuth(`${tenantUrl(orgId)}/prove-from-connection`, { method: 'POST' }),
        errorFallback: t('portalAccessPolicy.entraTenant.errors.prove'),
        successMessage: t('portalAccessPolicy.entraTenant.toasts.proven'),
        friendly: (code) => entraErrorMessage(code, t),
        onUnauthorized: toLogin,
      });
      setLink(null);
      onChanged?.();
      await load();
    } catch (err) {
      handleError(err, t('portalAccessPolicy.entraTenant.errors.prove'));
    } finally {
      setBusy(null);
    }
  };

  const createLink = async () => {
    const tenant = hint.trim();
    setBusy('link');
    try {
      const body = await runAction<{ data: PortalEntraProofLink }>({
        request: () => fetchWithAuth(`${tenantUrl(orgId)}/proof-links`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(tenant ? { tenant } : {}),
        }),
        errorFallback: t('portalAccessPolicy.entraTenant.errors.createLink'),
        successMessage: t('portalAccessPolicy.entraTenant.toasts.linkCreated'),
        parseSuccess: (data) => {
          const value = (data as { data?: Partial<PortalEntraProofLink> } | null)?.data;
          if (!value || typeof value.url !== 'string' || typeof value.expiresAt !== 'string' || typeof value.expectedTenantId !== 'string') {
            throw new Error('unexpected proof link body');
          }
          return { data: value as PortalEntraProofLink };
        },
        friendly: (code) => entraErrorMessage(code, t),
        onUnauthorized: toLogin,
      });
      setLink(body.data);
    } catch (err) {
      handleError(err, t('portalAccessPolicy.entraTenant.errors.createLink'));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy('remove');
    try {
      await runAction({
        request: () => fetchWithAuth(tenantUrl(orgId), { method: 'DELETE' }),
        errorFallback: t('portalAccessPolicy.entraTenant.errors.remove'),
        successMessage: t('portalAccessPolicy.entraTenant.toasts.removed'),
        friendly: (code) => entraErrorMessage(code, t),
        onUnauthorized: toLogin,
      });
      setConfirmRemove(false);
      setLink(null);
      onChanged?.();
      await load();
    } catch (err) {
      handleError(err, t('portalAccessPolicy.entraTenant.errors.remove'));
    } finally {
      setBusy(null);
    }
  };

  if (state.status === 'not_configured') return null;

  const shell = (children: ReactNode) => (
    <div data-testid={`${ID}-panel`} className="mt-2 space-y-3 rounded-md border bg-muted/20 p-3 text-sm">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('portalAccessPolicy.entraTenant.title')}</h4>
      {children}
    </div>
  );

  if (state.status === 'loading') {
    return shell(<p className="text-xs text-muted-foreground">{t('portalAccessPolicy.entraTenant.loading')}</p>);
  }
  if (state.status === 'error') {
    return shell(
      <p data-testid={`${ID}-load-error`} className="text-xs text-muted-foreground">
        {t('portalAccessPolicy.entraTenant.loadError')}{' '}
        <button type="button" data-testid={`${ID}-retry`} onClick={() => void load()} className="underline hover:text-foreground">
          {t('common:actions.retry')}
        </button>
      </p>,
    );
  }

  const { tenant } = state;
  const proven = tenant.state === 'proven';
  const statusText = proven
    ? t('portalAccessPolicy.entraTenant.status.proven', {
      tenantId: tenant.tenantId ?? '',
      date: tenant.provenAt ? new Date(tenant.provenAt).toLocaleDateString() : '',
      method: tenant.provenVia ? t(/* i18n-dynamic */ VIA_KEYS[tenant.provenVia] ?? VIA_KEYS.proof_run) : '',
    })
    : tenant.state === 'unproven'
      ? t('portalAccessPolicy.entraTenant.status.unproven', { tenantId: tenant.tenantId ?? '' })
      : t('portalAccessPolicy.entraTenant.status.none');

  return shell(
    <>
      <p data-testid={`${ID}-status`} data-state={tenant.state} className={proven ? 'text-foreground' : 'text-muted-foreground'}>
        {statusText}
      </p>

      {proven && (
        <>
          {tenant.consentUrl && (
            <div>
              <CopyField testId={`${ID}-consent-url`} label={t('portalAccessPolicy.entraTenant.consentLabel')} value={tenant.consentUrl} />
              <p className="mt-1 text-xs text-muted-foreground">{t('portalAccessPolicy.entraTenant.consentHelp')}</p>
            </div>
          )}
          <button
            type="button"
            data-testid={`${ID}-remove`}
            disabled={busy !== null}
            onClick={() => setConfirmRemove(true)}
            className="rounded-md border px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-500/10 disabled:opacity-50"
          >
            {t('portalAccessPolicy.entraTenant.remove')}
          </button>
        </>
      )}

      {!proven && (
        <>
          {tenant.connectionTenantId && (
            <button
              type="button"
              data-testid={`${ID}-prove-connection`}
              disabled={busy !== null}
              onClick={() => void proveFromConnection()}
              className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted/50 disabled:opacity-50"
            >
              {t('portalAccessPolicy.entraTenant.proveConnection', { tenantId: tenant.connectionTenantId })}
            </button>
          )}
          <div className="space-y-1">
            <label htmlFor={`${ID}-hint`} className="text-xs font-medium">{t('portalAccessPolicy.entraTenant.tenantLabel')}</label>
            <div className="flex gap-2">
              <input
                id={`${ID}-hint`}
                data-testid={`${ID}-hint`}
                value={hint}
                onChange={(e) => setHint(e.target.value)}
                maxLength={253}
                aria-describedby={`${ID}-hint-help`}
                className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs"
              />
              <button
                type="button"
                data-testid={`${ID}-create-link`}
                disabled={busy !== null || hint.trim() === ''}
                onClick={() => void createLink()}
                className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted/50 disabled:opacity-50"
              >
                {t('portalAccessPolicy.entraTenant.createLink')}
              </button>
            </div>
            <p id={`${ID}-hint-help`} className="text-xs text-muted-foreground">{t('portalAccessPolicy.entraTenant.tenantHelp')}</p>
          </div>
          {link && (
            <div className="space-y-1">
              <CopyField testId={`${ID}-link-url`} label={t('portalAccessPolicy.entraTenant.linkLabel')} value={link.url} />
              <p data-testid={`${ID}-link-expiry`} className="text-xs text-muted-foreground">
                {t('portalAccessPolicy.entraTenant.linkExpires', {
                  date: new Date(link.expiresAt).toLocaleString(),
                  tenantId: link.expectedTenantId,
                })}
              </p>
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmRemove}
        onClose={() => { if (busy !== 'remove') setConfirmRemove(false); }}
        onConfirm={() => void remove()}
        title={t('portalAccessPolicy.entraTenant.removeConfirm.title')}
        message={t('portalAccessPolicy.entraTenant.removeConfirm.message')}
        confirmLabel={t('portalAccessPolicy.entraTenant.remove')}
        variant="destructive"
        isLoading={busy === 'remove'}
        confirmTestId={`${ID}-remove-confirm`}
        dialogTestId={`${ID}-remove-dialog`}
      />
    </>,
  );
}
