/**
 * Activation of a WebSocket-fallback desktop start (`desktop_stream_start`)
 * from the agent's accepted result.
 *
 * The start committed with its own command identity and left the row
 * `connecting` (remoteDesktopStartIntent.ts). The agent's success result for
 * exactly that command activates it, under the same consent predicate the
 * WebRTC answer path applies. When it cannot, the caller learns whether the
 * session has ended (so a capture an older agent started anyway can be
 * stopped) or is merely live under a newer start (which must be left alone).
 *
 * Every entry point runs inside the caller's db access context.
 */
import { and, eq, ne, or, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { remoteSessions } from '../db/schema';
import { consentMarkerIsCoherent, isUnsolicitedConsentReason } from '../routes/remote/helpers';

const LIVE_STATUSES: ReadonlySet<string> = new Set(['pending', 'connecting', 'active']);

/**
 * The consent predicate a desktop start's activation must satisfy, keyed on
 * the agent's consentReason marker. A consent-mode generation may become
 * active only when the exact agent result carries a marker it is entitled
 * to: 'user' (the end user allowed), or (#6819) an unsolicited-consent reason
 * when THIS start shipped consentUnavailableBehavior='proceed'. A NULL/'block'
 * binding fails closed. Notify/off generations need no marker. Mirrors the
 * WebRTC answer path's inline predicate in routes/agentWs.ts.
 */
export function desktopConsentActivationPredicate(consentReason: unknown): SQL[] {
  if (consentReason === 'user') return [];
  if (isUnsolicitedConsentReason(consentReason)) {
    return [or(
      ne(remoteSessions.desktopPromptMode, 'consent'),
      eq(remoteSessions.desktopConsentUnavailableBehavior, 'proceed'),
    )!];
  }
  return [ne(remoteSessions.desktopPromptMode, 'consent')];
}

export interface DesktopStreamStartActivationInput {
  sessionId: string;
  /** The device of the agent that reported the result. */
  deviceId: string;
  /** The exact command id the result answers. */
  startCommandId: string;
  consentReason: unknown;
  /**
   * The agent's whole consent record (the result body). A version 2 marker
   * must be backed by its own outcome (consentMarkerIsCoherent); one that is
   * not cannot activate a consent-mode start — same rule as the WebRTC answer.
   */
  consentMarker: Record<string, unknown>;
}

/** Only the exact connecting start, on the reporting device, with an entitled consent marker. */
export function desktopStreamStartActivationWhere(input: DesktopStreamStartActivationInput): SQL | undefined {
  return and(
    eq(remoteSessions.id, input.sessionId),
    eq(remoteSessions.deviceId, input.deviceId),
    eq(remoteSessions.status, 'connecting'),
    eq(remoteSessions.desktopStartCommandId, input.startCommandId),
    ...(consentMarkerIsCoherent(input.consentMarker)
      ? desktopConsentActivationPredicate(input.consentReason)
      : [ne(remoteSessions.desktopPromptMode, 'consent')]),
  );
}

export interface ActivatedDesktopStreamRow {
  id: string;
  orgId: string;
  userId: string;
  type: string;
  promptMode: string | null;
  consentUnavailableBehavior: string | null;
}

export type DesktopStreamStartActivation =
  | { activated: true; row: ActivatedDesktopStreamRow }
  /**
   * `terminal`: the session has ended (or no longer exists) — nothing will
   * ever stop a capture the agent started for it except an explicit stop.
   * Not terminal: the session is live under a newer start, or this start's
   * consent marker did not entitle it; the relay's own close handles those.
   */
  | { activated: false; terminal: boolean };

export async function activateDesktopStreamStart(
  input: DesktopStreamStartActivationInput,
): Promise<DesktopStreamStartActivation> {
  // startedAt is not written here: the start intent set it when the stream
  // start was committed, and the lease hard deadline is measured from it.
  const [updated] = await db
    .update(remoteSessions)
    .set({ status: 'active' })
    .where(desktopStreamStartActivationWhere(input))
    .returning({
      id: remoteSessions.id,
      orgId: remoteSessions.orgId,
      userId: remoteSessions.userId,
      type: remoteSessions.type,
      promptMode: remoteSessions.desktopPromptMode,
      consentUnavailableBehavior: remoteSessions.desktopConsentUnavailableBehavior,
    });
  if (updated) return { activated: true, row: updated as ActivatedDesktopStreamRow };

  const [current] = await db
    .select({
      status: remoteSessions.status,
      terminationPhase: remoteSessions.terminationPhase,
      desktopStartCommandId: remoteSessions.desktopStartCommandId,
    })
    .from(remoteSessions)
    .where(and(eq(remoteSessions.id, input.sessionId), eq(remoteSessions.deviceId, input.deviceId)))
    .limit(1);
  const terminal = !current
    || (current.terminationPhase ?? 'none') !== 'none'
    || !LIVE_STATUSES.has(String(current.status));
  return { activated: false, terminal };
}
