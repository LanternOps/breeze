/**
 * SNMP acquisition specs (spec §7.1).
 *
 * A template row only says WHICH OIDs to read. Until this module existed the
 * server flattened them to `oids: string[]` and the agent issued one GET over
 * all of them — so every table column (145 of the ~407 built-in OIDs) came back
 * `noSuchObject`, `parseValue` yielded nil, and the row was stored as
 * `value_type = 'null'`. This module says HOW to read each one, and the agent
 * walks the columns.
 *
 * Pure: no I/O, no DB, no clock. Both the poll dispatcher and its tests use it.
 */

export type OidMode = 'get' | 'walk';
export type OidCadence = 'fast' | 'slow';

/** A `snmp_templates.oids` entry. `mode`/`cadence` are W03 additions. */
export interface TemplateOidEntry {
  oid: string;
  name?: string | null;
  type?: string | null;
  description?: string | null;
  mode?: OidMode | null;
  cadence?: OidCadence | null;
}

/** One acquisition instruction, as it appears in the agent command payload. */
export interface OidSpec {
  oid: string;
  name: string;
  mode: OidMode;
  cadence: OidCadence;
}

/**
 * Hard bounds the agent enforces per poll. Sent on the wire so the ceiling can
 * be lowered from the server without shipping an agent, and mirrored in Go as
 * `snmppoll.DefaultPollLimits` for payloads that omit them.
 *
 * Sized against the worst realistic case in §17: a 48-port switch with ten
 * walked columns is ~480 rows per poll, comfortably inside maxRowsPerPoll, and
 * maxRowsPerOid stops a runaway table (a large FDB) at 512.
 */
export const POLL_LIMITS = {
  maxRowsPerOid: 512,
  maxRowsPerPoll: 4096,
  maxBytesPerPoll: 1_048_576,
  maxDurationMs: 20_000,
} as const;

export type PollLimits = typeof POLL_LIMITS;

/**
 * `slow` specs ride along on one dispatch in every SLOW_CADENCE_EVERY. At the
 * default 5-minute interval that refreshes static columns (ifDescr, ifName,
 * supply descriptions) hourly instead of every poll.
 */
export const SLOW_CADENCE_EVERY = 12;

/**
 * Default acquisition mode.
 *
 * The trailing `.0` is the scalar marker in every shipped built-in template and
 * in SMI itself: a scalar object instance is `<object>.0`, a columnar instance
 * is `<column>.<index>`. The entry's `type` CANNOT decide this — `type` is a
 * VALUE type, and the seed has 36 `counter64`, 22 `counter` and 6 `string`
 * entries that are table columns (`ifHCInOctets` is a counter64 column).
 */
function defaultMode(oid: string): OidMode {
  return oid.endsWith('.0') ? 'get' : 'walk';
}

/**
 * Turn a template's raw `oids` jsonb into acquisition specs.
 *
 * Takes `unknown` on purpose: the column is jsonb, so Drizzle hands back
 * `unknown` and the contents are whatever a custom template's author saved.
 * Anything unusable is dropped rather than shipped to an agent that would turn
 * it into a network request.
 */
export function buildOidSpecs(templateOids: unknown): OidSpec[] {
  if (!Array.isArray(templateOids)) return [];

  const specs: OidSpec[] = [];
  const seen = new Set<string>();

  for (const raw of templateOids) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as TemplateOidEntry;

    const oid = typeof entry.oid === 'string' ? entry.oid.trim() : '';
    if (oid === '') continue;
    // De-duplicate: `oidSpecs` drives real requests and a repeated walk spends
    // the row budget twice on the same table. `oids` keeps whatever the
    // template holds — that field's contract is "unchanged", not "cleaned up".
    if (seen.has(oid)) continue;
    seen.add(oid);

    const name = typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : oid;
    const mode: OidMode = entry.mode === 'get' || entry.mode === 'walk' ? entry.mode : defaultMode(oid);
    const cadence: OidCadence = entry.cadence === 'slow' || entry.cadence === 'fast' ? entry.cadence : 'fast';

    specs.push({ oid, name, mode, cadence });
  }

  return specs;
}

/**
 * Does this dispatch carry the `slow` specs?
 *
 * Reads the PRE-increment `snmp_devices.poll_seq`, which defaults to 0, so a
 * device's very first poll is a slow poll. Gating on the post-increment value
 * would leave a just-onboarded switch with no interface names for an hour.
 *
 * A NULL/NaN/negative sequence counts as a slow poll: failing open costs one
 * extra walk, failing closed silently withholds data.
 */
export function includesSlowCadence(pollSeq: number): boolean {
  if (!Number.isFinite(pollSeq) || pollSeq < 0) return true;
  return Math.floor(pollSeq) % SLOW_CADENCE_EVERY === 0;
}

/**
 * The specs this dispatch carries.
 *
 * Never returns an empty list for a non-empty input: a template whose every
 * entry is `slow` would otherwise send `oidSpecs: []` on 11 of every 12 polls
 * and the agent, seeing the field present, would collect nothing at all.
 */
export function selectOidSpecsForSeq(specs: OidSpec[], pollSeq: number): OidSpec[] {
  if (specs.length === 0) return [];
  if (includesSlowCadence(pollSeq)) return specs;
  const fast = specs.filter((spec) => spec.cadence !== 'slow');
  return fast.length > 0 ? fast : specs;
}
