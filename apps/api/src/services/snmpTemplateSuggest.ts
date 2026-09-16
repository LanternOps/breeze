/**
 * Suggest an SNMP template from a device's sysObjectID (spec §8, decision D5).
 *
 * BOUNDARY MATCHING IS THE WHOLE POINT. A naive `sysObjectId.startsWith(prefix)`
 * makes enterprise 25 match every enterprise-253 (Xerox) device, because "253"
 * starts with "25". Both sides are split on `.` and compared component by
 * component; `1.3.6.1.4.1.25` therefore matches 0 components of
 * `1.3.6.1.4.1.253.8.62…` and is not a candidate at all.
 *
 * RANKING (spec §8): device_type match, then longer matched prefix, then the
 * org's own template over a built-in, then name. When the top two tie on ALL of
 * those the answer is AMBIGUOUS and we return null rather than guessing — the
 * three Cisco built-ins all claim 1.3.6.1.4.1.9, and quietly attaching the ASA
 * template to a Catalyst is worse than the UI saying "pick one" (spec §14).
 */
import { eq, or } from 'drizzle-orm';
import { db } from '../db';
import { snmpTemplates } from '../db/schema';

export interface TemplateSuggestionInput {
  sysObjectId: string | null;
  assetType: string | null;
  orgId: string;
}

export interface TemplateSuggestion {
  templateId: string;
  templateName: string;
  reason: string;
}

/** Components of an OID, leading/trailing dots and leading zeros removed; null when malformed. */
export function normalizeOid(oid: string | null | undefined): string[] | null {
  if (typeof oid !== 'string') return null;
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
 * Number of components `prefix` matches at the head of `oidParts`, or 0 when it
 * is not a component-boundary prefix of it. A prefix longer than the OID, an
 * empty prefix and a malformed prefix all score 0.
 */
export function oidHasPrefix(oidParts: string[], prefix: string): number {
  const prefixParts = normalizeOid(prefix);
  if (!prefixParts || prefixParts.length === 0) return 0;
  if (prefixParts.length > oidParts.length) return 0;
  for (let i = 0; i < prefixParts.length; i += 1) {
    if (prefixParts[i] !== oidParts[i]) return 0;
  }
  return prefixParts.length;
}

interface Candidate {
  id: string;
  name: string;
  vendor: string | null;
  isBuiltIn: boolean;
  deviceType: string | null;
  matchLength: number;
  typeMatch: boolean;
}

/** Descending rank order. Returns <0 when `a` should win. */
function compareCandidates(a: Candidate, b: Candidate): number {
  return (Number(b.typeMatch) - Number(a.typeMatch))
    || (b.matchLength - a.matchLength)
    || (Number(a.isBuiltIn) - Number(b.isBuiltIn))
    || a.name.localeCompare(b.name);
}

/** True when the top two candidates are indistinguishable on every ranking key. */
function isAmbiguous(a: Candidate, b: Candidate | undefined): boolean {
  if (!b) return false;
  return a.typeMatch === b.typeMatch
    && a.matchLength === b.matchLength
    && a.isBuiltIn === b.isBuiltIn;
}

function buildReason(winner: Candidate, assetType: string | null): string {
  const subject = winner.vendor ?? 'SNMP device';
  const qualifier = winner.typeMatch && assetType ? ` ${assetType}` : '';
  return `Detected ${subject}${qualifier}, using ${winner.name}`;
}

export async function suggestTemplate(input: TemplateSuggestionInput): Promise<TemplateSuggestion | null> {
  const oidParts = normalizeOid(input.sysObjectId);
  if (!oidParts) return null;

  // RLS (snmp_templates_select) already admits built-ins plus orgs the caller
  // can access; this clause narrows a PARTNER-scope caller to THIS org's own
  // templates. RLS is stricter than the app layer, never the other way round.
  const rows = await db
    .select({
      id: snmpTemplates.id,
      name: snmpTemplates.name,
      vendor: snmpTemplates.vendor,
      deviceType: snmpTemplates.deviceType,
      isBuiltIn: snmpTemplates.isBuiltIn,
      prefixes: snmpTemplates.sysObjectIdPrefixes,
    })
    .from(snmpTemplates)
    .where(or(eq(snmpTemplates.isBuiltIn, true), eq(snmpTemplates.orgId, input.orgId))!);

  let candidates: Candidate[] = [];
  for (const row of rows) {
    const prefixes = Array.isArray(row.prefixes) ? row.prefixes : [];
    let matchLength = 0;
    for (const prefix of prefixes) {
      const matched = oidHasPrefix(oidParts, prefix);
      if (matched > matchLength) matchLength = matched;
    }
    if (matchLength === 0) continue;
    candidates.push({
      id: row.id,
      name: row.name,
      vendor: row.vendor,
      deviceType: row.deviceType,
      isBuiltIn: row.isBuiltIn,
      matchLength,
      typeMatch: Boolean(input.assetType) && row.deviceType === input.assetType,
    });
  }

  // A shared enterprise arc is not sufficient when the device types contradict.
  if (input.assetType && input.assetType !== 'unknown') {
    candidates = candidates.filter((candidate) =>
      candidate.deviceType === null || candidate.deviceType === input.assetType);
  }

  if (candidates.length === 0) return null;
  candidates.sort(compareCandidates);

  const winner = candidates[0]!;
  if (isAmbiguous(winner, candidates[1])) return null;

  return {
    templateId: winner.id,
    templateName: winner.name,
    reason: buildReason(winner, input.assetType),
  };
}
