import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';

interface PartnerOption {
  partnerId: string;
  partnerName: string;
}

interface InteractionDetails {
  uid: string;
  client: { client_id: string; client_name: string };
  scopes: string[];
  resource: string | null;
  partners: PartnerOption[];
}

type ViewState =
  | { kind: 'loading' }
  | { kind: 'unauthenticated' }
  | { kind: 'redirect-loop' }
  | { kind: 'expired' }
  | { kind: 'error'; message: string }
  | { kind: 'no-tenants' }
  | { kind: 'ready'; details: InteractionDetails }
  | { kind: 'submitting'; details: InteractionDetails };

function isHighRiskScope(scope: string): boolean {
  return scope === 'mcp:execute';
}

function loginRedirectTarget(uid: string): string {
  const params = new URLSearchParams({ uid });
  const next = `/oauth/consent?${params.toString()}`;
  return `/auth?next=${encodeURIComponent(next)}`;
}

// Per-uid so parallel OAuth flows in the same tab don't trip each other.
function redirectGuardKey(uid: string): string {
  return `oauth-consent-redirect-attempt:${uid}`;
}

// Detects an unauthenticated → /auth → unauthenticated bounce so we don't
// pinball forever when the auth cookie can't be set (3rd-party cookie
// blocking, CSP, sandboxed iframe). Returns true on the second hit and
// clears the marker so a manual retry can succeed.
function detectRedirectLoop(uid: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const key = redirectGuardKey(uid);
    const prior = window.sessionStorage.getItem(key);
    if (prior) {
      window.sessionStorage.removeItem(key);
      return true;
    }
    window.sessionStorage.setItem(key, String(Date.now()));
    return false;
  } catch (err) {
    // sessionStorage unavailable (cookies/storage blocked) — assume looping
    // since the surrounding bounce is most likely caused by the same block.
    console.warn('[consent] sessionStorage unavailable; treating as redirect loop', err);
    return true;
  }
}

function clearRedirectGuard(uid: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(redirectGuardKey(uid));
  } catch {
    // Same storage block as detectRedirectLoop — nothing to clear, nothing to do.
  }
}

export interface ConsentFormProps {
  uid: string;
}

export default function ConsentForm({ uid }: ConsentFormProps) {
  const { t } = useTranslation('common');
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [partnerId, setPartnerId] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth(`/oauth/interaction/${encodeURIComponent(uid)}`);
        if (cancelled) return;
        if (res.status === 401) {
          if (detectRedirectLoop(uid)) {
            setState({ kind: 'redirect-loop' });
            return;
          }
          // Fallback state for environments where navigation is blocked (tests).
          window.location.href = loginRedirectTarget(uid);
          setState({ kind: 'unauthenticated' });
          return;
        }
        // Any non-401 response means auth worked (or the link is dead) — clear
        // the bounce marker so the user's NEXT consent flow starts fresh.
        clearRedirectGuard(uid);
        if (res.status === 404) {
          setState({ kind: 'expired' });
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          if (cancelled) return;
          setState({
            kind: 'error',
            message: body?.message ?? t('longTail.oauth.ConsentForm.errors.requestFailed', { status: res.status }),
          });
          return;
        }
        const details = (await res.json()) as InteractionDetails;
        if (cancelled) return;
        if (details.partners.length === 0) {
          setState({ kind: 'no-tenants' });
          return;
        }
        setPartnerId(details.partners[0]!.partnerId);
        setState({ kind: 'ready', details });
      } catch (err) {
        if (cancelled) return;
        setState({ kind: 'error', message: err instanceof Error ? err.message : t('longTail.oauth.ConsentForm.errors.network') });
      }
    })();
    return () => { cancelled = true; };
  }, [uid]);

  const submit = async (approve: boolean) => {
    if (state.kind !== 'ready') return;
    setState({ kind: 'submitting', details: state.details });
    try {
      const res = await fetchWithAuth(`/oauth/interaction/${encodeURIComponent(uid)}/consent`, {
        method: 'POST',
        body: JSON.stringify({ partner_id: partnerId, approve }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setState({
          kind: 'error',
          message: body?.message ?? t('longTail.oauth.ConsentForm.errors.submissionFailed', { status: res.status }),
        });
        return;
      }
      const { redirectTo } = (await res.json()) as { redirectTo: string };
      window.location.href = redirectTo;
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : t('longTail.oauth.ConsentForm.errors.network') });
    }
  };

  if (state.kind === 'loading') return <ConsentShell><p className="text-sm text-muted-foreground">{t('longTail.oauth.ConsentForm.loading')}</p></ConsentShell>;

  if (state.kind === 'unauthenticated') {
    return (
      <ConsentShell title={t('longTail.oauth.ConsentForm.signInTitle')}>
        <p className="text-sm text-muted-foreground">
          {t('longTail.oauth.ConsentForm.signInDescription')}
        </p>
        <a
          href={loginRedirectTarget(uid)}
          className="inline-flex h-10 items-center justify-center rounded-md bg-emerald-600 px-4 text-sm font-medium text-white transition hover:bg-emerald-700"
        >
          {t('longTail.oauth.ConsentForm.signInAction')}
        </a>
      </ConsentShell>
    );
  }

  if (state.kind === 'redirect-loop') {
    // Reached after one bounce through /auth that came right back here as 401.
    // Almost always a cookie/storage block — surface a hard stop instead of
    // pinballing the user.
    return (
      <ConsentShell title={t('longTail.oauth.ConsentForm.redirectLoopTitle')}>
        <p className="text-sm text-muted-foreground">
          {t('longTail.oauth.ConsentForm.redirectLoopDescription')}
        </p>
        <a
          href={loginRedirectTarget(uid)}
          className="inline-flex h-10 items-center justify-center rounded-md border px-4 text-sm font-medium transition hover:bg-muted"
        >
          {t('common:actions.retry')}
        </a>
      </ConsentShell>
    );
  }

  if (state.kind === 'expired') {
    return (
      <ConsentShell title={t('longTail.oauth.ConsentForm.expiredTitle')}>
        <p className="text-sm text-muted-foreground">
          {t('longTail.oauth.ConsentForm.expiredDescription')}
        </p>
      </ConsentShell>
    );
  }

  if (state.kind === 'no-tenants') {
    return (
      <ConsentShell title={t('longTail.oauth.ConsentForm.noTenantsTitle')}>
        <p className="text-sm text-muted-foreground">
          {t('longTail.oauth.ConsentForm.noTenantsDescription')}
        </p>
      </ConsentShell>
    );
  }

  if (state.kind === 'error') {
    return (
      <ConsentShell title={t('common:states.error')}>
        <p className="text-sm text-red-600">{state.message}</p>
      </ConsentShell>
    );
  }

  const details = state.details;
  const submitting = state.kind === 'submitting';

  const displayName = details.client.client_name?.trim() || details.client.client_id;
  const showClientIdSubtitle = displayName !== details.client.client_id;

  return (
    <ConsentShell
      title={t('longTail.oauth.ConsentForm.consentTitle', { displayName })}
      subtitle={showClientIdSubtitle ? t('longTail.oauth.ConsentForm.clientId', { clientId: details.client.client_id }) : undefined}
    >
      <ScopeList scopes={details.scopes} />

      {details.partners.length > 1 && (
        <TenantPicker
          partners={details.partners}
          value={partnerId}
          onChange={setPartnerId}
          disabled={submitting}
        />
      )}

      <div className="flex gap-3 pt-2">
        <button
          type="button"
          onClick={() => submit(true)}
          disabled={submitting || !partnerId}
          className="inline-flex h-10 flex-1 items-center justify-center rounded-md bg-emerald-600 px-4 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? t('longTail.oauth.ConsentForm.approving') : t('longTail.oauth.ConsentForm.approve')}
        </button>
        <button
          type="button"
          onClick={() => submit(false)}
          disabled={submitting}
          className="inline-flex h-10 items-center justify-center rounded-md border border-input bg-transparent px-4 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          {t('longTail.oauth.ConsentForm.deny')}
        </button>
      </div>

      <p className="pt-2 text-xs text-muted-foreground">
        {t('longTail.oauth.ConsentForm.revokeHint')}
      </p>
    </ConsentShell>
  );
}

function ConsentShell({
  title,
  subtitle,
  children,
}: {
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      {title && <h2 className="text-base font-semibold tracking-tight">{title}</h2>}
      {subtitle && (
        <p className="mt-1 font-mono text-xs text-muted-foreground break-all">{subtitle}</p>
      )}
      <div className={`mt-4 space-y-4 ${title ? '' : 'mt-0'}`}>{children}</div>
    </div>
  );
}

function ScopeList({ scopes }: { scopes: string[] }) {
  const { t } = useTranslation('common');
  const items = useMemo(() => (scopes.length ? scopes : ['mcp:read', 'mcp:write']), [scopes]);
  const scopeLabels: Record<string, string> = {
    'mcp:read': t('longTail.oauth.ConsentForm.scopes.mcpRead'),
    'mcp:write': t('longTail.oauth.ConsentForm.scopes.mcpWrite'),
    'mcp:execute': t('longTail.oauth.ConsentForm.scopes.mcpExecute'),
    openid: t('longTail.oauth.ConsentForm.scopes.openid'),
    offline_access: t('longTail.oauth.ConsentForm.scopes.offlineAccess'),
  };
  return (
    <div>
      <p className="text-sm font-medium">{t('longTail.oauth.ConsentForm.scopeIntro')}</p>
      <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
        {items.map((scope) => (
          <li key={scope} className="flex items-start gap-2">
            <span
              aria-hidden="true"
              className={`mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                isHighRiskScope(scope) ? 'bg-red-500' : 'bg-emerald-500'
              }`}
            />
            <span className={isHighRiskScope(scope) ? 'font-medium text-red-700' : undefined}>
              {scopeLabels[scope] ?? scope}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TenantPicker({
  partners,
  value,
  onChange,
  disabled,
}: {
  partners: PartnerOption[];
  value: string;
  onChange: (id: string) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation('common');
  return (
    <div className="space-y-2">
      <label htmlFor="oauth-tenant" className="text-sm font-medium">
        {t('longTail.oauth.ConsentForm.tenantPickerLabel')}
      </label>
      <select
        id="oauth-tenant"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="block h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
      >
        {partners.map((p) => (
          <option key={p.partnerId} value={p.partnerId}>{p.partnerName}</option>
        ))}
      </select>
    </div>
  );
}
