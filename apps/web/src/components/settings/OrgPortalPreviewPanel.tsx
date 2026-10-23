import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../stores/auth';

/**
 * Staff "Customer view" (#9350): a READ-ONLY render of what the customer portal
 * would show this organization, from GET /orgs/organizations/:id/portal-preview.
 * The API runs the same read models and the same gate table as the portal, so
 * this answers "what data is exposed" — it deliberately does not copy portal
 * layout or reuse portal components, and it never mints a portal credential.
 * No mutations live here (only GETs).
 */

type PreviewSection = {
  key: string;
  enabled: boolean;
  previewAvailable: boolean;
  data: unknown;
  note?: string;
  error?: string;
  reason?: 'permission';
  /** reason:permission -> whole section withheld; dashboard -> tiles omitted. */
  missingPermissions?: string[];
};
type ReadinessCheck = { code: string; message: string; fixTab: string };
type Preview = {
  portalUser: { id: string; name: string | null; email: string } | null;
  sections: PreviewSection[];
  readiness: ReadinessCheck[];
};
type PortalUserOption = { id: string; email: string; name: string | null };

/** Gate-table section key → the existing visibility-toggle whose label names it. */
const SECTION_TOGGLE: Record<string, string> = {
  dashboard: 'enableDashboard',
  security: 'enableSecurity',
  backups: 'enableBackups',
  reports: 'enableReports',
  lifecycleReports: 'enableLifecycle',
  service: 'enableService',
  hardwareHealth: 'enableHardwareHealth',
  hardwareInventory: 'enableHardwareInventory',
  performance: 'enablePerformanceMetrics',
  software: 'enableSoftwareInventory',
  patches: 'enablePatchDetail',
  vulnerabilities: 'enableVulnerabilityDetail',
  supportUsage: 'enableSupportUsage',
  documents: 'enableDocuments',
};

/** Org record tabs a readiness check can deep-link to (hash state). */
const FIX_TAB_HASH = new Set(['documents', 'service']);

type Row = { label: string; value: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Compact "names, statuses, counts" rows for one section's payload. */
function summarize(key: string, data: unknown): Row[] {
  if (!isRecord(data)) return [];
  if (key === 'documents') {
    return (Array.isArray(data.groups) ? data.groups : []).flatMap((g: any) =>
      (g.documents ?? []).filter((d: any) => d?.title).map((d: any) => ({ label: String(d.title), value: String(g.category ?? '') })));
  }
  if (key === 'service') {
    return (Array.isArray(data.groups) ? data.groups : []).flatMap((g: any) =>
      (g.deliverables ?? []).filter((d: any) => d?.name).map((d: any) => ({ label: String(d.name), value: String(d.status ?? '') })));
  }
  if (key === 'reports') {
    return (Array.isArray(data.data) ? data.data : []).filter((r: any) => r?.name).map((r: any) => ({
      label: String(r.name), value: String(r.status ?? ''),
    }));
  }
  // Generic: top-level scalars, plus one level into tile objects (status/count).
  const rows: Row[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (k === 'asOf' || k === 'timezone') continue;
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
      rows.push({ label: k, value: String(v) });
    } else if (Array.isArray(v)) {
      rows.push({ label: k, value: String(v.length) });
    } else if (isRecord(v)) {
      const scalar = Object.entries(v)
        .filter(([, x]) => x !== null && ['string', 'number', 'boolean'].includes(typeof x))
        .filter(([f]) => f !== 'asOf' && f !== 'capturedAt' && f !== 'timezone')
        .slice(0, 3)
        .map(([f, x]) => `${f}: ${String(x)}`)
        .join(' · ');
      rows.push({ label: k, value: scalar });
    }
  }
  return rows;
}

export default function OrgPortalPreviewPanel({ orgId, refreshKey = 0 }: { orgId: string; refreshKey?: number }) {
  const { t } = useTranslation('settings');
  const [users, setUsers] = useState<PortalUserOption[]>([]);
  const [portalUserId, setPortalUserId] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth(`/orgs/organizations/${orgId}/portal-users`);
        if (!res.ok) {
          // The picker is optional; log the status so an empty picker is debuggable.
          console.warn('[OrgPortalPreviewPanel] portal users request failed', res.status);
          return;
        }
        const body = await res.json();
        if (!cancelled && Array.isArray(body?.data)) setUsers(body.data as PortalUserOption[]);
      } catch (err) {
        // The picker is optional: without it the preview is the org-wide view.
        console.warn('[OrgPortalPreviewPanel] portal users failed to load', err);
      }
    })();
    return () => { cancelled = true; };
  }, [orgId]);

  // Responses can arrive out of order when the picker changes quickly: only the
  // latest request may write state.
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setFailed(false);
    // Never show user A's data under a picker already pointing at user B.
    setPreview(null);
    try {
      const qs = portalUserId ? `?portalUserId=${encodeURIComponent(portalUserId)}` : '';
      const res = await fetchWithAuth(`/orgs/organizations/${orgId}/portal-preview${qs}`);
      if (seq !== requestSeq.current) return;
      if (res.status === 404 && portalUserId) {
        // The selected portal user no longer exists: fall back to the org-wide view.
        setPortalUserId('');
        return;
      }
      if (!res.ok) throw new Error(`portal preview failed: ${res.status}`);
      const data = (await res.json())?.data as Partial<Preview> | undefined;
      if (!data || !Array.isArray(data.sections)) throw new Error('portal preview: unexpected response shape');
      if (seq !== requestSeq.current) return;
      setPreview({
        portalUser: data.portalUser ?? null,
        sections: data.sections,
        readiness: Array.isArray(data.readiness) ? data.readiness : [],
      });
    } catch (err) {
      if (seq !== requestSeq.current) return;
      console.warn('[OrgPortalPreviewPanel] load failed', err);
      setFailed(true);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [orgId, portalUserId]);

  // `refreshKey` bumps when the settings editor saves, so the preview does not
  // keep showing the pre-save gate state.
  useEffect(() => { void load(); }, [load, refreshKey]);

  const who = preview?.portalUser
    ? (preview.portalUser.name || preview.portalUser.email)
    : t('orgPortalSettingsEditor.preview.whoOrganization');

  return (
    <section className="rounded-lg border bg-card p-6 shadow-xs" data-testid="org-portal-preview">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t('orgPortalSettingsEditor.preview.title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground" data-testid="org-portal-preview-subtitle">
            {t('orgPortalSettingsEditor.preview.subtitle', { who })}
          </p>
        </div>
        <label className="text-sm">
          <span className="mr-2 text-muted-foreground">{t('orgPortalSettingsEditor.preview.pickerLabel')}</span>
          <select
            value={portalUserId}
            onChange={(e) => setPortalUserId(e.target.value)}
            className="rounded-md border bg-background px-2 py-1"
            data-testid="org-portal-preview-user"
          >
            <option value="">{t('orgPortalSettingsEditor.preview.pickerAll')}</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.name ? `${u.name} (${u.email})` : u.email}</option>
            ))}
          </select>
        </label>
      </div>

      {loading && !preview && (
        <p className="mt-4 text-sm text-muted-foreground">{t('orgPortalSettingsEditor.preview.loading')}</p>
      )}

      {failed && (
        <p className="mt-4 text-sm" data-testid="org-portal-preview-error">
          {t('orgPortalSettingsEditor.preview.loadFailed')}{' '}
          <button type="button" onClick={() => void load()} className="underline hover:text-foreground">
            {t('common:actions.retry')}
          </button>
        </p>
      )}

      {preview && (
        <>
          <div className="mt-4" data-testid="org-portal-preview-readiness">
            <h3 className="text-sm font-semibold">{t('orgPortalSettingsEditor.preview.readinessTitle')}</h3>
            {preview.readiness.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">{t('orgPortalSettingsEditor.preview.readinessNone')}</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {preview.readiness.map((check) => (
                  <li
                    key={check.code}
                    className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
                    data-testid={`org-portal-preview-readiness-${check.code}`}
                  >
                    {t(/* i18n-dynamic */ `orgPortalSettingsEditor.preview.readiness.${check.code}`, { defaultValue: check.message })}
                    {FIX_TAB_HASH.has(check.fixTab) && (
                      <>
                        {' '}
                        <a className="underline" href={`/organizations/${orgId}#${check.fixTab}`}>
                          {t('orgPortalSettingsEditor.preview.fix')}
                        </a>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mt-4 space-y-3">
            {preview.sections
              // ticketUsage is a route-level gate row, not a customer-facing section.
              .filter((s) => s.key !== 'ticketUsage')
              .map((s) => {
                const toggle = SECTION_TOGGLE[s.key];
                const label = toggle
                  ? t(/* i18n-dynamic */ `orgPortalSettingsEditor.visibility.toggles.${toggle}.label`)
                  : s.key;
                const rows = s.enabled && s.data ? summarize(s.key, s.data) : [];
                return (
                  <div
                    key={s.key}
                    className="rounded-md border bg-muted/30 p-3"
                    data-testid={`org-portal-preview-section-${s.key}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">{label}</span>
                      <span className="text-xs text-muted-foreground">
                        {s.enabled ? t('orgPortalSettingsEditor.preview.on') : t('orgPortalSettingsEditor.preview.off')}
                      </span>
                    </div>
                    {s.error && (
                      <p className="mt-1 text-xs text-destructive" data-testid={`org-portal-preview-section-error-${s.key}`}>
                        {t('orgPortalSettingsEditor.preview.loadFailed')}
                      </p>
                    )}
                    {s.enabled && !s.previewAvailable && s.reason !== 'permission' && (
                      <p className="mt-1 text-xs text-muted-foreground">{t('orgPortalSettingsEditor.preview.notAvailable')}</p>
                    )}
                    {s.reason === 'permission' && (
                      <p className="mt-1 text-xs text-muted-foreground" data-testid={`org-portal-preview-section-permission-${s.key}`}>
                        {t('orgPortalSettingsEditor.preview.permissionWithheld', { permissions: (s.missingPermissions ?? []).join(', ') })}
                      </p>
                    )}
                    {s.reason !== 'permission' && s.missingPermissions && s.missingPermissions.length > 0 && (
                      <p className="mt-1 text-xs text-muted-foreground" data-testid={`org-portal-preview-section-tiles-permission-${s.key}`}>
                        {t('orgPortalSettingsEditor.preview.tilesWithheld', { permissions: s.missingPermissions.join(', ') })}
                      </p>
                    )}
                    {s.note && (
                      <p className="mt-1 text-xs text-muted-foreground">{t('orgPortalSettingsEditor.preview.noteNoUser')}</p>
                    )}
                    {rows.length > 0 && (
                      <ul className="mt-2 space-y-1 text-sm">
                        {rows.map((r, i) => (
                          <li key={`${r.label}-${i}`} className="flex justify-between gap-3">
                            <span className="truncate">{r.label}</span>
                            <span className="text-muted-foreground">{r.value}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
          </div>
        </>
      )}
    </section>
  );
}
