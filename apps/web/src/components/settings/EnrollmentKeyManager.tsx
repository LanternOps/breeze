import { useState, useEffect, useCallback } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore, type Site } from '../../stores/orgStore';
import { fallbackInstallerFilename, filenameFromContentDisposition } from '@/lib/downloadFilename';
import { extractApiError } from '@/lib/apiError';
import { navigateTo } from '@/lib/navigation';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { showToast } from '../shared/Toast';
import { runAction, ActionError } from '../../lib/runAction';
import { Trans, useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { formatDate } from '@/lib/dateTimeFormat';
import { PRODUCT_DEFAULT_ENROLLMENT_DEVICE_COUNT } from '@breeze/shared';

interface EnrollmentKey {
  id: string;
  orgId: string;
  siteId: string | null;
  name: string;
  key?: string | null;
  shortCode?: string | null;
  usageCount: number;
  maxUsage: number | null;
  expiresAt: string | null;
  createdBy: string | null;
  createdAt: string;
  /**
   * Device slots across the installers minted from this key, summed over its
   * bootstrap tokens (#2992).
   *
   * A SEPARATE counter from usageCount/maxUsage, not a replacement: the modern
   * installer downloads mint no child enrollment key, so the device count the
   * operator chose lands here and nowhere else. Both get rendered; see the
   * usage cell below.
   *
   * null in TWO cases, and the API decides both — do not try to re-derive
   * either here:
   *   1. the key never produced an installer;
   *   2. every installer token under the key is one-per-DOWNLOAD rather than
   *      one-per-device (the public /s/:code and download-handle flows mint one
   *      per click), so summing them would render a denominator that grows on
   *      every click and never reaches the key's real budget.
   *
   * Case 2 is decided PER TOKEN, on `installer_bootstrap_tokens.usage_kind`
   * (#3034) — NOT by whether the key carries a `shortCode`. A shortCode does not
   * imply either answer: an operator can build a real multi-device installer
   * FROM a short-link child row (that key reports a genuine capacity), and
   * /s/:code mints a download key with no shortCode at all (that key's tokens
   * are pure click counts). Branching on `key.shortCode` here would reintroduce
   * exactly the bug #3034 fixed. See `fetchInstallerTokenUsage` in
   * routes/enrollmentKeys.ts.
   *
   * `liveConsumed` / `liveMax` (#3039) are the same sums over UNEXPIRED tokens
   * only. They drive two things below: the capacity line marks dead slots
   * instead of rendering an expired installer as "0 / 7" free capacity, and
   * `getKeyStatus` derives the row's effective status from token liveness once
   * the parent key itself is dead (the Add-Device parent is a 60-minute
   * container; its installer can live a year). Optional so a response predating
   * the field degrades to the old all-live rendering.
   */
  installerTokens?: {
    consumed: number;
    max: number;
    liveConsumed?: number;
    liveMax?: number;
  } | null;
}

interface CreateFormValues {
  orgId: string;
  siteId?: string;
  name: string;
  maxUsage?: number;
  expiresAt?: string;
}

type ModalMode = 'closed' | 'create' | 'delete';

export default function EnrollmentKeyManager() {
  const { t } = useTranslation('settings');
  const { currentOrgId, organizations } = useOrgStore();
  const [keys, setKeys] = useState<EnrollmentKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedKey, setSelectedKey] = useState<EnrollmentKey | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [rotateTarget, setRotateTarget] = useState<EnrollmentKey | null>(null);
  const [downloadDropdownId, setDownloadDropdownId] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [hideExpired, setHideExpired] = useState(false);
  const [purgeConfirmOpen, setPurgeConfirmOpen] = useState(false);

  // Create form state
  const [formName, setFormName] = useState('');
  const [formMaxUsage, setFormMaxUsage] = useState('');
  const [formExpiresAt, setFormExpiresAt] = useState('');
  // Enrollment keys are unusable for `breeze-agent enroll` without a siteId
  // (the API rejects enrollment with "Enrollment key must be associated with
  // a site"), so the create form requires picking one. Org selection drives
  // the site list: a partner admin managing multiple orgs gets an explicit
  // Organization dropdown; everyone else (org-scoped token, or a partner with
  // exactly one org) is defaulted straight to the active org.
  const [formOrgId, setFormOrgId] = useState('');
  const [formSiteId, setFormSiteId] = useState('');
  const [formSites, setFormSites] = useState<Site[]>([]);
  const [sitesLoading, setSitesLoading] = useState(false);
  // Track a failed site load so the form can offer a retry instead of showing
  // the "this org has no sites" empty state — a 500 must not read as an
  // unconfigured org. The nonce lets the retry button re-run the load effect.
  const [sitesError, setSitesError] = useState(false);
  const [sitesReloadNonce, setSitesReloadNonce] = useState(0);

  const fetchKeys = useCallback(async (page = 1) => {
    try {
      setLoading(true);
      setError(undefined);
      const params = new URLSearchParams({ page: String(page) });
      if (hideExpired) params.set('expired', 'false');
      const response = await fetchWithAuth(`/enrollment-keys?${params.toString()}`);
      if (!response.ok) {
        if (response.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        throw new Error(t('enrollmentKeys.fetchFailed'));
      }
      const data = await response.json();
      setKeys(data.data ?? []);
      const total = data.pagination?.total ?? 0;
      const limit = data.pagination?.limit ?? 50;
      setTotalPages(Math.max(1, Math.ceil(total / limit)));
      setCurrentPage(data.pagination?.page ?? page);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('enrollmentKeys.genericError'));
    } finally {
      setLoading(false);
    }
  }, [hideExpired, t]);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  useEffect(() => {
    if (!downloadDropdownId) return;
    const handler = () => setDownloadDropdownId(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [downloadDropdownId]);

  // Load the site list for the create form's selected org.
  useEffect(() => {
    if (modalMode !== 'create' || !formOrgId) {
      setFormSites([]);
      return;
    }
    // Clear the previously-selected org's sites immediately so the
    // default-site effect falls back to '' until the correct list loads. Without
    // this, switching the Org dropdown leaves the old org's sites in place and a
    // stale siteId could be defaulted (and submitted) for the newly-picked org.
    let cancelled = false;
    setFormSites([]);
    setSitesError(false);
    setSitesLoading(true);
    fetchWithAuth(`/orgs/sites?organizationId=${formOrgId}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((data) => {
        if (cancelled) return;
        const list: Site[] = Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.sites)
            ? data.sites
            : [];
        setFormSites(list);
      })
      .catch(() => {
        if (!cancelled) {
          setFormSites([]);
          setSitesError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setSitesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [modalMode, formOrgId, sitesReloadNonce]);

  // Default the site selection once the list loads: first available site.
  useEffect(() => {
    if (modalMode !== 'create') return;
    if (formSiteId && formSites.some((s) => s.id === formSiteId)) return;
    setFormSiteId(formSites[0]?.id ?? '');
  }, [modalMode, formSites, formSiteId]);

  const handleCopyKey = async (key: string, id: string) => {
    try {
      await navigator.clipboard.writeText(key);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // Fallback for older browsers
    }
  };

  const handleOpenCreate = () => {
    setFormName('');
    setFormMaxUsage('');
    setFormExpiresAt('');
    setFormOrgId(currentOrgId ?? organizations[0]?.id ?? '');
    setFormSiteId('');
    setModalMode('create');
  };

  const handleOpenDelete = (key: EnrollmentKey) => {
    setSelectedKey(key);
    setModalMode('delete');
  };

  const handleCloseModal = () => {
    setModalMode('closed');
    setSelectedKey(null);
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formSiteId) return;
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = { name: formName, siteId: formSiteId };

      // Prefer the org chosen in the form (defaults to the org switcher's
      // active org; only differs when a partner admin picked another org
      // from the form's own Organization selector).
      if (formOrgId) {
        body.orgId = formOrgId;
      } else if (currentOrgId) {
        body.orgId = currentOrgId;
      } else if (keys.length > 0) {
        body.orgId = keys[0].orgId;
      }

      // A blank field must NOT fall through to the API's own `?? 1` default:
      // that default exists for the Add Device installer flow, where max_usage
      // on the parent key is deliberately left at 1 (the device budget lives on
      // the installer's bootstrap token instead — see AddDeviceModal's
      // handleDownload comment, #2992). This standalone Create Key form has no
      // such bootstrap token, so an unset field here IS the enrollment budget,
      // and the "Unlimited"-styled placeholder must resolve to the product
      // default device count (#4126), not a single-use key.
      body.maxUsage = formMaxUsage
        ? parseInt(formMaxUsage, 10)
        : PRODUCT_DEFAULT_ENROLLMENT_DEVICE_COUNT;
      if (formExpiresAt) {
        body.expiresAt = new Date(formExpiresAt).toISOString();
      }

      const response = await fetchWithAuth('/enrollment-keys', {
        method: 'POST',
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(extractApiError(data, t('enrollmentKeys.createFailed')));
      }

      const created = await response.json().catch(() => ({} as Record<string, unknown>));
      if (typeof created.key === 'string' && created.key.length > 0) {
        setNewlyCreatedKey(created.key);
      }

      await fetchKeys(currentPage);
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('enrollmentKeys.genericError'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!selectedKey) return;
    setSubmitting(true);
    try {
      const response = await fetchWithAuth(`/enrollment-keys/${selectedKey.id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error(t('enrollmentKeys.deleteFailed'));
      }

      const deletedName = selectedKey.name;
      await fetchKeys(currentPage);
      handleCloseModal();
      showToast({ message: t('enrollmentKeys.deleted', { name: deletedName }), type: 'success' });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('enrollmentKeys.genericError'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRotateKey = (key: EnrollmentKey) => {
    setRotateTarget(key);
  };

  const handleConfirmRotate = async () => {
    if (!rotateTarget) return;

    setRotateTarget(null);
    setSubmitting(true);
    try {
      const response = await fetchWithAuth(`/enrollment-keys/${rotateTarget.id}/rotate`, {
        method: 'POST',
        body: JSON.stringify({})
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(extractApiError(data, t('enrollmentKeys.rotateFailed')));
      }

      const rotated = await response.json().catch(() => ({} as Record<string, unknown>));
      if (typeof rotated.key === 'string' && rotated.key.length > 0) {
        setNewlyCreatedKey(rotated.key);
      }
      await fetchKeys(currentPage);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('enrollmentKeys.genericError'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmPurgeExpired = async () => {
    setPurgeConfirmOpen(false);
    setSubmitting(true);
    try {
      await runAction<{ success: boolean; deletedCount: number }>({
        request: () =>
          fetchWithAuth('/enrollment-keys/purge-expired', {
            method: 'POST',
            body: JSON.stringify({})
          }),
        errorFallback: t('enrollmentKeys.purgeFailed'),
        successMessage: (data) => t('enrollmentKeys.purged', { count: data.deletedCount }),
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      await fetchKeys(1);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({
          type: 'error',
          message: err instanceof Error ? err.message : t('enrollmentKeys.purgeFailed')
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleDownloadInstaller = async (keyId: string, platform: 'windows' | 'macos') => {
    if (downloading) return;
    setDownloading(true);
    try {
      const response = await fetchWithAuth(`/enrollment-keys/${keyId}/installer/${platform}`);

      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: t('enrollmentKeys.downloadFailed') }));
        setError(body.error || t('enrollmentKeys.downloadFailedStatus', { status: response.status }));
        return;
      }

      const blob = await response.blob();
      const filename =
        filenameFromContentDisposition(response.headers.get('Content-Disposition'))
        ?? fallbackInstallerFilename(platform);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('enrollmentKeys.unknownError');
      setError(t('enrollmentKeys.installerFailed', { message }));
    } finally {
      setDownloading(false);
    }
  };

  const isExpired = (key: EnrollmentKey) =>
    key.expiresAt && new Date(key.expiresAt) < new Date();

  const isExhausted = (key: EnrollmentKey) =>
    key.maxUsage !== null && key.usageCount >= key.maxUsage;

  /**
   * Normalized liveness cut of a key's installer capacity, or null when the
   * key has no installer figure at all. Falls back to treating every token as
   * live when the API predates the live* fields, which reproduces the old
   * behavior exactly.
   */
  const installerLiveness = (key: EnrollmentKey) => {
    const tokens = key.installerTokens;
    if (!tokens || tokens.max <= 0) return null;
    return {
      ...tokens,
      liveConsumed: tokens.liveConsumed ?? tokens.consumed,
      liveMax: tokens.liveMax ?? tokens.max,
    };
  };

  const STATUS_STYLES = {
    expired: { key: 'expired', active: false, className: 'bg-red-500/10 text-red-400 border-red-500/30' },
    exhausted: { key: 'exhausted', active: false, className: 'bg-amber-500/10 text-amber-400 border-amber-500/30' },
    active: { key: 'active', active: true, className: 'bg-green-500/10 text-green-400 border-green-500/30' },
  } as const;

  /**
   * Whether the parent key ITSELF is still a redeemable credential (CLI
   * enroll, and the gate the authenticated installer-download routes apply —
   * they 410 on an expired key). Deliberately separate from the row's
   * effective status below: the Download button must follow THIS, not the
   * token-derived badge, or an expired parent with a live installer would
   * offer a download that can only 410.
   */
  const isParentActive = (key: EnrollmentKey) => !isExpired(key) && !isExhausted(key);

  /**
   * Effective row status (#3039). The parent key's own expiry wins while the
   * parent is alive, but once it is dead a key that minted installers is
   * judged by its tokens — the things that actually enroll. Without this an
   * Add-Device row flips to "Expired" 60 minutes in while its installer keeps
   * enrolling devices for months (and vice versa: a dead installer under a
   * live-looking row).
   */
  const getKeyStatus = (key: EnrollmentKey) => {
    if (isParentActive(key)) return STATUS_STYLES.active;
    const tokens = key.installerTokens;
    // Only trust token liveness when the API actually reported it — a legacy
    // response without the live* fields falls through to the parent-based
    // status rather than guessing every token alive.
    if (
      tokens &&
      tokens.max > 0 &&
      tokens.liveMax !== undefined &&
      tokens.liveConsumed !== undefined
    ) {
      if (tokens.liveConsumed < tokens.liveMax) return STATUS_STYLES.active;
      if (tokens.liveMax > 0) return STATUS_STYLES.exhausted;
      return STATUS_STYLES.expired;
    }
    if (isExpired(key)) return STATUS_STYLES.expired;
    return STATUS_STYLES.exhausted;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">{t('enrollmentKeys.loading')}</p>
        </div>
      </div>
    );
  }

  if (error && keys.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={() => fetchKeys()}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {t('common:actions.retry')}
        </button>
      </div>
    );
  }

  // Whether the create form's site list reflects a completed load. Only once
  // resolved do we show the "no sites yet" empty state — otherwise it flashes
  // before the async site list has actually landed.
  const formSitesResolved = !sitesLoading;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('enrollmentKeys.title')}</h1>
          <p className="text-muted-foreground">
            {/* `key` maps the literal CLI placeholder `<key/>`. Authored as a
                tag rather than plain `<key>` because <Trans> parses the value
                as markup: an unmapped `<key>` is escaped and reaches the user
                as the text "&lt;key>". HTML entities are no help either:
                <Trans> unescapes only under `shouldUnescape`, which this app
                never enables, so `&lt;key&gt;` would render verbatim too.
                See #3964. */}
            <Trans
              i18nKey="enrollmentKeys.description"
              t={t}
              components={{
                code: <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono" />,
                key: <>{'<key>'}</>,
              }}
            />
          </p>
        </div>
        <button
          type="button"
          onClick={handleOpenCreate}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          {t('enrollmentKeys.createKey')}
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {newlyCreatedKey && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          <p className="font-medium text-amber-700 dark:text-amber-300">
            {t('enrollmentKeys.saveNow')}
          </p>
          <code className="mt-2 block overflow-x-auto rounded bg-background px-2 py-1 font-mono text-xs">
            {newlyCreatedKey}
          </code>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => handleCopyKey(newlyCreatedKey, '__newly-created__')}
              className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
            >
              {copiedId === '__newly-created__' ? t('enrollmentKeys.copied') : t('enrollmentKeys.copyKey')}
            </button>
            <button
              type="button"
              onClick={() => setNewlyCreatedKey(null)}
              className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
            >
              {t('enrollmentKeys.dismiss')}
            </button>
          </div>
        </div>
      )}

      {/* Table toolbar: hide-expired toggle + purge-expired action */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            data-testid="hide-expired-toggle"
            checked={hideExpired}
            onChange={(e) => setHideExpired(e.target.checked)}
            className="h-4 w-4 rounded border"
          />
          {t('enrollmentKeys.hideExpired')}
        </label>
        <button
          type="button"
          data-testid="delete-expired-keys"
          onClick={() => setPurgeConfirmOpen(true)}
          disabled={submitting}
          className="inline-flex h-9 items-center justify-center rounded-md border border-destructive/40 px-3 text-sm font-medium text-destructive transition hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t('enrollmentKeys.deleteExpired')}
        </button>
      </div>

      {/* Keys Table */}
      <div className="rounded-lg border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">{t('common:labels.name')}</th>
                <th className="px-4 py-3">{t('enrollmentKeys.shortCode')}</th>
                <th className="px-4 py-3">{t('common:labels.status')}</th>
                <th className="px-4 py-3">{t('enrollmentKeys.usage')}</th>
                <th className="px-4 py-3">{t('enrollmentKeys.expires')}</th>
                <th className="px-4 py-3">{t('common:labels.createdAt')}</th>
                <th className="px-4 py-3 text-right">{t('common:labels.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {keys.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    {t('enrollmentKeys.empty')}
                  </td>
                </tr>
              ) : (
                keys.map((key) => {
                  const status = getKeyStatus(key);
                  return (
                    <tr key={key.id} className="border-b last:border-b-0 hover:bg-muted/50">
                      <td className="px-4 py-3 font-medium">{key.name}</td>
                      <td className="px-4 py-3">
                        {key.shortCode ? (
                          <div className="flex items-center gap-2">
                            <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                              {key.shortCode}
                            </code>
                            <button
                              type="button"
                              onClick={() => handleCopyKey(key.shortCode as string, key.id)}
                              className="text-muted-foreground hover:text-foreground"
                              title={t('enrollmentKeys.copyShortCode')}
                            >
                              {copiedId === key.id ? (
                                <svg className="h-4 w-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                              ) : (
                                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                </svg>
                              )}
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${status.className}`}>
                          {t(/* i18n-dynamic */ `enrollmentKeys.status.${status.key}`)}
                        </span>
                      </td>
                      <td className="px-4 py-3 tabular-nums">
                        <div data-testid={`key-usage-${key.id}`}>
                          {key.usageCount}{key.maxUsage !== null ? ` / ${key.maxUsage}` : ''}
                        </div>
                        {/*
                          #2992 — device slots across the installers minted from
                          this key. A second line rather than a replacement for
                          the numbers above, because the two count different
                          things and neither can be folded into the other:
                          usageCount is enrollments claimed against THIS key,
                          while this is redemptions of bootstrap tokens parented
                          to it. No row is guaranteed to carry both — for the
                          Add-Device / guided-setup parents (the case the bug was
                          reported against) usageCount is inert and this line is
                          the only true statement about the installer, whereas a
                          CLI or MCP-invite key has no tokens at all and only the
                          line above means anything.
                        */}
                        {(() => {
                          /*
                            #3039 — the line distinguishes live from expired
                            capacity so a dead installer cannot read as free
                            slots:
                              - all tokens live  → "Installer devices C / M"
                                (unchanged);
                              - none live        → the totals plus an explicit
                                expired marker — the historical count stays
                                (those devices really did enroll) but the
                                capacity claim is withdrawn;
                              - mixed            → live figures first, dead
                                slots called out ("L / N live · K expired").
                          */
                          const live = installerLiveness(key);
                          if (!live) return null;
                          const label =
                            live.liveMax >= live.max
                              ? t('enrollmentKeys.installerUsage', {
                                  consumed: live.consumed,
                                  max: live.max,
                                })
                              : live.liveMax === 0
                                ? t('enrollmentKeys.installerUsageExpired', {
                                    consumed: live.consumed,
                                    max: live.max,
                                  })
                                : t('enrollmentKeys.installerUsageMixed', {
                                    liveConsumed: live.liveConsumed,
                                    liveMax: live.liveMax,
                                    expired: live.max - live.liveMax,
                                  });
                          return (
                            <div
                              className="text-xs text-muted-foreground"
                              data-testid={`key-installer-usage-${key.id}`}
                            >
                              {label}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {key.expiresAt
                          ? formatDate(key.expiresAt)
                          : t('enrollmentKeys.never')}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {formatDate(key.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="relative inline-flex items-center gap-1">
                          {/* Download Installer Dropdown — gated on the PARENT
                              key being redeemable, not the token-derived row
                              status: the authenticated installer routes 410 on
                              an expired key, so a row kept "Active" by a live
                              installer token must not offer a download that
                              can only fail. */}
                          {isParentActive(key) && key.siteId && (
                            <div className="relative">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDownloadDropdownId(downloadDropdownId === key.id ? null : key.id);
                                }}
                                disabled={downloading}
                                className="rounded-md px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50"
                                title={t('enrollmentKeys.downloadInstaller')}
                              >
                                {downloading ? t('enrollmentKeys.downloading') : t('common:actions.download')}
                              </button>
                              {downloadDropdownId === key.id && (
                                <div className="absolute right-0 top-full z-10 mt-1 w-44 rounded-md border bg-popover py-1 shadow-md">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      handleDownloadInstaller(key.id, 'windows');
                                      setDownloadDropdownId(null);
                                    }}
                                    className="w-full px-3 py-1.5 text-left text-xs hover:bg-muted"
                                  >
                                    Windows (.msi)
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      handleDownloadInstaller(key.id, 'macos');
                                      setDownloadDropdownId(null);
                                    }}
                                    className="w-full px-3 py-1.5 text-left text-xs hover:bg-muted"
                                  >
                                    macOS (.zip)
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={() => handleRotateKey(key)}
                            disabled={submitting}
                            className="rounded-md px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50"
                          >
                            {t('enrollmentKeys.rotate')}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleOpenDelete(key)}
                            className="rounded-md px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                          >
                            {t('common:actions.delete')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t px-4 py-3">
            <span className="text-xs text-muted-foreground">
              {t('enrollmentKeys.page', { current: currentPage, total: totalPages })}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => fetchKeys(currentPage - 1)}
                disabled={currentPage <= 1}
                className="rounded-md border px-3 py-1 text-xs disabled:opacity-40"
              >
                {t('enrollmentKeys.previous')}
              </button>
              <button
                type="button"
                onClick={() => fetchKeys(currentPage + 1)}
                disabled={currentPage >= totalPages}
                className="rounded-md border px-3 py-1 text-xs disabled:opacity-40"
              >
                {t('common:actions.next')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Create Modal */}
      {modalMode === 'create' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-xs">
            <h2 className="text-lg font-semibold">{t('enrollmentKeys.createTitle')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('enrollmentKeys.createDescription')}
            </p>
            <form onSubmit={handleCreateSubmit} className="mt-4 space-y-4">
              <div>
                <label className="text-sm font-medium">{t('common:labels.name')}</label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder={t('enrollmentKeys.namePlaceholder')}
                  required
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-primary"
                />
              </div>
              {organizations.length > 1 && (
                <div>
                  <label className="text-sm font-medium">{t('common:labels.organization')}</label>
                  <select
                    data-testid="enrollment-key-org-select"
                    value={formOrgId}
                    onChange={(e) => {
                      setFormOrgId(e.target.value);
                      setFormSiteId('');
                    }}
                    required
                    className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-primary"
                  >
                    {organizations.map((org) => (
                      <option key={org.id} value={org.id}>{org.name}</option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="text-sm font-medium">{t('common:labels.site')}</label>
                {formSitesResolved && sitesError ? (
                  <div className="mt-1 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                    {t('enrollmentKeys.sitesLoadFailed')}{' '}
                    <button
                      type="button"
                      onClick={() => setSitesReloadNonce((n) => n + 1)}
                      className="font-medium underline hover:no-underline"
                    >
                      {t('enrollmentKeys.retrySites')}
                    </button>
                  </div>
                ) : formSitesResolved && formSites.length === 0 ? (
                  <div className="mt-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
                    {t('enrollmentKeys.noSitesForOrg')}{' '}
                    <a
                      href="/settings/organizations"
                      className="font-medium underline hover:no-underline"
                    >
                      {t('enrollmentKeys.createASite')}
                    </a>
                  </div>
                ) : (
                  <select
                    data-testid="enrollment-key-site-select"
                    value={formSiteId}
                    onChange={(e) => setFormSiteId(e.target.value)}
                    required
                    disabled={!formSitesResolved}
                    className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-primary disabled:opacity-60"
                  >
                    <option value="" disabled>{t('enrollmentKeys.selectSite')}</option>
                    {formSites.map((site) => (
                      <option key={site.id} value={site.id}>{site.name}</option>
                    ))}
                  </select>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('enrollmentKeys.siteHelp')}
                </p>
              </div>
              <div>
                <label className="text-sm font-medium">{t('enrollmentKeys.maxUsage')}</label>
                <input
                  type="number"
                  value={formMaxUsage}
                  onChange={(e) => setFormMaxUsage(e.target.value)}
                  placeholder={t('enrollmentKeys.defaultDeviceLimit')}
                  min={1}
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-primary"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('enrollmentKeys.maxUsageHelp')}
                </p>
              </div>
              <div>
                <label className="text-sm font-medium">{t('enrollmentKeys.expiresAt')}</label>
                <input
                  type="datetime-local"
                  value={formExpiresAt}
                  onChange={(e) => setFormExpiresAt(e.target.value)}
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-primary"
                />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleCloseModal}
                  className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
                >
                  {t('common:actions.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={submitting || !formName.trim() || !formSiteId || sitesLoading}
                  className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting ? t('enrollmentKeys.creating') : t('enrollmentKeys.createKey')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {modalMode === 'delete' && selectedKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-xs">
            <h2 className="text-lg font-semibold">{t('enrollmentKeys.deleteTitle')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              <Trans i18nKey="enrollmentKeys.deleteConfirm" t={t} values={{ name: selectedKey.name }} components={{ name: <span className="font-medium" /> }} />
            </p>
            <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3">
              <p className="text-xs text-destructive">
                {t('enrollmentKeys.deleteWarning')}
              </p>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleCloseModal}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                {t('common:actions.cancel')}
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={submitting}
                className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? t('enrollmentKeys.deleting') : t('enrollmentKeys.deleteKey')}
              </button>
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={rotateTarget !== null}
        onClose={() => setRotateTarget(null)}
        onConfirm={handleConfirmRotate}
        title={t('enrollmentKeys.rotateTitle')}
        message={t('enrollmentKeys.rotateConfirm', { name: rotateTarget?.name })}
        confirmLabel={t('enrollmentKeys.rotateKey')}
        variant="warning"
        isLoading={submitting}
      />
      <ConfirmDialog
        open={purgeConfirmOpen}
        onClose={() => setPurgeConfirmOpen(false)}
        onConfirm={handleConfirmPurgeExpired}
        title={t('enrollmentKeys.deleteExpiredTitle')}
        message={t('enrollmentKeys.deleteExpiredConfirm')}
        confirmLabel={t('enrollmentKeys.deleteExpired')}
        variant="destructive"
        isLoading={submitting}
        confirmTestId="confirm-delete-expired-keys"
      />
    </div>
  );
}
