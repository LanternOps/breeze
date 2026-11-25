/**
 * Holds pointer input across a mid-session resolution change (#11754).
 *
 * When the remote display changes mode, the agent resizes its encoder, moves
 * the geometry epoch, and sends `monitor_switched` with `reason:
 * 'resolution_change'` and the new `width`/`height`. Pointer coordinates are
 * mapped from the decoded video's size (scaleVideoCoords), and the decoder
 * keeps showing old-size frames for a jitter-buffer's worth of time after the
 * announcement arrives. A click in that window would carry the new geometry
 * epoch but old-size coordinates, and land in the wrong place. So pointer
 * input is held until the video decodes a frame at the announced size.
 *
 * The hold is bounded: if the decoded size never matches (an agent that
 * reports a size its stream is not at), input resumes after
 * GEOMETRY_HOLD_MAX_MS rather than staying frozen. Plain monitor switches are
 * not held — their announced size is not guaranteed to be the stream's.
 */
export const GEOMETRY_HOLD_MAX_MS = 1500;

interface PendingGeometry {
  width: number;
  height: number;
  until: number;
}

function positiveInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
}

export class GeometryHold {
  private pending: PendingGeometry | null = null;

  /** Feed every control message; only monitor_switched matters. */
  onControlMessage(msg: Record<string, unknown>, now: number): void {
    if (msg.type !== 'monitor_switched') return;
    if (msg.reason !== 'resolution_change') {
      // A monitor switch supersedes any pending resolution change.
      this.pending = null;
      return;
    }
    const width = positiveInt(msg.width);
    const height = positiveInt(msg.height);
    if (width === null || height === null) return;
    this.pending = { width, height, until: now + GEOMETRY_HOLD_MAX_MS };
  }

  /**
   * Whether pointer input must be held now, given the decoded video size. A
   * match or an expired bound ends the hold for good.
   */
  shouldHold(videoWidth: number, videoHeight: number, now: number): boolean {
    const p = this.pending;
    if (!p) return false;
    if (now >= p.until || (videoWidth === p.width && videoHeight === p.height)) {
      this.pending = null;
      return false;
    }
    return true;
  }
}
