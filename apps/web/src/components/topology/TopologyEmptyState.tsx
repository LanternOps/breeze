import { Loader2, Network } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useJwtClaims } from '@/lib/authScope';
import { EmptyState } from '../shared/EmptyState';

/**
 * Rendered by `TopologyEntry` when the site's `ui` capability is unavailable.
 * The API reason (`apps/api/src/services/topology/flags.ts`) is a developer
 * code, never user copy: known codes map to a per-reason next step, anything
 * else falls back to a generic message with the code tucked into a collapsed
 * `<details>` so support can still read it.
 */
export default function TopologyEmptyState({ reason }: { reason: string | null }) {
  const { t } = useTranslation('topology');
  const jwt = useJwtClaims();
  const isPartner = jwt.status === 'resolved' && jwt.claims.scope === 'partner';

  if (reason === 'materialization_disabled' || reason === 'ui_disabled') {
    return <EmptyState
      testId="topology-empty-state"
      icon={<Network className="h-7 w-7" />}
      title={t('emptyState.off.title')}
      description={`${t('emptyState.off.body')} ${isPartner ? t('emptyState.off.partnerNextStep') : t('emptyState.off.orgNextStep')}`}
      action={isPartner ? <a href="/settings/partner#modules" className="inline-flex items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">{t('emptyState.off.openModules')}</a> : undefined}
    />;
  }

  if (reason === 'topology_preparing') {
    return <EmptyState
      testId="topology-empty-state"
      icon={<Loader2 className="h-7 w-7 animate-spin" />}
      title={t('emptyState.preparing.title')}
      description={t('emptyState.preparing.body')}
      intro={<span role="status" className="sr-only">{t('emptyState.preparing.title')}</span>}
    />;
  }

  return <EmptyState
    testId="topology-empty-state"
    icon={<Network className="h-7 w-7" />}
    title={t('emptyState.unavailable.title')}
    description={t('emptyState.unavailable.body')}
    secondary={reason ? <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t('emptyState.unavailable.details')}</summary><code className="mt-1 block font-mono">{reason}</code></details> : undefined}
  />;
}
