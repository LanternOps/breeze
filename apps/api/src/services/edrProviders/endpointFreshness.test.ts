import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { EDR_PROVIDER_KEYS, getEdrProvider } from './registry';
import {
  EDR_DETAIL_FRESHNESS_MS,
  edrEndpointStateFreshSql,
  hasDetailOwnedState,
  isEdrEndpointStateFresh,
} from './endpointFreshness';

const NOW = new Date('2026-11-27T12:00:00.000Z');
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const render = (q: ReturnType<typeof edrEndpointStateFreshSql>) => new PgDialect().sqlToQuery(q);

/** What the provider's own capabilities say: its list does not refresh health / online every run. */
const declaresDetailOwnedState = (key: string) => {
  const owned = getEdrProvider(key).capabilities.detailOwnedFields ?? [];
  return owned.includes('health') || owned.includes('online');
};

describe('EDR endpoint state freshness (#12825)', () => {
  it('the bound is 24 hours', () => {
    expect(EDR_DETAIL_FRESHNESS_MS).toBe(24 * HOUR);
  });

  it('applies to exactly the providers whose health / online are detail-owned', () => {
    for (const key of EDR_PROVIDER_KEYS) {
      expect(hasDetailOwnedState(key), key).toBe(declaresDetailOwnedState(key));
    }
  });

  it('a detail-owned provider: fresh only when its details were read within the bound', () => {
    for (const key of EDR_PROVIDER_KEYS.filter(declaresDetailOwnedState)) {
      expect(isEdrEndpointStateFresh({ provider: key, vendorDetailSyncedAt: ago(HOUR) }, NOW), key).toBe(true);
      expect(isEdrEndpointStateFresh({ provider: key, vendorDetailSyncedAt: ago(24 * HOUR) }, NOW), key).toBe(true);
      expect(isEdrEndpointStateFresh({ provider: key, vendorDetailSyncedAt: ago(24 * HOUR + 1) }, NOW), key).toBe(false);
      expect(isEdrEndpointStateFresh({ provider: key, vendorDetailSyncedAt: ago(10 * 24 * HOUR) }, NOW), key).toBe(false);
      // Never read: the list placeholders are no evidence.
      expect(isEdrEndpointStateFresh({ provider: key, vendorDetailSyncedAt: null }, NOW), key).toBe(false);
    }
  });

  it('a provider whose list supplies health every run is always fresh, read or not (unchanged behaviour)', () => {
    for (const key of [...EDR_PROVIDER_KEYS.filter((k) => !declaresDetailOwnedState(k)), 'list_owned_provider']) {
      expect(hasDetailOwnedState(key), key).toBe(false);
      expect(isEdrEndpointStateFresh({ provider: key, vendorDetailSyncedAt: null }, NOW), key).toBe(true);
      expect(isEdrEndpointStateFresh({ provider: key, vendorDetailSyncedAt: ago(30 * 24 * HOUR) }, NOW), key).toBe(true);
    }
  });

  it('the SQL predicate names the detail-owned providers and the cutoff, and is true for every other provider', () => {
    const q = render(edrEndpointStateFreshSql(sql.raw('e.provider'), sql.raw('e.vendor_detail_synced_at'), NOW));
    expect(q.sql).toBe('(e.provider not in ($1, $2) or e.vendor_detail_synced_at >= $3::timestamptz)');
    expect(q.params).toEqual([...EDR_PROVIDER_KEYS.filter(declaresDetailOwnedState), ago(24 * HOUR).toISOString()]);
  });
});
