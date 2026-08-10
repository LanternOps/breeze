import '@/lib/i18n';
import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useDashboardQuery } from '../../hooks/useDashboardQuery';
import { useFeaturesStore } from '../../stores/featuresStore';
import { usePermissions } from '../../lib/permissions';
import type { DeviceStats } from '../dashboard/types';

const MIGRATION_DOCS_URL = 'https://docs.breezermm.com/agents/self-host-migration/';

/**
 * Persistent, non-dismissible notice for self-hosted admins: devices in scope
 * are still running the hosted agent edition and must be migrated to the
 * self-host edition.
 *
 * Deliberately has NO dismiss control and no "seen" state — it disappears only
 * when the server-side condition clears (`migrationRequiredCount` hits 0), the
 * same show/hide model as MacOSPermissionsBanner. Mounted once in
 * DashboardLayout so it appears on every authenticated page.
 *
 * Three gates, all client-side (UX only — nothing here is an authorization
 * decision):
 *  1. self-hosted deployment — no billing and no support feature, the same
 *     proxy Header.tsx uses for its hosted-only menu items. Gated on the
 *     /config fetch having resolved so a hosted instance never flashes it.
 *  2. admin — holds the `*:*` grant (PERMISSION_GRANTS.ADMIN_ALL); nobody else
 *     can act on a fleet-wide agent migration.
 *  3. at least one device reporting `migrationRequired`.
 */
export default function MigrationRequiredBanner() {
  const features = useFeaturesStore((s) => s.features);
  const featuresLoaded = useFeaturesStore((s) => s.loaded);
  const loadFeatures = useFeaturesStore((s) => s.load);
  const { can } = usePermissions();

  // Idempotent (the store no-ops once loaded) — this island can mount on pages
  // that render before Header has asked for /config.
  useEffect(() => {
    void loadFeatures();
  }, [loadFeatures]);

  const isSelfHosted = !features.billing && !features.support;
  const isAdmin = can('*', '*');

  // The stats fetch lives in the child so the two cheap gates short-circuit it:
  // hosted instances and non-admins never hit /devices/stats for this banner.
  if (!featuresLoaded || !isSelfHosted || !isAdmin) return null;

  return <MigrationRequiredBannerBody />;
}

function MigrationRequiredBannerBody() {
  const { t } = useTranslation('common');
  // Same tenant-scoped endpoint the dashboard already reads; refreshToken 0
  // means "no polling" — every Astro page navigation remounts this island and
  // re-fetches, and the hook re-fetches on an org-scope change.
  const stats = useDashboardQuery<DeviceStats>(
    '/devices/stats',
    0,
    (json) => (json as { data: DeviceStats }).data,
  );
  const count = stats.data?.migrationRequiredCount ?? 0;

  if (count <= 0) return null;

  return (
    <div
      role="status"
      data-testid="migration-required-banner"
      className="mb-4 flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3"
    >
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">{t('migrationBanner.message', { count })}</p>
      </div>
      <a
        href={MIGRATION_DOCS_URL}
        target="_blank"
        rel="noreferrer"
        className="shrink-0 text-sm font-medium text-foreground underline"
      >
        {t('migrationBanner.cta')}
      </a>
    </div>
  );
}
