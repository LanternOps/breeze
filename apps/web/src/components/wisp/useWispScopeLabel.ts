import { useTranslation } from 'react-i18next';
import { useOrgStore } from '@/stores/orgStore';

/**
 * What WispWelcome's "{{scope}}" reads for the organization a Wisp session runs
 * in: its name, or "All organizations" for a partner-wide one (as the Wisp home
 * words it). An org not in the switcher's list yet (a direct load of /ai/chat
 * before the list arrives) reads "this organization", never an empty name.
 */
export function useWispScopeLabel(orgId: string | null): string {
  const { t } = useTranslation('ai');
  const name = useOrgStore((s) => (orgId ? ((s.organizations ?? []).find((o) => o.id === orgId)?.name ?? null) : null));
  if (orgId === null) return t('wisp.header.scopeAll');
  return name ?? t('wisp.header.scopeFallback');
}
