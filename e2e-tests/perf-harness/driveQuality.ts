/**
 * Drive the viewer's remote-desktop quality knobs over the `control` data
 * channel captured by the stats hook.
 *
 * Protocol (agent side: agent/internal/remote/desktop/session_control.go):
 *   { "type": "set_bitrate",      "value": <bits-per-second> }
 *   { "type": "set_fps",          "value": <frames-per-second> }
 *   { "type": "request_keyframe" }
 * Messages are JSON, sent over the ordered `control` RTCDataChannel that the
 * viewer opens in apps/viewer/src/lib/webrtc.ts.
 *
 * With no live agent the `control` channel never opens; every call here returns
 * `false` (nothing sent) instead of throwing, so it is safe to script.
 */
import type { Page } from '@playwright/test';

export type ControlMessage =
  | { type: 'set_bitrate'; value: number }
  | { type: 'set_fps'; value: number }
  | { type: 'request_keyframe' };

/** Returns true if the message was actually sent over an open control channel. */
export async function sendControl(page: Page, msg: ControlMessage): Promise<boolean> {
  return page.evaluate((message) => {
    const w = window as unknown as {
      __breezePerf?: { channels: Record<string, RTCDataChannel> };
    };
    const ch = w.__breezePerf?.channels?.control;
    if (!ch || ch.readyState !== 'open') return false;
    try {
      ch.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }, msg);
}

export const setBitrate = (page: Page, bps: number) =>
  sendControl(page, { type: 'set_bitrate', value: bps });
export const setFps = (page: Page, fps: number) =>
  sendControl(page, { type: 'set_fps', value: fps });
export const requestKeyframe = (page: Page) =>
  sendControl(page, { type: 'request_keyframe' });
