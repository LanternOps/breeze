/**
 * Client-side WebRTC stats capture for the Breeze remote-desktop viewer.
 *
 * The real viewer creates its RTCPeerConnection deep inside app code and does
 * NOT expose it on window (see apps/viewer/src/lib/webrtc.ts). Rather than
 * requiring an app change, we install an init script BEFORE any document loads
 * that wraps `window.RTCPeerConnection`, so every PC the page (or any same-origin
 * frame) constructs is stashed on `window.__breezePerf.pcs`. The poller then
 * calls `getStats()` on those instances.
 *
 * This wrapper is intentionally defensive: on a page that never creates a PC it
 * simply captures nothing, and the poller returns empty samples gracefully.
 */
import type { Page, BrowserContext } from '@playwright/test';
import type { StatsSample } from './types';

/**
 * Browser-side hook source, as a STRING (not a function).
 *
 * It MUST be a string: when a TS function is handed to `addInitScript`, tsx/
 * esbuild rewrites it with `__name(...)` keepNames helper calls that are
 * undefined in the page, so the injected script throws `__name is not defined`
 * and the wrap silently never installs. A string literal is passed verbatim by
 * Playwright and sidesteps compilation entirely.
 *
 * Behaviour: wrap `window.RTCPeerConnection` (+ webkit alias) with a Proxy whose
 * `construct` trap records every constructed PC on `window.__breezePerf.pcs` and
 * captures its data channels (input/control) on `window.__breezePerf.channels`.
 * The Proxy preserves prototype/instanceof/statics automatically. Idempotent
 * across frames/navigations; a no-op on pages that never create a PC.
 */
export const PC_HOOK_SOURCE = String.raw`
(() => {
  var w = window;
  if (w.__breezePerf && w.__breezePerf.installed) return;
  w.__breezePerf = { pcs: [], channels: {}, installed: true };

  function record(pc) {
    try {
      w.__breezePerf.pcs.push(pc);
      var origCreate = pc.createDataChannel.bind(pc);
      pc.createDataChannel = function (label, init) {
        var ch = origCreate(label, init);
        try { w.__breezePerf.channels[label] = ch; } catch (e) {}
        return ch;
      };
      pc.addEventListener('datachannel', function (ev) {
        var ch = ev.channel;
        if (ch && ch.label) w.__breezePerf.channels[ch.label] = ch;
      });
    } catch (e) {}
  }

  function wrap(Orig) {
    if (!Orig) return Orig;
    return new Proxy(Orig, {
      construct: function (target, args, newTarget) {
        var pc = Reflect.construct(target, args, newTarget);
        record(pc);
        return pc;
      }
    });
  }

  var std = wrap(w.RTCPeerConnection);
  if (std) w.RTCPeerConnection = std;
  var webkit = wrap(w.webkitRTCPeerConnection);
  if (webkit) w.webkitRTCPeerConnection = webkit;
})();
`;

/** Install the hook on a page or context. Call before navigation. */
export async function installStatsHook(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript(PC_HOOK_SOURCE);
}

/**
 * Read one snapshot from whatever RTCPeerConnections the hook has captured.
 * Returns cumulative counters; bitrate/percentages are derived in Node from the
 * series (see summarize.ts). Never throws into the harness — a page with no PC
 * yields a sample with hasInboundVideo=false and null metrics.
 */
export async function sampleStats(page: Page, tMs: number): Promise<StatsSample> {
  const raw = await page.evaluate(async () => {
    const w = window as unknown as { __breezePerf?: { pcs: RTCPeerConnection[] } };
    const pcs = w.__breezePerf?.pcs ?? [];
    const empty = {
      pcCount: pcs.length,
      hasInboundVideo: false,
      framesPerSecond: null as number | null,
      framesReceived: null as number | null,
      framesDropped: null as number | null,
      freezeCount: null as number | null,
      totalFreezesDuration: null as number | null,
      jitter: null as number | null,
      packetsLost: null as number | null,
      bytesReceived: null as number | null,
      currentRoundTripTime: null as number | null,
    };
    if (pcs.length === 0) return empty;

    // Prefer the PC that currently carries an inbound video track.
    for (const pc of pcs) {
      let report: RTCStatsReport;
      try {
        report = await pc.getStats();
      } catch {
        continue;
      }
      let inbound: Record<string, number> | null = null;
      let rtt: number | null = null;
      report.forEach((s: Record<string, unknown>) => {
        if (s.type === 'inbound-rtp' && s.kind === 'video') {
          inbound = s as unknown as Record<string, number>;
        }
        // Selected/nominated candidate pair carries the live RTT.
        if (
          s.type === 'candidate-pair' &&
          (s.nominated === true || s.selected === true || s.state === 'succeeded')
        ) {
          const v = (s as Record<string, unknown>).currentRoundTripTime;
          if (typeof v === 'number') rtt = v;
        }
      });
      if (inbound) {
        const i = inbound as Record<string, number>;
        return {
          pcCount: pcs.length,
          hasInboundVideo: true,
          framesPerSecond: i.framesPerSecond ?? null,
          framesReceived: i.framesReceived ?? null,
          framesDropped: i.framesDropped ?? null,
          freezeCount: i.freezeCount ?? null,
          totalFreezesDuration: i.totalFreezesDuration ?? null,
          jitter: i.jitter ?? null,
          packetsLost: i.packetsLost ?? null,
          bytesReceived: i.bytesReceived ?? null,
          currentRoundTripTime: rtt,
        };
      }
    }
    return empty;
  });

  return { tMs, ...raw };
}
