import { useTranslation } from 'react-i18next';
import { useOrgStore } from '@/stores/orgStore';

/**
 * What WispWelcome's "{{scope}}" reads for the organization a Wisp session runs
 * in: its name, or "All organizations" for a partner-wide one (as the Wisp home
 * words it).
 */
export function useWispScopeLabel(orgId: string | null): string {
  const { t } = useTranslation('ai');
  const name = useOrgStore((s) => (orgId ? ((s.organizations ?? []).find((o) => o.id === orgId)?.name ?? null) : null));
  return orgId === null ? t('wisp.header.scopeAll') : (name ?? '');
}
