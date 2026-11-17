import { z } from 'zod';

/**
 * Control-plane block episodes (#8868).
 *
 * When a network filter, captive portal or untrusted TLS interceptor answers
 * in place of the control plane, the agent records an *episode* and attaches
 * it to every heartbeat as the optional `controlPlaneBlock` object, on
 * whichever transport gets through (ECH, the backup URL, another network).
 * Pure core, same shape as services/watchdogInstallHealth: strict parse,
 * transition-only write plan, read-time view. No DB, no clock (`now` injected).
 *
 * Invariants:
 *  - Observational only. Never gates dispatch, auth, or any security call.
 *  - Every field is untrusted device input (the host and issuer text come from
 *    whatever answered on the network). Closed enums, anchored patterns and
 *    length caps from the agent contract
 *    (agent/internal/heartbeat/testdata/control_plane_block_contract.json);
 *    one bad field makes the whole object `invalid`. Consumers render the text
 *    as plain escaped text only.
 *  - Absence means *no change*, not "clear": an older binary must not erase
 *    evidence. An active stored episode goes stale only after beats keep
 *    arriving without a valid one for STALE_AFTER_MS (measured from the last
 *    server write, so between 2 h and 3 h after the last assertion).
 *  - A malformed object is `invalid`: it neither clears nor sets anything,
 *    and ages a stored episode exactly like absence (an agent whose reports
 *    the API cannot read must not pin a badge forever).
 *  - Steady state adds no keys to the beat's single `UPDATE devices`: a
 *    re-asserted episode is written only when something other than
 *    `lastSeenAt` changed, or at most once per REFRESH_AFTER_MS.
 *  - Agent times are stored as reported (validated, normalized to ISO) so a
 *    skewed device clock cannot churn writes; the view clamps them into
 *    [now - 30 d, now] on the server clock. The cleared notice expires on the
 *    server clock too (`reportedAt` bounds it), so a device clock running
 *    ahead cannot pin it.
 *  - The agent holds one episode at a time. A new `firstSeenAt` (or host)
 *    replaces the stored one; a superseded episode is never reported cleared.
 */

/** Mirrors agent/internal/ech BlockKind (wire strings). */
export const CONTROL_PLANE_BLOCK_KINDS = [
  'web_filter',
  'captive_portal',
  'plaintext_unknown',
  'untrusted_certificate',
] as const;

export const CONTROL_PLANE_BLOCK_CLEARED_BY = ['plain_success', 'unobserved'] as const;

export type ControlPlaneBlockKind = (typeof CONTROL_PLANE_BLOCK_KINDS)[number];
export type ControlPlaneBlockClearedBy = (typeof CONTROL_PLANE_BLOCK_CLEARED_BY)[number];

/** Lowercase hostname or IPv4 literal, no port, path or userinfo (≤253 chars). */
const HOST_PATTERN = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
/** Printable ASCII, no leading/trailing space, ≤64 chars. */
const ISSUER_PATTERN = /^[\x21-\x7e]([\x20-\x7e]{0,62}[\x21-\x7e])?$/;

export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
export const REFRESH_AFTER_MS = 60 * 60 * 1000;
export const CLEARED_NOTICE_MS = 7 * 24 * 60 * 60 * 1000;
export const CLAMP_PAST_MS = 30 * 24 * 60 * 60 * 1000;

const isoTime = z
  .string()
  .datetime({ offset: true })
  .transform((s) => new Date(s).toISOString());

const reportSchema = z
  .object({
    kind: z.enum(CONTROL_PLANE_BLOCK_KINDS),
    host: z.string().regex(HOST_PATTERN),
    firstSeenAt: isoTime,
    lastSeenAt: isoTime,
    clearedAt: isoTime.optional(),
    clearedBy: z.enum(CONTROL_PLANE_BLOCK_CLEARED_BY).optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    locationHost: z.string().regex(HOST_PATTERN).optional(),
    certIssuer: z.string().regex(ISSUER_PATTERN).optional(),
  })
  .strict()
  .refine((r) => (r.clearedAt === undefined) === (r.clearedBy === undefined), {
    message: 'clearedAt and clearedBy go together',
  });

export type ControlPlaneBlockReport = z.output<typeof reportSchema>;

export type ParsedControlPlaneBlock =
  | { status: 'absent' }
  | { status: 'invalid' }
  | { status: 'valid'; value: ControlPlaneBlockReport };

/** `undefined` -> absent. Anything else is strict-parsed; a failure is `invalid`. */
export function parseControlPlaneBlock(raw: unknown): ParsedControlPlaneBlock {
  if (raw === undefined) return { status: 'absent' };
  const parsed = reportSchema.safeParse(raw);
  if (!parsed.success) return { status: 'invalid' };
  return { status: 'valid', value: parsed.data };
}

/** Stored in `devices.control_plane_block` (export `excludedOpen`). */
export interface ControlPlaneBlockRecord {
  kind: ControlPlaneBlockKind;
  host: string;
  firstSeenAt: string;
  lastSeenAt: string;
  clearedAt?: string;
  clearedBy?: ControlPlaneBlockClearedBy;
  httpStatus?: number;
  locationHost?: string;
  certIssuer?: string;
  /** The beat that last wrote this record arrived over ECH. */
  reachableViaEch: boolean;
  /** Server clock of the last write. */
  reportedAt: string;
  /** Server clock when the episode went stale (beats kept arriving without it). */
  staleAt?: string;
}

export interface ControlPlaneBlockDeviceFields {
  controlPlaneBlockKind: string | null;
  controlPlaneBlock: ControlPlaneBlockRecord | null;
}

export type ControlPlaneBlockWrite = {
  controlPlaneBlockKind?: ControlPlaneBlockKind | null;
  controlPlaneBlock?: ControlPlaneBlockRecord | null;
};

/** True when `iso` is older than `ms` before `now`, or unparseable. */
function olderThan(iso: string | undefined, ms: number, now: Date): boolean {
  const t = iso === undefined ? Number.NaN : Date.parse(iso);
  return !Number.isFinite(t) || now.getTime() - t > ms;
}

/** Fields that identify the episode and its evidence (everything but lastSeenAt). */
function sameEpisodeEvidence(stored: ControlPlaneBlockRecord, r: ControlPlaneBlockReport): boolean {
  return (
    stored.kind === r.kind &&
    stored.host === r.host &&
    stored.firstSeenAt === r.firstSeenAt &&
    stored.clearedAt === r.clearedAt &&
    stored.clearedBy === r.clearedBy &&
    stored.httpStatus === r.httpStatus &&
    stored.locationHost === r.locationHost &&
    stored.certIssuer === r.certIssuer
  );
}

function toRecord(r: ControlPlaneBlockReport, reachableViaEch: boolean, now: Date): ControlPlaneBlockRecord {
  const rec: ControlPlaneBlockRecord = {
    kind: r.kind,
    host: r.host,
    firstSeenAt: r.firstSeenAt,
    lastSeenAt: r.lastSeenAt,
    reachableViaEch,
    reportedAt: now.toISOString(),
  };
  if (r.clearedAt !== undefined) rec.clearedAt = r.clearedAt;
  if (r.clearedBy !== undefined) rec.clearedBy = r.clearedBy;
  if (r.httpStatus !== undefined) rec.httpStatus = r.httpStatus;
  if (r.locationHost !== undefined) rec.locationHost = r.locationHost;
  if (r.certIssuer !== undefined) rec.certIssuer = r.certIssuer;
  return rec;
}

/**
 * Transition-only plan against the device row the beat already loaded. `{}`
 * whenever nothing changes, so steady-state beats add zero keys to the beat's
 * single `UPDATE devices`. `echActive` is the beat's own top-level flag.
 */
export function planControlPlaneBlockWrite(
  device: ControlPlaneBlockDeviceFields,
  parsed: ParsedControlPlaneBlock,
  echActive: boolean | undefined,
  now: Date,
): ControlPlaneBlockWrite {
  const stored = device.controlPlaneBlock;

  if (parsed.status === 'absent' || parsed.status === 'invalid') {
    if (device.controlPlaneBlockKind === null) return {};
    // Inconsistent rows (kind without an open record): drop the kind only.
    if (!stored || stored.staleAt !== undefined || stored.clearedAt !== undefined) {
      return { controlPlaneBlockKind: null };
    }
    if (!olderThan(stored.reportedAt, STALE_AFTER_MS, now)) return {};
    return { controlPlaneBlockKind: null, controlPlaneBlock: { ...stored, staleAt: now.toISOString() } };
  }

  const report = parsed.value;
  const reachableViaEch = echActive === true;

  if (report.clearedAt !== undefined) {
    if (
      stored &&
      device.controlPlaneBlockKind === null &&
      stored.staleAt === undefined &&
      sameEpisodeEvidence(stored, report)
    ) {
      return {};
    }
    return { controlPlaneBlockKind: null, controlPlaneBlock: toRecord(report, reachableViaEch, now) };
  }

  const write: ControlPlaneBlockWrite = {};
  if (device.controlPlaneBlockKind !== report.kind) write.controlPlaneBlockKind = report.kind;
  const unchanged =
    stored !== null &&
    stored.staleAt === undefined &&
    sameEpisodeEvidence(stored, report) &&
    stored.reachableViaEch === reachableViaEch &&
    !olderThan(stored.reportedAt, REFRESH_AFTER_MS, now);
  if (!unchanged || write.controlPlaneBlockKind !== undefined) {
    write.controlPlaneBlock = toRecord(report, reachableViaEch, now);
  }
  return write;
}

export interface ControlPlaneBlockNotice {
  state: 'active' | 'cleared';
  kind: ControlPlaneBlockKind;
  host: string;
  firstSeenAt: string;
  lastSeenAt: string;
  clearedAt?: string;
  httpStatus?: number;
  locationHost?: string;
  certIssuer?: string;
  reachableViaEch: boolean;
}

/** Re-validates the stored jsonb at read time; a bad row shows nothing. */
const storedSchema = z.object({
  kind: z.enum(CONTROL_PLANE_BLOCK_KINDS),
  host: z.string().regex(HOST_PATTERN),
  firstSeenAt: z.string().datetime({ offset: true }),
  lastSeenAt: z.string().datetime({ offset: true }),
  clearedAt: z.string().datetime({ offset: true }).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  locationHost: z.string().regex(HOST_PATTERN).optional(),
  certIssuer: z.string().regex(ISSUER_PATTERN).optional(),
  reachableViaEch: z.boolean(),
  reportedAt: z.string().datetime({ offset: true }),
  staleAt: z.string().optional(),
});

function clampIso(iso: string, now: Date): string {
  const t = Date.parse(iso);
  const lo = now.getTime() - CLAMP_PAST_MS;
  return new Date(Math.min(Math.max(t, lo), now.getTime())).toISOString();
}

/** Read-time view for the device detail response. null = show nothing. */
export function deriveControlPlaneBlockNotice(
  row: ControlPlaneBlockDeviceFields,
  now: Date,
): ControlPlaneBlockNotice | null {
  if (!row.controlPlaneBlock) return null;
  const parsed = storedSchema.safeParse(row.controlPlaneBlock);
  if (!parsed.success) return null;
  const rec = parsed.data;
  if (rec.staleAt !== undefined) return null;

  let state: ControlPlaneBlockNotice['state'];
  let clearedAt: string | undefined;
  if (rec.clearedAt === undefined) {
    if (row.controlPlaneBlockKind !== rec.kind) return null;
    state = 'active';
  } else {
    clearedAt = clampIso(rec.clearedAt, now);
    // Age on the earlier of the (clamped) agent clear time and the server
    // write time: a clearedAt in the future clamps to `now` on every read and
    // would otherwise never expire.
    const shownSince = Math.min(Date.parse(clearedAt), Date.parse(rec.reportedAt));
    if (now.getTime() - shownSince > CLEARED_NOTICE_MS) return null;
    state = 'cleared';
  }

  const notice: ControlPlaneBlockNotice = {
    state,
    kind: rec.kind,
    host: rec.host,
    firstSeenAt: clampIso(rec.firstSeenAt, now),
    lastSeenAt: clampIso(rec.lastSeenAt, now),
    reachableViaEch: rec.reachableViaEch,
  };
  if (clearedAt !== undefined) notice.clearedAt = clearedAt;
  if (rec.httpStatus !== undefined) notice.httpStatus = rec.httpStatus;
  if (rec.locationHost !== undefined) notice.locationHost = rec.locationHost;
  if (rec.certIssuer !== undefined) notice.certIssuer = rec.certIssuer;
  return notice;
}
