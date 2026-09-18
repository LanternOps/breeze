/**
 * IANA Private Enterprise Number (PEN) → vendor name (spec §9, decision D6).
 *
 * WHY THIS EXISTS. `agent/internal/discovery/classify.go` writes
 * `model = sysObjectID` when it knows nothing better, and the manufacturer
 * falls back to the MAC OUI vendor. A Xerox C325 has a Lexmark-built engine
 * (OUI "LEXMARK INTERNATIONAL, INC.") and a sysObjectID under enterprise 253
 * (Xerox), so the device page rendered Model
 * `.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1` and Manufacturer `LEXMARK …` — spec F5.
 * The enterprise arc of the sysObjectID is the ONE identity signal that is
 * assigned rather than inferred, so it outranks every heuristic below it.
 *
 * VERIFICATION. Every number here was read out of the live IANA registry
 * (https://www.iana.org/assignments/enterprise-numbers.txt, "last updated
 * 2026-09-15") on 2026-09-15; the trailing comment is the registrant string
 * exactly as IANA prints it, so any entry can be re-verified with:
 *
 *   curl -s https://www.iana.org/assignments/enterprise-numbers.txt \
 *     | grep -A1 -x '253'
 *
 * Adding an entry WITHOUT that check is prohibited: a wrong PEN silently
 * mislabels every device of that vendor (spec §17, "Enterprise-number errors").
 * Only the ROOT arc is registered with IANA — product sub-arcs
 * (1.3.6.1.4.1.674.10892.x for Dell iDRAC, say) are vendor-MIB knowledge and
 * are deliberately NOT encoded here or in the template prefix seed.
 */

export const IANA_ENTERPRISE_VENDORS: Readonly<Record<number, string>> = Object.freeze({
  9: 'Cisco',              // ciscoSystems
  11: 'HP',                // Hewlett-Packard  (LaserJet, ProCurve / ArubaOS-Switch)
  232: 'HP',               // Compaq           (the arc HP ProLiant / iLO still reports under)
  253: 'Xerox',            // Xerox
  318: 'APC',              // American Power Conversion Corp.
  367: 'Ricoh',            // RICOH Co. Ltd.
  534: 'Eaton',            // Eaton Corporation
  641: 'Lexmark',          // Lexmark International
  674: 'Dell',             // Dell Inc.
  1248: 'Epson',           // SEIKO EPSON CORPORATION
  1347: 'Kyocera',         // KYOCERA Corporation
  1602: 'Canon',           // CANON Inc.
  2385: 'Sharp',           // SHARP Corporation
  2435: 'Brother',         // Brother Industries, Ltd.
  2636: 'Juniper',         // Juniper Networks, Inc.
  3808: 'CyberPower',      // Cyber Power System Inc.      (the UPS arc)
  4526: 'Netgear',         // Netgear
  6574: 'Synology',        // Synology Inc.
  6876: 'VMware',          // VMware Inc.
  8072: 'net-snmp',        // net-snmp  — see GENERIC_AGENT_ENTERPRISE_NUMBERS
  8741: 'SonicWall',       // SonicWALL, Inc.
  10642: 'Zebra',          // Zebra Technologies Corporation
  10876: 'Supermicro',     // Super Micro Computer Inc.
  11863: 'TP-Link',        // TP-Link Systems Inc.
  12356: 'Fortinet',       // Fortinet, Inc.
  14823: 'Aruba',          // Aruba, a Hewlett Packard Enterprise company
  14988: 'MikroTik',       // MikroTik
  15446: 'CyberPower',     // CyberPower Systems, Inc.     (second registration)
  18334: 'Konica Minolta', // KONICA MINOLTA HOLDINGS, INC.
  19046: 'Lenovo',         // Lenovo Enterprise Business Group
  24681: 'QNAP',           // QNAP SYSTEMS, INC
  25053: 'Ruckus',         // Ruckus Wireless, Inc.
  29671: 'Meraki',         // Meraki Networks, Inc.
  41112: 'Ubiquiti',       // Ubiquiti Networks, Inc.
  47196: 'HPE',            // Hewlett Packard Enterprise
  50919: 'Konica Minolta', // KONICA MINOLTA, INC.         (second registration)
  53869: 'OPNsense',       // OPNsense
  55062: 'QNAP',           // QNAP Systems, Inc.           (second registration)
});

/**
 * PENs that identify the SNMP AGENT rather than the hardware vendor.
 *
 * pfSense, OPNsense and every Linux box running net-snmpd report 8072, which
 * says nothing about who made the box. `resolveAssetIdentity` skips these so
 * the sysDescr rules or the NIC OUI answer instead — surfacing "net-snmp" as a
 * Manufacturer would be the same class of defect as F5. The number stays in the
 * table above because the TEMPLATE suggester legitimately matches on it.
 */
export const GENERIC_AGENT_ENTERPRISE_NUMBERS: ReadonlySet<number> = new Set([8072]);

/** `1.3.6.1.4.1` — iso.org.dod.internet.private.enterprise. */
const ENTERPRISE_ROOT = ['1', '3', '6', '1', '4', '1'] as const;

/** Split an OID into components, dropping leading/trailing dots and leading zeros. */
function oidComponents(oid: string): string[] | null {
  const trimmed = oid.trim().replace(/^\.+/, '').replace(/\.+$/, '');
  if (!trimmed) return null;
  const parts = trimmed.split('.');
  const out: string[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    out.push(part.replace(/^0+(?=\d)/, ''));
  }
  return out;
}

/**
 * The enterprise number of a sysObjectID, or null when the OID is not under
 * `1.3.6.1.4.1.<PEN>` at all (a MIB-2 scalar, a malformed string, the bare arc).
 * A well-formed but unregistered PEN is RETURNED — this is a parser, not a
 * lookup; `vendorFromSysObjectId` is the lookup.
 */
export function enterpriseNumberFromSysObjectId(oid: string | null | undefined): number | null {
  if (typeof oid !== 'string') return null;
  const parts = oidComponents(oid);
  if (!parts || parts.length <= ENTERPRISE_ROOT.length) return null;
  for (let i = 0; i < ENTERPRISE_ROOT.length; i += 1) {
    if (parts[i] !== ENTERPRISE_ROOT[i]) return null;
  }
  const value = Number(parts[ENTERPRISE_ROOT.length]);
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

/** Vendor name for a sysObjectID, or null when the PEN is absent or unknown. */
export function vendorFromSysObjectId(oid: string | null | undefined): string | null {
  const pen = enterpriseNumberFromSysObjectId(oid);
  if (pen === null) return null;
  return IANA_ENTERPRISE_VENDORS[pen] ?? null;
}
