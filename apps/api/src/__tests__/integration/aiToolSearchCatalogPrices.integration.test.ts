/**
 * #9692 — the `search_catalog` AI tool returns each item's price book. Written as
 * a correlated subquery in a single-table select, `prices` rendered
 * `p.item_id = "id"`, which bound to catalog_item_prices.id, so every item read
 * as having no prices. Only real Postgres shows that.
 */
import './setup';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { catalogItemPrices } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../../services/aiTools';
import { registerCatalogTools } from '../../services/aiToolsCatalog';
import { createCatalogItemWithPrice, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const admin = () => getTestDb() as any;

const registry = new Map<string, AiTool>();
registerCatalogTools(registry);

describe('search_catalog prices', () => {
  it('returns each item\'s own prices, in currency order, and [] for an item with none', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id, orgId: null });

    const priced = await withSystemDbAccessContext(() => createCatalogItemWithPrice({
      partnerId: partner.id, name: 'priced', currencyCode: 'USD', unitPrice: '100.00',
    }));
    await admin().insert(catalogItemPrices).values({
      itemId: priced.id, partnerId: partner.id, currencyCode: 'EUR', unitPrice: '90.00',
    });
    const other = await withSystemDbAccessContext(() => createCatalogItemWithPrice({
      partnerId: partner.id, name: 'other', currencyCode: 'USD', unitPrice: '5.00',
    }));
    const unpriced = await withSystemDbAccessContext(() => createCatalogItemWithPrice({
      partnerId: partner.id, name: 'unpriced', currencyCode: 'USD', unitPrice: '1.00',
    }));
    await admin().delete(catalogItemPrices).where(eq(catalogItemPrices.itemId, unpriced.id));

    const ctx: DbAccessContext = {
      scope: 'partner', orgId: null, accessibleOrgIds: [], accessiblePartnerIds: [partner.id],
      userId: user.id, currentPartnerId: partner.id,
    };
    const auth = { scope: 'partner', partnerId: partner.id, orgId: null, user: { id: user.id } } as unknown as AuthContext;
    const handler = registry.get('search_catalog')!.handler;
    const { items } = JSON.parse(await withDbAccessContext(ctx, async () => handler({}, auth))) as {
      items: Array<{ id: string; prices: Array<{ currencyCode: string; unitPrice: string }> }>;
    };
    const prices = new Map(items.map((item) => [item.id, item.prices]));

    expect(prices.get(priced.id)).toEqual([
      { currencyCode: 'EUR', unitPrice: '90.00' },
      { currencyCode: 'USD', unitPrice: '100.00' },
    ]);
    expect(prices.get(other.id)).toEqual([{ currencyCode: 'USD', unitPrice: '5.00' }]);
    expect(prices.get(unpriced.id)).toEqual([]);
  });
});
