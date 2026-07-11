// apps/web/src/components/layout/PageScopeIndicator.tsx
import { Globe, Building2 } from 'lucide-react';
import { isGlobalScopeRoute } from '../../lib/routeScope';
import { useTranslation } from 'react-i18next';

// Calm, page-level scope cue. Sits in the page header next to the title so the
// "whose data is this?" answer lives next to the content, not only in the
// far-away top-right switcher.
export function PageScopeIndicator({ pathname, orgName }: { pathname: string; orgName?: string | null }) {
  const { t } = useTranslation('common');
  const global = isGlobalScopeRoute(pathname);
  return (
    <span
      data-testid="page-scope-indicator"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground"
    >
      {global ? <Globe className="h-3.5 w-3.5" /> : <Building2 className="h-3.5 w-3.5" />}
      {global ? t('layout.scope.shared') : (orgName ?? t('layout.scope.allOrganizations'))}
    </span>
  );
}
