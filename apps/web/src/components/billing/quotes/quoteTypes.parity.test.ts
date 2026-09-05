import { describe, expect, it } from 'vitest';
import { BILLABLE_DEVICE_ROLES, DEVICE_ROLE_NOUNS, quoteBlockTypeSchema, quoteStatusSchema, updateQuoteLineSchema } from '@breeze/shared';
import enBilling from '../../../locales/en/billing.json';
import type { QuoteBlockType, QuoteStatus } from './quoteTypes';
import type { LineUpdate } from './quoteEditorShared';

// Drift guard (same spirit as the i18n translationCoverage test): the hand-written
// literal unions in quoteTypes.ts must stay in lockstep with the shared Zod enums
// the API validates against. A divergence — a status/block type added to the schema
// but not the web union, or vice versa — would let the UI silently mishandle a value
// the server accepts (missing status pill/role, unrenderable block).
//
// The `Record<Union, true>` maps make this bidirectional AND self-maintaining:
// the type annotation forces the compiler to require exactly the union's members as
// keys (missing → compile error, extra → compile error), so `Object.keys(...)` is a
// compiler-verified enumeration of the union that we then compare to the schema.

const blockTypeMembers: Record<QuoteBlockType, true> = {
  heading: true,
  rich_text: true,
  image: true,
  line_items: true,
  contract: true,
  table: true,
  callout: true,
};

const statusMembers: Record<QuoteStatus, true> = {
  draft: true,
  sent: true,
  viewed: true,
  accepted: true,
  declined: true,
  expired: true,
  converted: true,
  superseded: true,
};

const lineUpdateMembers: Record<keyof LineUpdate, true> = {
  name: true, description: true, quantity: true, unitPrice: true, taxable: true,
  customerVisible: true, recurrence: true, termMonths: true, sortOrder: true,
  unitCost: true, sku: true, partNumber: true, procurementSource: true,
  vendorSku: true, manufacturer: true, imageId: true, depositEligible: true,
  deviceRoles: true, deviceGroupId: true, siteId: true, includedQuantity: true,
  overageMode: true, overageUnitPrice: true,
};

describe('quoteTypes unions ↔ shared Zod schema parity', () => {
  it('QuoteBlockType matches quoteBlockTypeSchema.options', () => {
    expect(Object.keys(blockTypeMembers).sort()).toEqual([...quoteBlockTypeSchema.options].sort());
  });

  it('QuoteStatus matches quoteStatusSchema.options', () => {
    expect(Object.keys(statusMembers).sort()).toEqual([...quoteStatusSchema.options].sort());
  });

  it('LineUpdate keys exactly match strict updateQuoteLineSchema keys', () => {
    expect(Object.keys(lineUpdateMembers).sort()).toEqual(Object.keys(updateQuoteLineSchema.shape).sort());
    expect(lineUpdateMembers).not.toHaveProperty('contractLineType');
  });

  it('defines one English noun for every billable device role', () => {
    const nouns = (enBilling as unknown as { quotes: { deviceSet: { roleNoun: Record<string, string> } } }).quotes.deviceSet.roleNoun;
    expect(Object.keys(nouns).sort()).toEqual([...BILLABLE_DEVICE_ROLES].sort());
    expect(nouns).toEqual(DEVICE_ROLE_NOUNS);
    expect(nouns).toMatchObject({ iot: 'IoT devices', nas: 'NAS devices' });
  });
});
