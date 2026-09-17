/**
 * Read-time asset identity guards (spec §9, decision D6).
 *
 * W01 ships ONLY the read-time pieces: the mask that stops a raw sysObjectID
 * rendering as a model, and the NIC-vendor derivation. W03 adds
 * `resolveAssetIdentity()` (ingest-side enterprise-number resolution and the
 * vendor model extractors) to this same module — so the read guard protects
 * every row already in the database, including the ones W03 will never re-scan.
 *
 * WHY A MASK AND NOT A BACKFILL: agent/internal/discovery/classify.go:45 writes
 * `model = sysObjectID` whenever nothing better is known, and old agents will
 * keep doing that until they update. A one-off UPDATE would fix today's rows
 * and be re-broken by tomorrow's scan.
 */

import { lookupMacVendor } from './macVendorLookup';

/**
 * A dotted-decimal OID rooted at 1 (iso). Anchored at BOTH ends and requiring
 * at least two components, so real model numbers that merely contain digits and
 * dots ("HL-L2350DW", "ET-2.5G", "UAP-AC-PRO") never match. `2.4.1` does not
 * match either: SNMP object identifiers in this position are always iso-rooted.
 */
export const OID_SHAPED_MODEL = /^\.?1(\.\d+)+$/;

/**
 * Null out a `model` that is really a sysObjectID. The raw value is still
 * available to the UI as `snmpData.sysObjectId`, which is where an operator
 * looking for it expects to find it (the "All scan details" disclosure, §11).
 */
export function maskOidShapedModel(model: string | null): string | null {
  if (!model) return null;
  return OID_SHAPED_MODEL.test(model.trim()) ? null : model;
}

/**
 * The OUI vendor of the asset's MAC, exposed SEPARATELY from `manufacturer`.
 *
 * These are different facts and conflating them is F5: a Xerox C325 has a
 * Lexmark-built engine, so its OUI says LEXMARK while the device is a Xerox.
 * The UI shows this only when it differs from `manufacturer` (§11).
 */
export function nicVendorFromMac(mac: string | null): string | null {
  return lookupMacVendor(mac);
}

import { GENERIC_AGENT_ENTERPRISE_NUMBERS, enterpriseNumberFromSysObjectId, vendorFromSysObjectId } from './ianaEnterprise';

export type ManufacturerSource = 'enterprise_oid' | 'sysdescr' | 'scan' | 'mac_oui';
export type ModelSource = 'vendor_extractor' | 'snmp_name' | 'scan';

export interface AssetIdentityInput {
  sysObjectId?: string | null;
  sysDescr?: string | null;
  /** The full polled scalar bag (sysDescr/sysObjectId/sysName today, printer scalars once W02 walks). */
  snmpData?: Record<string, unknown> | null;
  /** NIC OUI vendor, already looked up by the caller. */
  macVendor?: string | null;
  /** What the scan itself proposed. Fills gaps; never outranks the arc or the sysDescr rules. */
  current?: { manufacturer?: string | null; model?: string | null } | null;
}

export interface ResolvedAssetIdentity {
  manufacturer: string | null;
  manufacturerSource: ManufacturerSource | null;
  model: string | null;
  modelSource: ModelSource | null;
}

/** discovered_assets.model is varchar(255); keep well under it and keep it readable. */
const MAX_MODEL_LENGTH = 120;

/**
 * sysDescr → manufacturer, ordered, most specific first.
 *
 * Ported from `agent/internal/discovery/classify.go` so old and new agents get
 * the same answer (spec §9: "the server rule is the source of truth"). ONE
 * deliberate divergence: classify.go uses `strings.Contains(sysDescr, "hp")`,
 * which reads "Sharp" as HP. `\bhp\b` does not. Everything else reproduces the
 * agent's verdicts exactly, pinned by assetIdentity.test.ts.
 */
const SYSDESCR_VENDOR_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bxerox\b/i, 'Xerox'],
  [/\blexmark\b/i, 'Lexmark'],
  [/\bbrother\b/i, 'Brother'],
  [/\bkonica\b/i, 'Konica Minolta'],
  [/\bkyocera\b/i, 'Kyocera'],
  [/\bricoh\b/i, 'Ricoh'],
  [/\bsharp\b/i, 'Sharp'],
  [/\bcanon\b/i, 'Canon'],
  [/\bepson\b/i, 'Epson'],
  [/\bzebra\b/i, 'Zebra'],
  [/\bcisco\b/i, 'Cisco'],
  [/\bmeraki\b/i, 'Meraki'],
  [/\b(?:fortinet|fortigate|fortiswitch|fortiap)\b/i, 'Fortinet'],
  [/\bsonicwall\b/i, 'SonicWall'],
  [/\bmikrotik\b/i, 'MikroTik'],
  [/\bsynology\b/i, 'Synology'],
  [/\bqnap\b/i, 'QNAP'],
  [/\b(?:ubiquiti|unifi|edgeswitch|edgerouter)\b/i, 'Ubiquiti'],
  [/\b(?:ruckus|commscope)\b/i, 'Ruckus'],
  [/\bjuniper\b/i, 'Juniper'],
  [/\bnetgear\b/i, 'Netgear'],
  [/\btp-?link\b/i, 'TP-Link'],
  [/\b(?:aruba|procurve)\b/i, 'Aruba'],
  [/\bsupermicro\b/i, 'Supermicro'],
  [/\blenovo\b/i, 'Lenovo'],
  [/\bvmware\b/i, 'VMware'],
  [/\b(?:apc|american power conversion)\b/i, 'APC'],
  [/\bcyberpower\b/i, 'CyberPower'],
  [/\beaton\b/i, 'Eaton'],
  [/\bdell\b/i, 'Dell'],
  [/\bhewlett[- ]packard\b/i, 'HP'],
  [/\b(?:laserjet|officejet|designjet|pagewide|proliant)\b/i, 'HP'],
  [/\bhpe?\b/i, 'HP'],
];

function manufacturerFromSysDescr(sysDescr: string): string | null {
  for (const [pattern, vendor] of SYSDESCR_VENDOR_RULES) {
    if (pattern.test(sysDescr)) return vendor;
  }
  return null;
}

function tidyModel(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_MODEL_LENGTH).trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** Xerox / Lexmark: the identity phrase that precedes the firmware blurb. */
function vendorPrefixSegment(sysDescr: string): string | null {
  const semicolon = sysDescr.indexOf(';');
  let segment = semicolon >= 0 ? sysDescr.slice(0, semicolon) : sysDescr;
  segment = segment.split(/\s+(?:version|kernel|firmware)\b/i)[0] ?? segment;
  segment = segment.split(',')[0] ?? segment;
  return tidyModel(segment);
}

function matchToken(sysDescr: string, pattern: RegExp): string | null {
  return tidyModel(pattern.exec(sysDescr)?.[1] ?? null);
}

/**
 * Tested extractors only (spec §9 / quorum D6): a universal "split on the first
 * semicolon" mis-parses most vendors, so each family gets a rule that was
 * checked against a real sysDescr, and everything else falls through to the
 * polled printer name or to null. The raw sysObjectID is NEVER a model.
 */
const MODEL_EXTRACTORS: ReadonlyArray<{
  vendors: ReadonlySet<string>;
  extract: (sysDescr: string) => string | null;
}> = [
  { vendors: new Set(['Xerox', 'Lexmark']), extract: vendorPrefixSegment },
  {
    vendors: new Set(['Brother']),
    extract: (d) => matchToken(d, /\b((?:MFC|HL|DCP|ADS|PT|QL|TD)-[A-Za-z0-9]+)\b/),
  },
  {
    vendors: new Set(['HP', 'HPE']),
    extract: (d) => matchToken(d, /\b(HP\s+(?:Color\s+)?(?:LaserJet|OfficeJet|Officejet|PageWide|DesignJet)[^,;]*)/i),
  },
  {
    vendors: new Set(['Cisco']),
    extract: (d) => matchToken(d, /\b((?:WS-C|CBS|ISR|ASR|IE|C)\d[A-Za-z0-9-]*)\b/),
  },
];

/** Printer/host scalars a poll may have captured; used when no extractor fires. */
const SNMP_MODEL_KEYS = ['prtGeneralPrinterName', 'hrDeviceDescr'] as const;

function modelFromSnmpData(snmpData: Record<string, unknown> | null | undefined): string | null {
  if (!snmpData) return null;
  for (const key of SNMP_MODEL_KEYS) {
    const value = snmpData[key];
    if (typeof value === 'string') {
      const tidied = tidyModel(value);
      if (tidied) return tidied;
    }
  }
  return null;
}

/**
 * Resolve manufacturer and model server-side at scan ingest (spec §9, D6).
 *
 * Manufacturer: IANA enterprise arc (the only ASSIGNED signal) → sysDescr
 * keyword rules → what the agent proposed → the NIC OUI vendor. The OUI is last
 * because it names whoever built the NIC, not the box: a Xerox C325 has a
 * Lexmark OUI (F5). Generic-agent PENs (net-snmp) are skipped entirely.
 *
 * Model: vendor-family extractor → a polled printer/device name → the scan's own
 * value → null. Every path is masked by maskOidShapedModel, so a sysObjectID can
 * never reach the column no matter which branch produced it.
 *
 * MANUAL PRECEDENCE IS NOT THIS FUNCTION'S JOB. `buildScanUpdateSet`
 * (jobs/discoveryWorker.ts) already wraps manufacturer/model in a
 * `case when source = 'manual' then <stored> else <proposed> end` guard
 * evaluated by Postgres against the stored row. Do not add a JS-side check here
 * — that is the #3011 race all over again.
 */
export function resolveAssetIdentity(input: AssetIdentityInput): ResolvedAssetIdentity {
  const sysDescr = typeof input.sysDescr === 'string' ? input.sysDescr : null;
  const scanManufacturer = input.current?.manufacturer?.trim() || null;

  let manufacturer: string | null = null;
  let manufacturerSource: ManufacturerSource | null = null;

  const pen = enterpriseNumberFromSysObjectId(input.sysObjectId);
  if (pen !== null && !GENERIC_AGENT_ENTERPRISE_NUMBERS.has(pen)) {
    const vendor = vendorFromSysObjectId(input.sysObjectId);
    if (vendor) {
      manufacturer = vendor;
      manufacturerSource = 'enterprise_oid';
    }
  }
  if (!manufacturer && sysDescr) {
    const vendor = manufacturerFromSysDescr(sysDescr);
    if (vendor) {
      manufacturer = vendor;
      manufacturerSource = 'sysdescr';
    }
  }
  if (!manufacturer && scanManufacturer) {
    manufacturer = scanManufacturer;
    manufacturerSource = 'scan';
  }
  if (!manufacturer && input.macVendor) {
    manufacturer = input.macVendor;
    manufacturerSource = 'mac_oui';
  }

  let model: string | null = null;
  let modelSource: ModelSource | null = null;

  if (manufacturer && sysDescr) {
    for (const extractor of MODEL_EXTRACTORS) {
      if (!extractor.vendors.has(manufacturer)) continue;
      const extracted = extractor.extract(sysDescr);
      if (extracted) {
        model = extracted;
        modelSource = 'vendor_extractor';
      }
      break;
    }
  }
  if (!model) {
    const fromSnmp = modelFromSnmpData(input.snmpData);
    if (fromSnmp) {
      model = fromSnmp;
      modelSource = 'snmp_name';
    }
  }
  if (!model) {
    const fromScan = tidyModel(maskOidShapedModel(input.current?.model ?? null));
    if (fromScan) {
      model = fromScan;
      modelSource = 'scan';
    }
  }

  // Belt and braces: whichever branch won, an OID-shaped string never ships.
  model = maskOidShapedModel(model);
  if (!model) modelSource = null;

  return { manufacturer, manufacturerSource, model, modelSource };
}
