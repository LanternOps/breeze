import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ db: {} }));
vi.mock('../llmProviderCatalog', () => ({ getListedProviderByEntryId: vi.fn() }));

import { offeringPriceSource } from './offerings';

const priced = { priceInputCentsPerM: 100 };
const unpriced = { priceInputCentsPerM: null };

describe('offeringPriceSource — spec §8 precedence (#7600 W02)', () => {
  it.each([
    // [label, offering, ctx, expected]
    ['platform offering, priced platform row', { source: 'platform', platformModelId: 'pm', ...unpriced }, { platformRowPriced: true, catalogMapsAndVerifies: false }, 'platform'],
    ['platform offering, UNPRICED platform row', { source: 'platform', platformModelId: 'pm', ...unpriced }, { platformRowPriced: false, catalogMapsAndVerifies: false }, null],
    ['byok with its own price wins over a linked row', { source: 'discovered', platformModelId: 'pm', ...priced }, { platformRowPriced: true, catalogMapsAndVerifies: false }, 'offering'],
    ['byok linked to a priced platform row', { source: 'discovered', platformModelId: 'pm', ...unpriced }, { platformRowPriced: true, catalogMapsAndVerifies: false }, 'linked_platform'],
    ['byok linked to an unpriced platform row', { source: 'discovered', platformModelId: 'pm', ...unpriced }, { platformRowPriced: false, catalogMapsAndVerifies: false }, null],
    ['manual with a price', { source: 'manual', platformModelId: null, ...priced }, { platformRowPriced: false, catalogMapsAndVerifies: false }, 'offering'],
    ['manual without a price', { source: 'manual', platformModelId: null, ...unpriced }, { platformRowPriced: false, catalogMapsAndVerifies: false }, null],
    ['catalog mapped + verified', { source: 'catalog', platformModelId: null, ...unpriced }, { platformRowPriced: false, catalogMapsAndVerifies: true }, 'catalog'],
    ['catalog not in the revision', { source: 'catalog', platformModelId: null, ...unpriced }, { platformRowPriced: false, catalogMapsAndVerifies: false }, null],
  ] as const)('%s', (_label, offering, ctx, expected) => {
    expect(offeringPriceSource(offering as never, ctx)).toBe(expected);
  });
});
