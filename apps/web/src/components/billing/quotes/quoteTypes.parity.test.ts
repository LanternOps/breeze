import { describe, expect, it } from 'vitest';
import { quoteBlockTypeSchema, quoteStatusSchema } from '@breeze/shared';
import type { QuoteBlockType, QuoteStatus } from './quoteTypes';

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
};

const statusMembers: Record<QuoteStatus, true> = {
  draft: true,
  sent: true,
  viewed: true,
  accepted: true,
  declined: true,
  expired: true,
  converted: true,
};

describe('quoteTypes unions ↔ shared Zod schema parity', () => {
  it('QuoteBlockType matches quoteBlockTypeSchema.options', () => {
    expect(Object.keys(blockTypeMembers).sort()).toEqual([...quoteBlockTypeSchema.options].sort());
  });

  it('QuoteStatus matches quoteStatusSchema.options', () => {
    expect(Object.keys(statusMembers).sort()).toEqual([...quoteStatusSchema.options].sort());
  });
});
