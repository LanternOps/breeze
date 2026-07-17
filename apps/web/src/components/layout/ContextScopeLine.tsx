import { useEffect, useState } from 'react';
import { Globe, Library, Building2 } from 'lucide-react';
import { getRouteScope } from '../../lib/routeScope';
import { useOrgStore } from '../../stores/orgStore';
import { useOrgScope } from '@/hooks/useOrgScope';
import { useTranslation } from 'react-i18next';

/**
 * The page-scope half of the two-layer context model. The header switcher
 * states the user's context; this line — mounted once in DashboardLayout, so
 * no page can forget it — states what the current PAGE does with that context,
 * but only when that carries information the switcher alone doesn't:
 *
 *   catalog page            → "Catalog — same for every organization"
 *   fleet view, fleet page  → "Showing all organizations · N"
 *   fleet view, org-required→ "This page shows one organization at a time"
 *
 * Org view on an org page renders nothing (the trigger already says it), as do
 * partner-settings and device/self surfaces.
 */
export default function ContextScopeLine() {
  const { t } = useTranslation('common');
  // Pathname is read after mount: this island renders inside the swapped page
  // content, so SSR must emit nothing scope-specific (the store is empty
  // server-side anyway) and the real line appears on hydration.
  const [pathname, setPathname] = useState<string | null>(null);
  const scope = useOrgScope();
  const orgCount = useOrgStore((s) => s.organizations.length);

  useEffect(() => {
    setPathname(window.location.pathname);
  }, []);

  if (!pathname) return null;
  const kind = getRouteScope(pathname);
  // Explicit fleet view only — the hook's discriminated union keeps the
  // transient/loading and error states from reading as fleet.
  const isFleet = scope.scope === 'all';

  if (kind === 'catalog') {
    return (
      <p
        data-testid="context-scope-line"
        data-kind="catalog"
        className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground"
      >
        <Library className="h-3.5 w-3.5" aria-hidden="true" />
        {t('layout.scope.catalogLine')}
      </p>
    );
  }

  if (kind === 'org-or-all' && isFleet) {
    return (
      <p
        data-testid="context-scope-line"
        data-kind="fleet"
        className="mb-4 flex items-center gap-1.5 text-sm text-primary"
      >
        <Globe className="h-3.5 w-3.5" aria-hidden="true" />
        {t('layout.scope.fleetLine', { count: orgCount })}
      </p>
    );
  }

  if (kind === 'org-required' && isFleet) {
    return (
      <p
        data-testid="context-scope-line"
        data-kind="org-required"
        className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground"
      >
        <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
        {t('layout.scope.orgRequiredLine')}
      </p>
    );
  }

  return null;
}
