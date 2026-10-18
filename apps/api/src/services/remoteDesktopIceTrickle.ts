import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { remoteSessions } from '../db/schema';

/**
 * Trickle ICE for WebRTC desktop sessions (#9182).
 *
 * The agent answers a short window after its first local candidate so a LAN
 * session connects fast, and the viewer caps its own gathering at a few
 * seconds. Candidates either side gathers later — above all a TURN relay
 * candidate, whose Allocate round trip often outlasts both windows — used to
 * be dropped, which is exactly the off-LAN case TURN exists for. They now
 * trickle through `remote_sessions.ice_candidates`:
 *
 *  - agent → viewer: the agent sends `desktop_ice_candidate` frames on its
 *    socket (only when the server advertises {@link DESKTOP_ICE_TRICKLE_CAPABILITY});
 *    each is appended as a `source: 'agent'` entry, and the viewer reads them
 *    back from `GET /desktop-ws/:id/viewer/session` (`agentIceCandidates`).
 *  - viewer → agent: the viewer POSTs late candidates to
 *    `/desktop-ws/:id/viewer/ice`; each is appended as a `source: 'viewer'`
 *    entry and relayed to the agent as an id-less `desktop_ice_candidate`
 *    frame.
 *
 * Every entry is bound to the session's `desktop_start_generation`, the column
 * is reset by each start-intent commit, and every write is guarded by device,
 * generation, status, termination phase and a per-source cap — so a delayed
 * frame from a superseded start, or a flood from either side, cannot reach the
 * current viewer or crowd out the other side's candidates.
 */

/** WS capability advertised to agents that may send `desktop_ice_candidate`. */
export const DESKTOP_ICE_TRICKLE_CAPABILITY = 'desktop_ice_trickle';

/**
 * Entries kept per source per start. A real session trickles a handful (one
 * srflx/relay per interface and server); the cap only bounds abuse, and is per
 * source so one side can never exhaust the other's budget.
 */
export const MAX_ICE_ENTRIES_PER_SOURCE = 32;

const MAX_CANDIDATE_BYTES = 1024;
const GENERATION_PATTERN = /^\d{1,19}$/;
const LIVE_ICE_STATUSES = ['connecting', 'active'] as const;

export const iceCandidateInitSchema = z.object({
  // An empty candidate line is the browser's end-of-candidates signal, never
  // a candidate to relay.
  candidate: z.string().min(1).max(MAX_CANDIDATE_BYTES),
  sdpMid: z.string().max(64).nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).max(65535).nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional(),
});

export type IceCandidateInit = z.infer<typeof iceCandidateInitSchema>;

/** The agent's trickle frame. Exactly one of `candidate` / `complete`. */
export const agentIceCandidateMessageSchema = z.object({
  type: z.literal('desktop_ice_candidate'),
  sessionId: z.string().uuid(),
  // Canonical decimal string: generations are bigint and must never pass
  // through a JavaScript Number.
  startGeneration: z.string().regex(GENERATION_PATTERN),
  seq: z.number().int().min(0).max(1000),
  candidate: iceCandidateInitSchema.optional(),
  complete: z.literal(true).optional(),
}).refine(
  (m) => (m.candidate === undefined) !== (m.complete === undefined),
  { message: 'exactly one of candidate or complete' },
);

/** The viewer's POST body. */
export const viewerIceCandidateBodySchema = z.object({
  candidate: iceCandidateInitSchema,
});

/** The frame relayed to the agent for a viewer candidate. */
export interface DesktopIceCandidateRelayFrame {
  type: 'desktop_ice_candidate';
  sessionId: string;
  startGeneration: string;
  candidate: IceCandidateInit;
}

/** What the viewer reads back: the agent's entries for the current start. */
export type AgentIceCandidateForViewer =
  | { seq: number; candidate: IceCandidateInit }
  | { seq: number; complete: true };

function appendEntry(entry: Record<string, unknown>) {
  return sql`COALESCE(${remoteSessions.iceCandidates}, '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb`;
}

function sourceBelowCap(source: 'agent' | 'viewer') {
  return sql`(SELECT count(*) FROM jsonb_array_elements(COALESCE(${remoteSessions.iceCandidates}, '[]'::jsonb)) AS e WHERE e->>'source' = ${source}) < ${MAX_ICE_ENTRIES_PER_SOURCE}`;
}

/** Keep only the RTCIceCandidateInit fields, dropping nullish ones. */
function cleanCandidate(c: IceCandidateInit): IceCandidateInit {
  const out: IceCandidateInit = { candidate: c.candidate };
  if (c.sdpMid != null) out.sdpMid = c.sdpMid;
  if (c.sdpMLineIndex != null) out.sdpMLineIndex = c.sdpMLineIndex;
  if (c.usernameFragment != null) out.usernameFragment = c.usernameFragment;
  return out;
}

/**
 * Record one agent trickle entry. Matches only the AUTHENTICATED device's live
 * desktop session at exactly this start generation, under the agent cap.
 * Returns whether a row was written. Callers supply the db access context.
 */
export async function appendAgentIceCandidate(params: {
  deviceId: string;
  sessionId: string;
  startGeneration: string;
  seq: number;
  candidate?: IceCandidateInit;
  complete?: true;
}): Promise<boolean> {
  const entry: Record<string, unknown> = {
    source: 'agent',
    generation: params.startGeneration,
    seq: params.seq,
  };
  if (params.complete) {
    entry.complete = true;
  } else if (params.candidate) {
    entry.candidate = cleanCandidate(params.candidate);
  } else {
    return false;
  }

  const [row] = await db
    .update(remoteSessions)
    .set({ iceCandidates: appendEntry(entry) })
    .where(and(
      eq(remoteSessions.id, params.sessionId),
      eq(remoteSessions.deviceId, params.deviceId),
      eq(remoteSessions.type, 'desktop'),
      inArray(remoteSessions.status, [...LIVE_ICE_STATUSES]),
      eq(remoteSessions.terminationPhase, 'none'),
      eq(remoteSessions.desktopStartGeneration, BigInt(params.startGeneration)),
      sourceBelowCap('agent'),
    ))
    .returning({ id: remoteSessions.id });
  return !!row;
}

export type SubmitViewerIceCandidateResult =
  | { ok: true; forwarded: boolean; iceCandidatesCount: number }
  | { ok: false; reason: 'state' | 'rejected' };

/**
 * Record a viewer's late candidate and relay it to the agent. The caller has
 * already authorized the viewer for this session and supplies the db access
 * context. The relay only follows a successful guarded write, so a candidate
 * for a session that has moved on is never delivered.
 */
export async function submitViewerIceCandidate(params: {
  session: { id: string; status: string; desktopStartGeneration: bigint | null };
  agentId: string | null;
  candidate: IceCandidateInit;
  send: (agentId: string, frame: DesktopIceCandidateRelayFrame) => boolean;
}): Promise<SubmitViewerIceCandidateResult> {
  const { session } = params;
  if (!(LIVE_ICE_STATUSES as readonly string[]).includes(session.status)) {
    return { ok: false, reason: 'state' };
  }
  const generation = session.desktopStartGeneration ?? 0n;
  const candidate = cleanCandidate(params.candidate);

  const [row] = await db
    .update(remoteSessions)
    .set({
      iceCandidates: appendEntry({ source: 'viewer', generation: generation.toString(), candidate }),
    })
    .where(and(
      eq(remoteSessions.id, session.id),
      eq(remoteSessions.type, 'desktop'),
      inArray(remoteSessions.status, [...LIVE_ICE_STATUSES]),
      eq(remoteSessions.terminationPhase, 'none'),
      eq(remoteSessions.desktopStartGeneration, generation),
      sourceBelowCap('viewer'),
    ))
    .returning({ iceCandidates: remoteSessions.iceCandidates });
  if (!row) return { ok: false, reason: 'rejected' };

  const forwarded = params.agentId
    ? params.send(params.agentId, {
      type: 'desktop_ice_candidate',
      sessionId: session.id,
      startGeneration: generation.toString(),
      candidate,
    })
    : false;
  const stored = row.iceCandidates;
  return { ok: true, forwarded, iceCandidatesCount: Array.isArray(stored) ? stored.length : 0 };
}

/**
 * The agent's trickle entries for the session's current start, ordered by
 * seq. Viewer entries, other generations and malformed rows are omitted.
 */
export function agentIceCandidatesForViewer(
  stored: unknown,
  generation: bigint | null,
): AgentIceCandidateForViewer[] {
  if (!Array.isArray(stored)) return [];
  const current = (generation ?? 0n).toString();
  const out: AgentIceCandidateForViewer[] = [];
  for (const raw of stored) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    if (e.source !== 'agent' || e.generation !== current) continue;
    if (typeof e.seq !== 'number' || !Number.isInteger(e.seq) || e.seq < 0) continue;
    if (e.complete === true) {
      out.push({ seq: e.seq, complete: true });
      continue;
    }
    const parsed = iceCandidateInitSchema.safeParse(e.candidate);
    if (parsed.success) out.push({ seq: e.seq, candidate: cleanCandidate(parsed.data) });
  }
  return out.sort((a, b) => a.seq - b.seq);
}
