import type { CatalogTabKey, InheritanceOrgPageDto, InheritanceOrgRowDto, InheritanceTabDto } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';

/**
 * Partner settings inheritance read model (#9170 W3, spec §5.6): per-field org
 * counts for one partner settings tab, and the org list behind a count.
 *
 * Read-only. A failure is never toasted: the page degrades to badges without
 * counts (§11). Partner-axis routes, so the ambient `?orgId=` is never injected.
 * A request that hangs is abandoned after `INHERITANCE_TIMEOUT_MS` and treated
 * as a failure, so no spinner waits forever.
 */
export const INHERITANCE_PATH = '/orgs/partners/me/settings-inheritance';
export const INHERITANCE_TIMEOUT_MS = 15_000;

/** The drill-down list a count opens (the API's `bucket`). */
export type InheritanceBucket = 'ownValue' | 'overrides' | 'shadowed' | 'clamped';

export type TabInheritanceResult =
  | { status: 'ok'; data: InheritanceTabDto }
  | { status: 'restricted' }
  | { status: 'unavailable' };

const NOT_JSON = Symbol('not-json');

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => NOT_JSON);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function errorCode(body: unknown): string {
  if (body === NOT_JSON) return 'non-JSON body';
  const code = isObject(body) ? body.code ?? body.error : undefined;
  return typeof code === 'string' ? code : 'no code';
}

function isPartnerWideDenial(status: number, body: unknown): boolean {
  return status === 403 && isObject(body) && body.code === 'PARTNER_WIDE_REQUIRED';
}

function isTabDto(data: unknown): data is InheritanceTabDto {
  return isObject(data)
    && typeof data.orgCount === 'number'
    && Array.isArray(data.fields)
    && data.fields.every(f => isObject(f) && typeof f.id === 'string'
      && (f.byConsumer === undefined || (Array.isArray(f.byConsumer) && f.byConsumer.every(b => isObject(b) && isObject(b.counts)))));
}

const isOwnValue = (v: unknown) => isObject(v) && typeof v.set === 'boolean';

function isOrgRow(row: unknown): row is InheritanceOrgRowDto {
  return isObject(row)
    && typeof row.orgId === 'string'
    && typeof row.orgName === 'string'
    && isOwnValue(row.ownValue)
    && (row.channels === undefined || (Array.isArray(row.channels) && row.channels.every(ch => isObject(ch) && isOwnValue(ch.ownValue))));
}

/**
 * Counts for one tab. 403 `PARTNER_WIDE_REQUIRED` means the user has selected
 * org access (badges only); any other failure is `unavailable`.
 */
export async function fetchTabInheritance(tab: CatalogTabKey): Promise<TabInheritanceResult> {
  try {
    const response = await fetchWithAuth(`${INHERITANCE_PATH}?tab=${encodeURIComponent(tab)}`, {
      skipOrgIdInjection: true,
      signal: AbortSignal.timeout(INHERITANCE_TIMEOUT_MS),
    });
    const body = await readJson(response);
    if (isPartnerWideDenial(response.status, body)) return { status: 'restricted' };
    const data = isObject(body) ? body.data : undefined;
    if (!response.ok || !isTabDto(data)) {
      console.warn(`[partner-settings] inheritance read for ${tab} failed (HTTP ${response.status}, ${errorCode(body)})`);
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
  const response = await fetchWithAuth(`${INHERITANCE_PATH}/orgs?${params.toString()}`, {
    skipOrgIdInjection: true,
    signal: AbortSignal.timeout(INHERITANCE_TIMEOUT_MS),
  });
  const body = await readJson(response);
  const data = isObject(body) ? body.data : undefined;
  if (!response.ok || !isObject(data) || !Array.isArray(data.rows) || !data.rows.every(isOrgRow)) {
    throw new Error(`inheritance_orgs_failed_${response.status} (${errorCode(body)})`);
  }
  return data as unknown as InheritanceOrgPageDto;
}
