import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { ActionError, runAction } from '@/lib/runAction';
import { showToast } from '../../shared/Toast';
import { PortalAccessPolicyForm, visiblePolicyFields } from './PortalAccessPolicyForm';
import {
  PORTAL_ACCESS_POLICY_ERROR_CODES,
  PORTAL_ACCESS_POLICY_FIELDS,
  type PortalAccessPolicyField,
  type PortalAccessPolicyView,
} from '@breeze/shared';
import { isPortalAccessPolicyView, type PortalAccessPolicyDraft } from './types';

type Props = {
  orgId: string;
  onDirty: () => void;
  onSave: () => void;
};

const policyUrl = (orgId: string) => `/orgs/organizations/${orgId}/portal-access-policy`;
const pendingUrl = (orgId: string) => `/orgs/organizations/${orgId}/portal-access-requests?status=pending`;
const toLogin = () => void navigateTo('/login', { replace: true });

function policyErrorMessage(code: string, t: TFunction): string | undefined {
  if (code === PORTAL_ACCESS_POLICY_ERROR_CODES.SSO_ONLY_NEEDS_SSO) return t('portalAccessPolicy.errors.ssoOnlyNeedsSso');
  if (code === PORTAL_ACCESS_POLICY_ERROR_CODES.METHOD_UNAVAILABLE) return t('portalAccessPolicy.errors.methodUnavailable');
  return undefined;
}

function errorField(body: unknown): PortalAccessPolicyField | null {
  const field = body && typeof body === 'object' ? (body as { field?: unknown }).field : undefined;
  return typeof field === 'string' && (PORTAL_ACCESS_POLICY_FIELDS as readonly string[]).includes(field)
    ? (field as PortalAccessPolicyField)
    : null;
}

/**
 * Org settings › Portal › Sign-in & registration (portal registration W3):
 * the org override of the portal access policy. Blank fields inherit the
 * partner default. A form card with its own Save, like the portal settings
 * editor above it; it PATCHes only the changed fields.
 */
export default function OrgSignInRegistrationCard({ orgId, onDirty, onSave }: Props) {
  const { t } = useTranslation('settings');
  const [view, setView] = useState<PortalAccessPolicyView | null>(null);
  const [draft, setDraft] = useState<PortalAccessPolicyDraft>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<PortalAccessPolicyField, string>>>({});
  const [pendingCount, setPendingCount] = useState(0);
  const [pendingHasMore, setPendingHasMore] = useState(false);
  const seq = useRef(0);

  const loadPendingCount = useCallback(async (mine: number) => {
    try {
      const res = await fetchWithAuth(pendingUrl(orgId));
      if (!res.ok) throw new Error(`access requests load failed: ${res.status}`);
      const body = (await res.json()) as { data?: unknown[]; hasMore?: boolean };
      if (mine !== seq.current) return;
      setPendingCount(body.data?.length ?? 0);
      setPendingHasMore(body.hasMore === true);
    } catch (err) {
      // The count only drives the Requests shortcut; the card works without it.
      console.warn('[OrgSignInRegistrationCard] pending request count failed', err);
      if (mine === seq.current) {
        setPendingCount(0);
        setPendingHasMore(false);
      }
    }
  }, [orgId]);

  const load = useCallback(async () => {
    const mine = (seq.current += 1);
    setLoading(true);
    setLoadError(false);
    void loadPendingCount(mine);
    try {
      const res = await fetchWithAuth(policyUrl(orgId));
      if (mine !== seq.current) return;
      if (res.status === 401) { toLogin(); return; }
      if (!res.ok) throw new Error(`portal access policy load failed: ${res.status}`);
      const body = (await res.json()) as { data?: unknown };
      if (mine !== seq.current) return;
      if (!isPortalAccessPolicyView(body.data)) throw new Error('portal access policy load returned an unexpected body');
      setView(body.data);
      setDraft({});
      setFieldErrors({});
    } catch (err) {
      if (mine !== seq.current) return;
      console.warn('[OrgSignInRegistrationCard] load failed', err);
      setLoadError(true);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [orgId, loadPendingCount]);

  useEffect(() => {
    void load();
    return () => { seq.current += 1; };
  }, [load]);

  const change = (next: PortalAccessPolicyDraft) => {
    setDraft(next);
    setFieldErrors({});
    onDirty();
  };

  const showRequests = () => {
    // The `#portal` hash already selects this tab; scroll instead of re-hashing.
    document.getElementById('portal-access-requests')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const save = async () => {
    if (!view || saving || Object.keys(draft).length === 0) return;
    const visible = new Set(visiblePolicyFields(view.capabilities));
    setSaving(true);
    try {
      const body = await runAction<{ data: PortalAccessPolicyView }>({
        request: () => fetchWithAuth(policyUrl(orgId), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draft),
        }),
        errorFallback: t('portalAccessPolicy.errors.save'),
        successMessage: t('portalAccessPolicy.toasts.saved'),
        parseSuccess: (data) => {
          const saved = (data as { data?: unknown } | null)?.data;
          if (!isPortalAccessPolicyView(saved)) throw new Error('unexpected portal access policy body');
          return { data: saved };
        },
        friendly: (code) => policyErrorMessage(code, t),
        // A policy refusal on a row the form shows becomes that row's error instead of a toast.
        suppressErrorToast: (status, code, errBody) => {
          const field = errorField(errBody);
          return status === 400 && !!code && !!policyErrorMessage(code, t) && field !== null && visible.has(field);
        },
        onUnauthorized: toLogin,
      });
      setView(body.data);
      setDraft({});
      setFieldErrors({});
      onSave();
    } catch (err) {
      if (!(err instanceof ActionError)) {
        console.error('[OrgSignInRegistrationCard] save failed', err);
        showToast({ type: 'error', message: t('portalAccessPolicy.errors.save') });
        return;
      }
      if (err.status === 401) return; // the login redirect handles it
      const field = errorField(err.body);
      const message = err.code ? policyErrorMessage(err.code, t) : undefined;
      if (err.status === 400 && field && message && visible.has(field)) setFieldErrors({ [field]: message });
    } finally {
      setSaving(false);
    }
  };

  if (loading && !view) {
    return <p className="text-sm text-muted-foreground">{t('portalAccessPolicy.loading')}</p>;
  }

  if (loadError || !view) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground" data-testid="org-sign-in-card-load-error">
        {t('portalAccessPolicy.errors.load')}{' '}
        <button type="button" data-testid="org-sign-in-card-retry" onClick={() => void load()} className="underline hover:text-foreground">
          {t('common:actions.retry')}
        </button>
      </div>
    );
  }

  const dirty = Object.keys(draft).length > 0;

  return (
    <section className="rounded-lg border bg-card p-6 shadow-xs space-y-4" data-testid="org-sign-in-card">
      <div>
        <h2 className="text-lg font-semibold">{t('portalAccessPolicy.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('portalAccessPolicy.orgDescription')}</p>
      </div>
      <PortalAccessPolicyForm
        view={view}
        draft={draft}
        onChange={change}
        pendingRequestCount={pendingCount}
        pendingRequestsHasMore={pendingHasMore}
        onShowRequests={showRequests}
        fieldErrors={fieldErrors}
      />
      {view.canEdit && (
        <div className="flex justify-end">
          <button
            type="button"
            data-testid="org-sign-in-card-save"
            onClick={() => void save()}
            disabled={saving || !dirty}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {saving ? t('common:states.saving') : t('portalAccessPolicy.save')}
          </button>
        </div>
      )}
    </section>
  );
}
