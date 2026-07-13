import { describe, it, expect } from 'vitest';
import { parsePriceFile, TdSynnexPriceFileError } from './tdSynnexPriceFile';

/**
 * Verbatim sample from the TD SYNNEX spec/quick-guide ("Example - P&A Flat File
 * (HDR / DTL)"). Every positional assertion below is anchored to this record, so
 * an off-by-one in the field map fails loudly rather than silently mispricing.
 */
const SAMPLE_HDR = 'SAMPLE846~HDR~190227~190227~C~~~~~';
const SAMPLE_DTL = [
  'SAMPLE846~DTL~C8061ARPC~PCI-C8061ARPC~2558723~A~PCI REMAN ALT. FOR HP 61A C8061A BLACK TONER',
  ' CARTRIDGE 6K YIELD FOR THE HP LASER~PCI~34189~120~0~0~36.62~62.76~0~0~Y~0~Y~0~36.62~0~ ~0~0090',
  '88334~0~2260~4.15~N~0~~US~35.02~845161022245~44103103~COMPHP~091029~NNY~~A~S~35.02~34.06~35.02',
  '~Y~~N~~~PCI REMAN ALT. FOR HP 61A C8061A BLACK TONER CARTRIDGE 6K YIELD FOR THE HP LASER~JET 4',
  '100, 4100MFP, 4100DTN, 4100N, 4100TN, 4101, 4101MFP, V7 C8061, 200021P, PRL~61A, C8061X, 61X T',
  'HIS REMANUFACTURED CARTRIDGE IS TAA COMPLIANT, PCI QUALITY MAD~15.30~6.60~9.50~0~~~~~0~0~0~0~~',
  '~~US         N~0~120',
].join('');

const SAMPLE_FILE = `${SAMPLE_HDR}\n${SAMPLE_DTL}\n`;

describe('parsePriceFile — TD SYNNEX spec sample', () => {
  it('parses the HDR record', () => {
    const { header } = parsePriceFile(SAMPLE_FILE);
    expect(header.tradingPartnerCode).toBe('SAMPLE846');
    expect(header.fileDate).toBe('2019-02-27');
    expect(header.fileQualifier).toBe('C');
    expect(header.isFullFile).toBe(true);
  });

  it('maps the DTL identity fields to the right positions', () => {
    const { rows } = parsePriceFile(SAMPLE_FILE);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.synnexSku).toBe('2558723');       // field 05
    expect(r.mfgPartNo).toBe('C8061ARPC');     // field 03
    expect(r.tdPartNo).toBe('PCI-C8061ARPC');  // field 04
    expect(r.status).toBe('A');                // field 06
    expect(r.manufacturer).toBe('PCI');        // field 08
    expect(r.abcCode).toBe('A');               // field 40
    expect(r.upc).toBe('845161022245');        // field 34
    expect(r.unspsc).toBe('44103103');         // field 35
  });

  it('takes cost from field 13 (WITH promo), not field 21', () => {
    const { rows } = parsePriceFile(SAMPLE_FILE);
    const r = rows[0]!;
    expect(r.cost).toBe(36.62);             // field 13 — contract price
    expect(r.costWithoutPromo).toBe(36.62); // field 21
    expect(r.msrp).toBe(62.76);             // field 14
    expect(r.weight).toBe(4.15);            // field 28
    expect(r.currency).toBe('USD');
  });

  it('reads total qty and the non-contiguous warehouse fields', () => {
    const { rows } = parsePriceFile(SAMPLE_FILE);
    const r = rows[0]!;
    expect(r.totalQty).toBe(120); // field 10

    // US region: 12 warehouse fields carry a US DC. All zero in this sample.
    const codes = r.warehouses.map((w) => w.code);
    expect(codes).toEqual(['DFL', 'DFR', 'DCH', 'DTN', 'DCO', 'DGA', 'DON', 'DSW', 'DIN', 'DFW', 'DFO']);
    expect(r.warehouses.every((w) => w.available === 0)).toBe(true);
    // Calgary (field 20) is Canada-only and must not appear in a US parse.
    expect(codes).not.toContain('DCG');
  });

  it('rejoins the three 80-char long-description chunks', () => {
    const { rows } = parsePriceFile(SAMPLE_FILE);
    const d = rows[0]!.description!;
    expect(d.startsWith('PCI REMAN ALT. FOR HP 61A')).toBe(true);
    expect(d).toContain('JET 4100, 4100MFP');       // chunk 2 joined
    expect(d).toContain('TAA COMPLIANT');            // chunk 3 joined
  });

  it('captures secondary pricing and gov class in raw', () => {
    const { rows } = parsePriceFile(SAMPLE_FILE);
    const raw = rows[0]!.raw as Record<string, any>;
    expect(raw.pricing.hc).toBe(35.02);        // field 33
    expect(raw.pricing.stateGov).toBe(35.02);  // field 42
    expect(raw.pricing.fedGov).toBe(34.06);    // field 43
    expect(raw.pricing.education).toBe(35.02); // field 44
    expect(raw.govClass).toBe('US         N'.trim()); // field 68
    expect(raw.mfgDropShipQty).toBe(120);      // field 70
    expect(raw.skuCreatedDate).toBe('2009-10-29'); // field 37, YYMMDD pivot
    expect(raw.taaFlag).toBe('Y');             // field 45
    expect(raw.dimensions).toEqual({ length: 15.3, width: 6.6, height: 9.5 });
  });
});

describe('parsePriceFile — region handling', () => {
  it('maps Canada-only warehouses and CAD currency', () => {
    const { rows } = parsePriceFile(SAMPLE_FILE, { region: 'CA' });
    const r = rows[0]!;
    expect(r.currency).toBe('CAD');
    const codes = r.warehouses.map((w) => w.code);
    expect(codes).toContain('DCG'); // field 20 = Calgary in the CA file
    expect(codes).toContain('DHA'); // field 16 = Dartmouth, not Tracy
    expect(codes).not.toContain('DFL'); // Miami is US-only
  });
});

describe('parsePriceFile — failure modes', () => {
  it('flags a delta file via the HDR qualifier', () => {
    const { header } = parsePriceFile(SAMPLE_FILE.replace('~190227~C~', '~190227~U~'));
    expect(header.fileQualifier).toBe('U');
    expect(header.isFullFile).toBe(false);
  });

  it('throws when there is no HDR record', () => {
    expect(() => parsePriceFile(SAMPLE_DTL)).toThrow(TdSynnexPriceFileError);
    expect(() => parsePriceFile(SAMPLE_DTL)).toThrow(/No HDR record/);
  });

  it('throws when the file has no DTL rows', () => {
    expect(() => parsePriceFile(SAMPLE_HDR)).toThrow(/no DTL records/);
  });

  it('throws on an unknown file qualifier rather than assuming full', () => {
    expect(() => parsePriceFile(SAMPLE_FILE.replace('~190227~C~', '~190227~X~')))
      .toThrow(/expected "C" \(full\) or "U" \(delta\)/);
  });

  it('throws on a missing/blank file qualifier rather than assuming full (fail closed — a blank must NOT prune)', () => {
    // A blank qualifier column must never coalesce to 'C'; that would flag the
    // file as a full snapshot and prune the catalog. It must fail loudly instead.
    expect(() => parsePriceFile(SAMPLE_FILE.replace('~190227~C~', '~190227~~')))
      .toThrow(/qualifier \(field 05\) is "\(missing\)"/);
  });

  it('rejects the file when too many DTL rows are malformed', () => {
    // One good row, two truncated rows => 66% malformed, over the 1% ceiling.
    const truncated = 'SAMPLE846~DTL~ABC~DEF~123~A~name';
    const file = `${SAMPLE_HDR}\n${SAMPLE_DTL}\n${truncated}\n${truncated}\n`;
    expect(() => parsePriceFile(file)).toThrow(/layout may have changed/);
  });

  it('tolerates a rare malformed row without failing the file', () => {
    // 1 bad row in 200 is under the ceiling: keep the good rows, report the bad.
    const good = Array.from({ length: 200 }, (_, i) =>
      SAMPLE_DTL.replace('~2558723~', `~${1000000 + i}~`)
    ).join('\n');
    const file = `${SAMPLE_HDR}\n${good}\nSAMPLE846~DTL~short\n`;
    const res = parsePriceFile(file);
    expect(res.rows).toHaveLength(200);
    expect(res.malformed).toHaveLength(1);
    expect(res.malformed[0]!.reason).toMatch(/expected at least 70 fields/);
  });

  it('treats the literal "NULL" placeholder as absent, not as a string', () => {
    const withNulls = SAMPLE_DTL.replace('~62.76~', '~NULL~'); // MSRP
    const { rows } = parsePriceFile(`${SAMPLE_HDR}\n${withNulls}\n`);
    expect(rows[0]!.msrp).toBeNull();
  });
});
