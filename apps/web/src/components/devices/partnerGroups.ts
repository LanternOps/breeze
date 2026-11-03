import type { FilterFieldDefinition, FilterRoot } from '@breeze/shared';
import { useDefaultOwnerScope } from '@/hooks/useDefaultOwnerScope';
import { getJwtClaims } from '@/lib/authScope';
import { extractApiError } from '@/lib/apiError';
import { i18n } from '@/lib/i18n';
import { useAuthStore } from '@/stores/auth';

export type GroupOwnerScope = 'organization' | 'partner';
export const PARTNER_GROUP_REFUSED_FIELDS = ['groupId', 'orgId'];

export function partnerGroupFilterFields<T extends FilterFieldDefinition>(fields: T[]): T[] {
  return fields.filter((field) => !PARTNER_GROUP_REFUSED_FIELDS.includes(field.key));
}

export function partnerGroupFilterHasRefusedField(filter: FilterRoot | null | undefined): boolean {
  if (!filter) return false;
  if ('field' in filter) return PARTNER_GROUP_REFUSED_FIELDS.includes(filter.field);
  return filter.conditions.some(partnerGroupFilterHasRefusedField);
}

export function groupApiErrorMessage(body: unknown, fallback: string): string {
  const code = body && typeof body === 'object' ? (body as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && i18n.exists(`errors:${code}`)) {
    return i18n.t(/* i18n-dynamic */ `errors:${code}`);
  }
  return extractApiError(body, fallback);
}

export function usePartnerGroupCapabilities() {
  const { isPartnerScope } = useDefaultOwnerScope();
  const canManagePartnerWide = useAuthStore((s) => s.user?.canManagePartnerWide) !== false;
  // Subscribe to token refresh so system write controls also update after hydration.
  useAuthStore((s) => s.tokens?.accessToken);
  const canCreatePartnerGroup = isPartnerScope && canManagePartnerWide;
  return { canCreatePartnerGroup, canWritePartnerGroups: canCreatePartnerGroup || getJwtClaims().scope === 'system' };
}
