/**
 * Parser for the TD SYNNEX nightly P&A "Flat File" (.AP), per
 * "TD SYNNEX-Flat File PA Spec Doc (For ALL Standard Accounts) Apr 2025 - v4.3".
 *
 * Format: variable-length text, `~`-delimited, POSITIONAL (no column headers).
 * One HDR record followed by N DTL records. Field IDs in the spec are 1-based;
 * the FIELD_* constants below are 0-based array indices, hence the -1 offset.
 *
 * Two field-choice traps worth calling out, because picking the neighbour
 * silently misprices every downstream quote:
 *   - Cost is field 13 (contract/grid price WITH promo+rebate), NOT field 21
 *     (unit cost WITHOUT promo). Field 21 is retained on the row as
 *     `costWithoutPromo` for margin comparison.
 *   - Availability is spread over 14 NON-CONTIGUOUS fields, and several of them
 *     mean a different warehouse in the US file vs the Canada file.
 */

/** HDR record (spec §HDR Record). 0-based indices. */
const HDR_RECORD_ID = 1;
const HDR_FILE_DATE = 2;
const HDR_FILE_QUALIFIER = 4;

/** DTL record (spec §DTL Record). 0-based indices = spec Field ID - 1. */
const DTL_RECORD_ID = 1;
const DTL_MFG_PART_NO = 2;      // 03 Manufacturer Part#
const DTL_TD_PART_NO = 3;       // 04 TD SYNNEX Part Number
const DTL_SKU = 4;              // 05 TD SYNNEX SKU # (unique key)
const DTL_STATUS = 5;           // 06 A=Added, C/S=Changed, D=Deleted/Discontinued
const DTL_NAME = 6;             // 07 Part Description
const DTL_MFG_NAME = 7;         // 08 Manufacturer Name
const DTL_TOTAL_QTY = 9;        // 10 Qty on Hand (all locations)
const DTL_CONTRACT_PRICE = 12;  // 13 Contract price WITH promo/rebate  <- cost
const DTL_MSRP = 13;            // 14 MSRP
const DTL_RETURNABLE = 16;      // 17 Returnable flag
const DTL_PARCEL_SHIPPABLE = 18;// 19 Parcel shippable flag
const DTL_UNIT_COST = 20;       // 21 Unit cost WITHOUT promo/rebate
const DTL_MEDIA_TYPE = 22;      // 23 Media type
const DTL_CATEGORY_CODE = 24;   // 25 TD SYNNEX category code
const DTL_WEIGHT = 27;          // 28 Ship weight
const DTL_SERIALIZED = 28;      // 29 Serialized flag
const DTL_MAP_PRICE = 30;       // 31 MAP (min advertised price)
const DTL_COO_LIST = 31;        // 32 Country-of-origin list
const DTL_HC_PRICE = 32;        // 33 Healthcare price
const DTL_UPC = 33;             // 34 UPC
const DTL_UNSPSC = 34;          // 35 UNSPSC
const DTL_SKU_CREATED = 36;     // 37 SKU created date
const DTL_SKU_ATTRIBUTES = 37;  // 38 Drop-ship / refurb / UPC-avail flags
const DTL_ETA_DATE = 38;        // 39 Backorder ETA
const DTL_ABC_CODE = 39;        // 40 A=Active B=Special order C=EOL T=To be discontinued
const DTL_KIT_FLAG = 40;        // 41 K=Kit S=Standalone
const DTL_STATE_GOV_PRICE = 41; // 42
const DTL_FED_GOV_PRICE = 42;   // 43
const DTL_EDU_PRICE = 43;       // 44
const DTL_TAA_FLAG = 44;        // 45
const DTL_GSA_PRICE = 45;       // 46
const DTL_PROMO_FLAG = 46;      // 47
const DTL_PROMO_COMMENT = 47;   // 48
const DTL_PROMO_EXPIRES = 48;   // 49
const DTL_LONG_DESC_1 = 49;     // 50 Long description, 80-char chunks 1..3
const DTL_LONG_DESC_2 = 50;     // 51
const DTL_LONG_DESC_3 = 51;     // 52
const DTL_LENGTH = 52;          // 53
const DTL_WIDTH = 53;           // 54
const DTL_HEIGHT = 54;          // 55
const DTL_GSA_NTE_PRICE = 56;   // 57
const DTL_PLATFORM_TYPE = 57;   // 58
const DTL_DESC_FR = 58;         // 59
const DTL_STREET_DATE = 59;     // 60
const DTL_REPLACEMENT_SKU = 64; // 65
const DTL_MIN_ORDER_QTY = 65;   // 66
const DTL_PURCHASING_REQS = 66; // 67
const DTL_GOV_CLASS = 67;       // 68
const DTL_MFG_DROP_SHIP_QTY = 69; // 70

/**
 * Lowest DTL field count we accept. The spec defines 70 fields (71-100 are
 * reserved and may or may not be emitted). A row with fewer than this is
 * structurally wrong, not merely sparse.
 */
const MIN_DTL_FIELDS = 70;

/**
 * Fraction of malformed DTL rows above which we reject the whole file rather
 * than quietly importing a partial catalog. A handful of bad rows in a 200k-row
 * file is tolerable; a systematic layout change is not, and must not present as
 * a "successful" sync with missing products.
 */
const MAX_MALFORMED_RATIO = 0.01;

export type TdSynnexRegion = 'US' | 'CA';

/** Warehouse qty fields. Non-contiguous by design — see spec §DTL Record. */
interface WarehouseField {
  index: number;
  us?: { code: string; loc: string; city: string; state: string };
  ca?: { code: string; loc: string; city: string; state: string };
}

const WAREHOUSE_FIELDS: WarehouseField[] = [
  { index: 14, us: { code: 'DFL', loc: '16', city: 'Miami', state: 'FL' } },
  { index: 15, us: { code: 'DFR', loc: '3', city: 'Tracy', state: 'CA' },
               ca: { code: 'DHA', loc: '26', city: 'Dartmouth', state: 'NS' } },
  { index: 19, ca: { code: 'DCG', loc: '31', city: 'Calgary', state: 'AB' } },
  { index: 21, us: { code: 'DCH', loc: '6', city: 'Romeoville', state: 'IL' },
               ca: { code: 'DGU', loc: '29', city: 'Guelph', state: 'ON' } },
  { index: 23, us: { code: 'DTN', loc: '7', city: 'Southaven', state: 'MS' } },
  { index: 29, us: { code: 'DCO', loc: '50', city: 'Columbus', state: 'OH' } },
  { index: 55, us: { code: 'DGA', loc: '502', city: 'Suwanee', state: 'GA' } },
  { index: 60, us: { code: 'DON', loc: '12', city: 'Chino', state: 'CA' },
               ca: { code: 'DMS', loc: '80', city: 'Mississauga', state: 'ON' } },
  { index: 61, us: { code: 'DSW', loc: '503', city: 'Swedesboro', state: 'NJ' },
               ca: { code: 'DRN', loc: '81', city: 'Richmond', state: 'BC' } },
  { index: 62, us: { code: 'DIN', loc: '504', city: 'South Bend', state: 'IN' } },
  { index: 63, us: { code: 'DFW', loc: '505', city: 'Ft. Worth', state: 'TX' } },
  { index: 68, us: { code: 'DFO', loc: '506', city: 'Fontana', state: 'CA' } },
];

export interface TdSynnexWarehouseStock {
  code: string;
  loc: string;
  city: string;
  state: string;
  available: number;
}

export interface TdSynnexPriceRow {
  synnexSku: string;
  mfgPartNo: string | null;
  tdPartNo: string | null;
  name: string | null;
  description: string | null;
  manufacturer: string | null;
  /** Spec field 06: A=Added, C/S=Changed, D=Deleted/Discontinued. */
  status: string | null;
  /** Spec field 40: A=Active, B=Special order, C=EOL, T=To be discontinued. */
  abcCode: string | null;
  currency: string;
  /** Field 13 — contract/grid price WITH promo & rebate. The number to quote from. */
  cost: number | null;
  /** Field 21 — unit cost WITHOUT promo/rebate. */
  costWithoutPromo: number | null;
  msrp: number | null;
  mapPrice: number | null;
  totalQty: number | null;
  warehouses: TdSynnexWarehouseStock[];
  weight: number | null;
  upc: string | null;
  unspsc: string | null;
  etaDate: string | null;
  raw: Record<string, unknown>;
}

export interface TdSynnexPriceFileHeader {
  tradingPartnerCode: string | null;
  /** ISO date derived from the YYMMDD file-creation date. */
  fileDate: string | null;
  /** 'C' = full file (authoritative snapshot), 'U' = delta (changed SKUs only). */
  fileQualifier: 'C' | 'U';
  isFullFile: boolean;
}

export interface TdSynnexPriceFileResult {
  header: TdSynnexPriceFileHeader;
  rows: TdSynnexPriceRow[];
  /** Rows skipped as structurally malformed, with a reason. Never silent. */
  malformed: Array<{ line: number; reason: string }>;
}

export class TdSynnexPriceFileError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'TdSynnexPriceFileError';
    this.code = code;
  }
}

function field(parts: string[], index: number): string | null {
  const v = parts[index];
  if (v === undefined) return null;
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The spec's data-example column writes absent optional values as the literal
 * "NULL". Real files use an empty field, but accept both so a "NULL" never
 * lands in the DB as the string it isn't.
 */
function isNullish(v: string | null): boolean {
  return v === null || v.toUpperCase() === 'NULL';
}

function num(parts: string[], index: number): number | null {
  const v = field(parts, index);
  if (isNullish(v)) return null;
  const parsed = Number(v!.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function int(parts: string[], index: number): number | null {
  const v = num(parts, index);
  return v === null ? null : Math.trunc(v);
}

function text(parts: string[], index: number): string | null {
  const v = field(parts, index);
  return isNullish(v) ? null : v;
}

/**
 * TD SYNNEX dates are YYMMDD (some optional fields are documented as 8 chars,
 * so YYYYMMDD is accepted too). Two-digit years pivot at 70: 69->2069, 70->1970.
 */
function parseDate(parts: string[], index: number): string | null {
  const v = field(parts, index);
  if (isNullish(v)) return null;
  const digits = v!.replace(/\D/g, '');
  let yyyy: number, mm: number, dd: number;
  if (digits.length === 6) {
    const yy = Number(digits.slice(0, 2));
    yyyy = yy < 70 ? 2000 + yy : 1900 + yy;
    mm = Number(digits.slice(2, 4));
    dd = Number(digits.slice(4, 6));
  } else if (digits.length === 8) {
    yyyy = Number(digits.slice(0, 4));
    mm = Number(digits.slice(4, 6));
    dd = Number(digits.slice(6, 8));
  } else {
    return null;
  }
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/** Long description arrives as three 80-char chunks that must be re-joined. */
function joinLongDescription(parts: string[]): string | null {
  const chunks = [DTL_LONG_DESC_1, DTL_LONG_DESC_2, DTL_LONG_DESC_3]
    .map((i) => parts[i] ?? '')
    .join('')
    .trim();
  return chunks.length > 0 ? chunks : null;
}

function readWarehouses(parts: string[], region: TdSynnexRegion): TdSynnexWarehouseStock[] {
  const out: TdSynnexWarehouseStock[] = [];
  for (const wf of WAREHOUSE_FIELDS) {
    const meta = region === 'CA' ? wf.ca : wf.us;
    if (!meta) continue; // field carries no warehouse for this region
    const available = int(parts, wf.index);
    if (available === null) continue;
    out.push({ ...meta, available });
  }
  return out;
}

function parseDtl(parts: string[], region: TdSynnexRegion): TdSynnexPriceRow {
  const synnexSku = text(parts, DTL_SKU);
  if (!synnexSku) {
    throw new TdSynnexPriceFileError('DTL row has no TD SYNNEX SKU (field 05)', 'TDS_PA_ROW_NO_SKU');
  }

  return {
    synnexSku,
    mfgPartNo: text(parts, DTL_MFG_PART_NO),
    tdPartNo: text(parts, DTL_TD_PART_NO),
    name: text(parts, DTL_NAME),
    description: joinLongDescription(parts) ?? text(parts, DTL_NAME),
    manufacturer: text(parts, DTL_MFG_NAME),
    status: text(parts, DTL_STATUS),
    abcCode: text(parts, DTL_ABC_CODE),
    currency: region === 'CA' ? 'CAD' : 'USD',
    cost: num(parts, DTL_CONTRACT_PRICE),
    costWithoutPromo: num(parts, DTL_UNIT_COST),
    msrp: num(parts, DTL_MSRP),
    mapPrice: num(parts, DTL_MAP_PRICE),
    totalQty: int(parts, DTL_TOTAL_QTY),
    warehouses: readWarehouses(parts, region),
    weight: num(parts, DTL_WEIGHT),
    upc: text(parts, DTL_UPC),
    unspsc: text(parts, DTL_UNSPSC),
    etaDate: parseDate(parts, DTL_ETA_DATE),
    raw: {
      categoryCode: text(parts, DTL_CATEGORY_CODE),
      mediaType: text(parts, DTL_MEDIA_TYPE),
      returnable: text(parts, DTL_RETURNABLE),
      parcelShippable: text(parts, DTL_PARCEL_SHIPPABLE),
      serialized: text(parts, DTL_SERIALIZED),
      kitFlag: text(parts, DTL_KIT_FLAG),
      taaFlag: text(parts, DTL_TAA_FLAG),
      cooList: text(parts, DTL_COO_LIST),
      skuAttributes: text(parts, DTL_SKU_ATTRIBUTES),
      purchasingRequirements: text(parts, DTL_PURCHASING_REQS),
      govClass: text(parts, DTL_GOV_CLASS),
      platformType: text(parts, DTL_PLATFORM_TYPE),
      descriptionFr: text(parts, DTL_DESC_FR),
      skuCreatedDate: parseDate(parts, DTL_SKU_CREATED),
      streetDate: parseDate(parts, DTL_STREET_DATE),
      replacementSku: text(parts, DTL_REPLACEMENT_SKU),
      minOrderQty: int(parts, DTL_MIN_ORDER_QTY),
      mfgDropShipQty: int(parts, DTL_MFG_DROP_SHIP_QTY),
      dimensions: {
        length: num(parts, DTL_LENGTH),
        width: num(parts, DTL_WIDTH),
        height: num(parts, DTL_HEIGHT),
      },
      pricing: {
        hc: num(parts, DTL_HC_PRICE),
        stateGov: num(parts, DTL_STATE_GOV_PRICE),
        fedGov: num(parts, DTL_FED_GOV_PRICE),
        education: num(parts, DTL_EDU_PRICE),
        gsa: num(parts, DTL_GSA_PRICE),
        gsaNte: num(parts, DTL_GSA_NTE_PRICE),
      },
      promotion: {
        flag: text(parts, DTL_PROMO_FLAG),
        comment: text(parts, DTL_PROMO_COMMENT),
        expiresAt: parseDate(parts, DTL_PROMO_EXPIRES),
      },
    },
  };
}

/**
 * Parse a decoded .AP flat file. Throws rather than returning a partial catalog
 * when the file has no HDR, no usable DTL rows, or a malformed-row ratio above
 * MAX_MALFORMED_RATIO — a layout change must fail the sync loudly, not import
 * a silently-truncated price list.
 */
export function parsePriceFile(
  content: string,
  opts: { region?: TdSynnexRegion } = {}
): TdSynnexPriceFileResult {
  const region = opts.region ?? 'US';
  const lines = content.split(/\r?\n/);

  let header: TdSynnexPriceFileHeader | null = null;
  const rows: TdSynnexPriceRow[] = [];
  const malformed: Array<{ line: number; reason: string }> = [];
  let dtlSeen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.trim().length === 0) continue;

    const parts = line.split('~');
    const recordType = (parts[HDR_RECORD_ID] ?? '').trim().toUpperCase();

    if (recordType === 'HDR') {
      if (header) continue; // trailing/duplicate HDR — first one wins
      const qualifier = (field(parts, HDR_FILE_QUALIFIER) ?? 'C').toUpperCase();
      if (qualifier !== 'C' && qualifier !== 'U') {
        throw new TdSynnexPriceFileError(
          `HDR file qualifier (field 05) is "${qualifier}", expected "C" (full) or "U" (delta)`,
          'TDS_PA_BAD_QUALIFIER'
        );
      }
      header = {
        tradingPartnerCode: text(parts, 0),
        fileDate: parseDate(parts, HDR_FILE_DATE),
        fileQualifier: qualifier,
        isFullFile: qualifier === 'C',
      };
      continue;
    }

    if (recordType !== 'DTL') continue; // unknown record type — ignore, not an error

    dtlSeen++;
    if (parts.length < MIN_DTL_FIELDS) {
      malformed.push({
        line: i + 1,
        reason: `expected at least ${MIN_DTL_FIELDS} fields, got ${parts.length}`,
      });
      continue;
    }
    try {
      rows.push(parseDtl(parts, region));
    } catch (err) {
      malformed.push({
        line: i + 1,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!header) {
    throw new TdSynnexPriceFileError(
      'No HDR record found — file is not a TD SYNNEX P&A flat file',
      'TDS_PA_NO_HEADER'
    );
  }
  if (dtlSeen === 0) {
    throw new TdSynnexPriceFileError('File contains no DTL records', 'TDS_PA_NO_ROWS');
  }
  if (malformed.length / dtlSeen > MAX_MALFORMED_RATIO) {
    const sample = malformed.slice(0, 3).map((m) => `line ${m.line}: ${m.reason}`).join('; ');
    throw new TdSynnexPriceFileError(
      `${malformed.length} of ${dtlSeen} DTL rows are malformed (>${MAX_MALFORMED_RATIO * 100}%) — ` +
        `the file layout may have changed. Samples: ${sample}`,
      'TDS_PA_LAYOUT_CHANGED'
    );
  }

  return { header, rows, malformed };
}
