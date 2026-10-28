import type { CatalogTabKey, InheritanceOrgPageDto, InheritanceTabDto } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';

/**
 * Partner settings inheritance read model (#9170 W3, spec §5.6): per-field org
 * counts for one partner settings tab, and the org list behind a count.
 *
 * Read-only. A failure is never toasted: the page degrades to badges without
 * counts (§11). Partner-axis routes, so the ambient `?orgId=` is never injected.
 */
export const INHERITANCE_PATH = '/orgs/partners/me/settings-inheritance';

/** The drill-down list a count opens (the API's `bucket`). */
export type InheritanceBucket = 'ownValue' | 'overrides' | 'shadowed' | 'clamped';

export type TabInheritanceResult =
  | { status: 'ok'; data: InheritanceTabDto }
  | { status: 'restricted' }
  | { status: 'unavailable' };

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function isPartnerWideDenial(status: number, body: unknown): boolean {
  return status === 403
    && typeof body === 'object' && body !== null
    && (body as { code?: unknown }).code === 'PARTNER_WIDE_REQUIRED';
}

/**
 * Counts for one tab. 403 `PARTNER_WIDE_REQUIRED` means the user has selected
 * org access (badges only); any other failure is `unavailable`.
 */
export async function fetchTabInheritance(tab: CatalogTabKey): Promise<TabInheritanceResult> {
  try {
    const response = await fetchWithAuth(`${INHERITANCE_PATH}?tab=${encodeURIComponent(tab)}`, { skipOrgIdInjection: true });
    const body = await readJson(response);
    if (isPartnerWideDenial(response.status, body)) return { status: 'restricted' };
    const data = (body as { data?: InheritanceTabDto } | null)?.data;
    if (!response.ok || !data || !Array.isArray(data.fields)) {
      console.warn(`[partner-settings] inheritance read for ${tab} failed (HTTP ${response.status})`);
      return { status: 'unavailable' };
    }
    return { status: 'ok', data };
  } catch (err) {
    console.warn(`[partner-settings] inheritance read for ${tab} failed`, err);
    return { status: 'unavailable' };
  }
}

/** One page of the orgs behind a field's count. Throws on failure (the drill-down shows a retry). */
export async function fetchFieldOrgs(
  field: string,
  cursor: string | null,
  bucket: InheritanceBucket = 'ownValue',
): Promise<InheritanceOrgPageDto> {
  const params = new URLSearchParams({ field, bucket });
  if (cursor) params.set('cursor', cursor);
  const response = await fetchWithAuth(`${INHERITANCE_PATH}/orgs?${params.toString()}`, { skipOrgIdInjection: true });
  const body = await readJson(response);
  const data = (body as { data?: InheritanceOrgPageDto } | null)?.data;
  if (!response.ok || !data || !Array.isArray(data.rows)) {
    throw new Error(`inheritance_orgs_failed_${response.status}`);
  }
  return data;
}
