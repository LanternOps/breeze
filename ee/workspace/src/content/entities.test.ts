import { describe, it, expect } from 'vitest';
import { extractEntities, normalizeQueryEntities } from './entities';

const byType = (text: string) => {
  const out: Record<string, string[]> = {};
  for (const e of extractEntities(text)) (out[e.type] ??= []).push(e.valueNorm);
  return out;
};

describe('extractEntities — structured regex pass', () => {
  it('finds APNs with and without the APN prefix', () => {
    const t = 'parcel APN 057-071-012 adjoins 057-071-013 per the record.';
    expect(byType(t).apn).toEqual(['057-071-012', '057-071-013']);
  });

  it('normalizes PO variants to one canonical form', () => {
    for (const variant of ['PO 4021', 'PO #4021', 'PO#4021', 'P.O. 4021', 'po 4021']) {
      expect(byType(variant).po, variant).toEqual(['PO 4021']);
    }
  });

  it('does NOT treat a P.O. Box as a purchase order', () => {
    expect(byType('mail to P.O. Box 4021, Fairoaks CA').po).toBeUndefined();
  });

  it('extracts WDR and permit-style agency references', () => {
    const t = 'per WDR-2023-0117 and fish passage ref FP-26-1142.';
    expect(byType(t).wdr).toEqual(['WDR-2023-0117']);
    expect(byType(t).permit).toEqual(['FP-26-1142']);
  });

  it('extracts invoice numbers with prefixes intact', () => {
    const t = 'see invoice 8841 and Invoice #23-1088; also inv 92-311.';
    expect(byType(t).invoice).toEqual(['INV 8841', 'INV 23-1088', 'INV 92-311']);
  });

  it('classifies surveyor license numbers as license, never invoice (LS 8841 trap)', () => {
    const t = 'signed L.S. 4102 (Deubel); stamp LS 8841 appears on the mylar.';
    const r = byType(t);
    expect(r.license).toEqual(['LS 4102', 'LS 8841']);
    expect(r.invoice).toBeUndefined();
  });

  it('extracts job/project numbers, bare and prefixed', () => {
    const t = 'Job 87-143 retracement; carried into 2020-088 and project no. 2023-041.';
    const r = byType(t);
    expect(r.job).toEqual(expect.arrayContaining(['87-143', '2020-088', '2023-041']));
  });

  it('does not read an APN as a job number', () => {
    const r = byType('APN 057-071-012');
    expect(r.job ?? []).not.toContain('057-071');
  });

  it('dedupes repeated mentions within one document', () => {
    const t = 'PO 4021 ... again PO #4021 ... same order.';
    expect(byType(t).po).toEqual(['PO 4021']);
  });

  it('never matches glued tokens (part/lot-number shapes)', () => {
    expect(byType('unit PO4021 on the packing slip').po).toBeUndefined();
    expect(byType('ref inv92311 stamped').invoice).toBeUndefined();
    expect(byType('mylar LS8841 margin note').license).toBeUndefined();
  });
});

describe('normalizeQueryEntities — query-side detection', () => {
  it('uses the same normalizer as ingest', () => {
    const q = normalizeQueryEntities('anything about PO#4021 or 057-071-012?');
    expect(q).toEqual(expect.arrayContaining([
      { type: 'po', valueNorm: 'PO 4021' },
      { type: 'apn', valueNorm: '057-071-012' },
    ]));
  });
  it('returns empty for prose-only queries', () => {
    expect(normalizeQueryEntities('the Quail Hollow parcel')).toEqual([]);
  });
});
