import { useEffect, useMemo, useState } from 'react';
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
  | { kind: 'expired' }
  | { kind: 'error'; message: string }
  | { kind: 'no-tenants' }
  | { kind: 'ready'; details: InteractionDetails }
  | { kind: 'submitting'; details: InteractionDetails };

const SCOPE_LABELS: Record<string, string> = {
  'mcp:read': 'Read your fleet data (devices, alerts, scripts, automations)',
  'mcp:write': 'Make non-destructive changes in your fleet (tags, alerts, configuration)',
  'mcp:execute': 'Run high-risk actions on devices (commands, scripts, remote operations)',
  openid: 'Confirm your identity',
  offline_access: 'Stay connected without re-signing in (refresh tokens)',
};

function describeScope(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope;
}

function isHighRiskScope(scope: string): boolean {
  return scope === 'mcp:execute';
}

function loginRedirectTarget(uid: string): string {
  const params = new URLSearchParams({ uid });
  const next = `/oauth/consent?${params.toString()}`;
  return `/login?next=${encodeURIComponent(next)}`;
}

export interface ConsentFormProps {
  uid: string;
}

export default function ConsentForm({ uid }: ConsentFormProps) {
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [partnerId, setPartnerId] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth(`/oauth/interaction/${encodeURIComponent(uid)}`);
        if (cancelled) return;
        if (res.status === 401) {
          // Auto-navigate to /login so the user lands directly in the sign-in
          // flow with `next` set to come back here. The unauthenticated state
          // remains as a fallback in case navigation is blocked (e.g. tests).
          window.location.href = loginRedirectTarget(uid);
          setState({ kind: 'unauthenticated' });
          return;
        }
        if (res.status === 404) {
          setState({ kind: 'expired' });
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          if (cancelled) return;
          setState({ kind: 'error', message: body?.message ?? `Request failed (${res.status})` });
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
        setState({ kind: 'error', message: err instanceof Error ? err.message : 'Network error' });
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
        setState({ kind: 'error', message: body?.message ?? `Submission failed (${res.status})` });
        return;
      }
      const { redirectTo } = (await res.json()) as { redirectTo: string };
      window.location.href = redirectTo;
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'Network error' });
    }
  };

  if (state.kind === 'loading') return <ConsentShell><p className="text-sm text-muted-foreground">Loading authorization request…</p></ConsentShell>;

  if (state.kind === 'unauthenticated') {
    return (
      <ConsentShell title="Sign in to continue">
        <p className="text-sm text-muted-foreground">
          You need to sign in to your Breeze account before authorizing this connection.
        </p>
        <a
          href={loginRedirectTarget(uid)}
          className="inline-flex h-10 items-center justify-center rounded-md bg-emerald-600 px-4 text-sm font-medium text-white transition hover:bg-emerald-700"
        >
          Sign in
        </a>
      </ConsentShell>
    );
  }

  if (state.kind === 'expired') {
    return (
      <ConsentShell title="Authorization request expired">
        <p className="text-sm text-muted-foreground">
          This authorization link is no longer valid. Return to your MCP client and start the connection again.
        </p>
      </ConsentShell>
    );
  }

  if (state.kind === 'no-tenants') {
    return (
      <ConsentShell title="No tenant available">
        <p className="text-sm text-muted-foreground">
          Your account isn't a member of any partner tenant, so it can't authorize an MCP connection.
          Ask an administrator to add you to a partner before continuing.
        </p>
      </ConsentShell>
    );
  }

  if (state.kind === 'error') {
    return (
      <ConsentShell title="Something went wrong">
        <p className="text-sm text-red-600">{state.message}</p>
      </ConsentShell>
    );
  }

  const details = state.details;
  const submitting = state.kind === 'submitting';

  return (
    <ConsentShell title={`${details.client.client_name} wants to access your Breeze tenant`}>
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
          {submitting ? 'Approving…' : 'Approve'}
        </button>
        <button
          type="button"
          onClick={() => submit(false)}
          disabled={submitting}
          className="inline-flex h-10 items-center justify-center rounded-md border border-input bg-transparent px-4 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          Deny
        </button>
      </div>

      <p className="pt-2 text-xs text-muted-foreground">
        You can revoke this access anytime from Settings → Connected apps.
      </p>
    </ConsentShell>
  );
}

function ConsentShell({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      {title && <h2 className="text-base font-semibold tracking-tight">{title}</h2>}
      <div className={`mt-4 space-y-4 ${title ? '' : 'mt-0'}`}>{children}</div>
    </div>
  );
}

function ScopeList({ scopes }: { scopes: string[] }) {
  const items = useMemo(() => (scopes.length ? scopes : ['mcp:read', 'mcp:write']), [scopes]);
  return (
    <div>
      <p className="text-sm font-medium">This will allow the app to:</p>
      <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
        {items.map((scope) => (
          <li key={scope} className="flex items-start gap-2">
            <span
              aria-hidden="true"
              className={`mt-1 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                isHighRiskScope(scope) ? 'bg-red-500' : 'bg-emerald-500'
              }`}
            />
            <span className={isHighRiskScope(scope) ? 'font-medium text-red-700' : undefined}>
              {describeScope(scope)}
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
  return (
    <div className="space-y-2">
      <label htmlFor="oauth-tenant" className="text-sm font-medium">
        Connect to which tenant?
      </label>
      <select
        id="oauth-tenant"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="block h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
      >
        {partners.map((p) => (
          <option key={p.partnerId} value={p.partnerId}>{p.partnerName}</option>
        ))}
      </select>
    </div>
  );
}
