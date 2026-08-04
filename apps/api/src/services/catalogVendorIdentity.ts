/**
 * Normalize the three incompatible vendor shapes stored in
 * catalog_items.attributes into one snapshot for quote_lines:
 *  - EC Express / nightly:  attributes.distributor.source ('td_synnex_*')
 *  - Digital Bridge:        attributes.distributor.provider
 *  - Pax8:                  attributes.pax8
 * Defensive on purpose: attributes is an open jsonb written by three services
 * across many releases — any unrecognized shape degrades to all-null, never throws.
 */
export interface VendorIdentity {
  procurementSource: string | null;
  vendorSku: string | null;
  manufacturer: string | null;
  mfgPartNo: string | null;
}

const EMPTY: VendorIdentity = { procurementSource: null, vendorSku: null, manufacturer: null, mfgPartNo: null };

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}
function rec(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function vendorIdentityFromAttributes(attributes: unknown): VendorIdentity {
  const attrs = rec(attributes);
  if (!attrs) return EMPTY;

  const pax8 = rec(attrs.pax8);
  if (pax8) {
    const vendorSku = str(pax8.vendorSku, 100);
    const manufacturer = str(pax8.vendorName, 255);
    if (vendorSku || manufacturer) {
      return {
        procurementSource: 'pax8',
        vendorSku,
        manufacturer,
        mfgPartNo: null,
      };
    }
  }

  const dist = rec(attrs.distributor);
  if (!dist) return EMPTY;

  if (typeof dist.provider === 'string' && dist.provider === 'td_synnex_digital_bridge') {
    const vendorSku = str(dist.sku, 100);
    const manufacturer = str(dist.vendor, 255);
    const mfgPartNo = str(dist.manufacturerPartNumber, 100);
    if (vendorSku || manufacturer || mfgPartNo) {
      return {
        procurementSource: 'td_synnex',
        vendorSku,
        manufacturer,
        mfgPartNo,
      };
    }
  }

  if (typeof dist.source === 'string' && dist.source.startsWith('td_synnex')) {
    const raw = rec(dist.raw);
    const vendorSku = str(dist.synnexSku, 100);
    const manufacturer = str(dist.manufacturer, 255) ?? (raw ? str(raw.manufacturer, 255) : null);
    const mfgPartNo = str(dist.mfgPartNo, 100);
    if (vendorSku || manufacturer || mfgPartNo) {
      return {
        procurementSource: 'td_synnex',
        vendorSku,
        manufacturer,
        mfgPartNo,
      };
    }
  }
  return EMPTY;
}
