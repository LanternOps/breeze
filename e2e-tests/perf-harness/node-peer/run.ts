/**
 * Headless Node WebRTC peer that connects to a Breeze remote-desktop session and
 * measures inbound H264 streaming performance. Stands in for the native Tauri
 * viewer (which can't be automated) so agent code changes can be A/B compared.
 *
 * Uses **werift** (pure-TypeScript WebRTC): it exposes the raw inbound RTP
 * stream (track.onReceiveRtp) and getStats(), which @roamhq/wrtc / node-datachannel
 * do not surface as cleanly — we need per-packet timing to derive fps/freeze/jitter
 * without a decoder.
 *
 * Run (from e2e-tests/):
 *   RD_DEVICE_ID=<device-uuid> \
 *   RD_LABEL=baseline RD_DURATION_SEC=30 \
 *   npx tsx perf-harness/node-peer/run.ts
 *
 * Env:
 *   RD_DEVICE_ID     target device UUID (required)
 *   RD_LABEL         run label, e.g. "baseline" / "amf-fix"    (default "node-peer")
 *   RD_MACHINE       machine id                                (default os.hostname())
 *   RD_DURATION_SEC  capture seconds                           (default 30)
 *   RD_OUTPUT        output JSON path        (default perf-harness/results/<label>-<ts>.json)
 *   RD_BASE_URL      API base                (default http://localhost:32797/api/v1)
 *   RD_ADMIN_EMAIL   admin email             (default admin@breeze.local)
 *   RD_ADMIN_PASSWORD admin password         (default BreezeAdmin123!)
 *   RD_DRIVE         optional control-channel commands to send once connected,
 *                    comma-separated, e.g. "set_bitrate=8000000,set_fps=30,request_keyframe"
 */
import os from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
// werift's ESM build (lib/index.mjs) has a broken `import nodeIp from "ip"`
// interop under Node ESM. Load the CJS build instead via createRequire; the
// type-only imports below are erased at runtime and don't touch the .mjs.
import type {
  RTCPeerConnection as RTCPeerConnectionInstance,
  MediaStreamTrack,
} from 'werift';
const weriftRequire = createRequire(import.meta.url);
const { RTCPeerConnection, RTCRtpCodecParameters, RTCRtcpFeedback } =
  weriftRequire('werift') as typeof import('werift');
import type { PerfResult, StatsSample } from '../types';
import { summarize } from '../summarize';
import { RtpStatsAccumulator } from './rtpStats';
import {
  type SignalingConfig,
  type WeriftIceServer,
  login,
  createDesktopSession,
  getViewerToken,
  fetchIceServers,
  postOffer,
  pollForAnswer,
} from './signaling';

const HERE = dirname(fileURLToPath(import.meta.url));

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v == null || v === '' ? fallback : v;
}

/**
 * H264 recv codec advertised in our offer so the agent's answer selects H264.
 * Return type is inferred as werift's RTCRtpCodecParameters (the DOM lib defines
 * a same-named global that would shadow it if annotated explicitly).
 */
function h264Codec() {
  return new RTCRtpCodecParameters({
    mimeType: 'video/H264',
    clockRate: 90000,
    rtcpFeedback: [
      new RTCRtcpFeedback({ type: 'nack' }),
      new RTCRtcpFeedback({ type: 'nack', parameter: 'pli' }),
      new RTCRtcpFeedback({ type: 'goog-remb' }),
      new RTCRtcpFeedback({ type: 'ccm', parameter: 'fir' }),
    ],
    parameters: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f',
  });
}

/** Pull the selected candidate-pair RTT (seconds) from getStats, if available. */
async function readRttSec(pc: RTCPeerConnectionInstance): Promise<number | null> {
  try {
    const report = await pc.getStats();
    let rtt: number | null = null;
    for (const s of report.values()) {
      const any = s as { type: string; nominated?: boolean; state?: string; currentRoundTripTime?: number };
      if (any.type === 'candidate-pair' && typeof any.currentRoundTripTime === 'number') {
        // Prefer a nominated/succeeded pair; otherwise take any as fallback.
        if (any.nominated || any.state === 'succeeded' || rtt === null) {
          rtt = any.currentRoundTripTime;
        }
      }
    }
    return rtt;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const cfg: SignalingConfig = {
    baseUrl: env('RD_BASE_URL', 'http://localhost:32797/api/v1'),
    adminEmail: env('RD_ADMIN_EMAIL', 'admin@breeze.local'),
    adminPassword: env('RD_ADMIN_PASSWORD', 'BreezeAdmin123!'),
    deviceId: env('RD_DEVICE_ID', ''),
  };
  if (!cfg.deviceId) {
    console.error('RD_DEVICE_ID is required');
    process.exit(2);
  }

  const label = env('RD_LABEL', 'node-peer');
  const machine = env('RD_MACHINE', os.hostname());
  const durationSec = Number(env('RD_DURATION_SEC', '30'));
  // RD_INPUT_HZ: if >0, flood the input data channel with mouse_move events at
  // this rate (plus periodic key/click bursts) for the run. Load generator to
  // validate Change #9 — input injection off the SCTP goroutine must not stall
  // video (skip/drop stays 0). Not a correctness check (right char typed still
  // needs a human in the viewer); it proves the worker accepts input under load.
  const inputHz = Number(env('RD_INPUT_HZ', '0'));
  const timestamp = new Date().toISOString();
  const outPath = env(
    'RD_OUTPUT',
    join(HERE, '..', 'results', `${label}-${timestamp.replace(/[:.]/g, '-')}.json`),
  );
  const driveCmds = env('RD_DRIVE', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const notes: string[] = [];
  const samples: StatsSample[] = [];
  const acc = new RtpStatsAccumulator();

  console.log(`[node-peer] device=${cfg.deviceId} label=${label} duration=${durationSec}s`);

  // ── Signaling (steps 1-4) ────────────────────────────────────────────────
  const accessToken = await login(cfg);
  const sessionId = await createDesktopSession(cfg, accessToken);
  console.log(`[node-peer] session created: ${sessionId}`);
  const viewerToken = await getViewerToken(cfg, accessToken, sessionId);
  const iceServers: WeriftIceServer[] = await fetchIceServers(cfg, viewerToken, sessionId);
  console.log(`[node-peer] ICE servers: ${iceServers.map((s) => s.urls).join(', ')}`);

  // ── Peer connection (mirrors apps/viewer/src/lib/webrtc.ts) ──────────────
  const pc = new RTCPeerConnection({
    iceServers,
    codecs: { video: [h264Codec()] },
  });

  let firstPacketAt: number | null = null;
  let trackSsrc: number | undefined;

  pc.onTrack.subscribe((track: MediaStreamTrack) => {
    if (track.kind !== 'video') return;
    console.log(`[node-peer] inbound track: kind=${track.kind} codec=${track.codec?.mimeType ?? '?'}`);
    track.onReceiveRtp.subscribe((rtp) => {
      if (firstPacketAt === null) {
        firstPacketAt = Date.now();
        trackSsrc = rtp.header.ssrc;
        console.log(`[node-peer] first RTP packet received (ssrc=${trackSsrc})`);
      }
      acc.onPacket(rtp);
    });
  });

  // recvonly video + input/control data channels — same labels/ordering as the viewer.
  pc.addTransceiver('video', { direction: 'recvonly' });
  const inputChannel = pc.createDataChannel('input', { ordered: true, maxRetransmits: 0 });
  const controlChannel = pc.createDataChannel('control', { ordered: true });

  pc.connectionStateChange.subscribe((state) => {
    console.log(`[node-peer] connection state: ${state}`);
  });

  // Drive commands are sent 2s after the channel opens (not immediately) —
  // a send racing the agent's OnMessage attach can be dropped — and re-sent
  // once mid-run since they're idempotent.
  const sendDriveCmds = () => {
    if (driveCmds.length === 0) return;
    for (const cmd of driveCmds) {
      const [type, rawVal] = cmd.split('=');
      const msg: Record<string, unknown> = { type };
      if (rawVal != null && rawVal !== '') msg.value = Number(rawVal);
      controlChannel.send(Buffer.from(JSON.stringify(msg)));
      console.log(`[node-peer] control -> ${JSON.stringify(msg)}`);
    }
  };
  controlChannel.onopen = () => {
    setTimeout(sendDriveCmds, 2000);
    setTimeout(sendDriveCmds, 7000);
  };

  // Optional input load generator (Change #9 validation). Sends mouse_move at
  // inputHz plus a key press + a click every second, in bursts, so the agent's
  // input worker is exercised concurrently with video capture/encode.
  let inputSent = 0;
  if (inputHz > 0) {
    inputChannel.onopen = () => {
      const period = Math.max(5, Math.round(1000 / inputHz));
      let tick = 0;
      const iv = setInterval(() => {
        // Sweep the cursor in a small box to force many distinct positions.
        const x = 200 + (tick % 400);
        const y = 200 + ((tick * 7) % 300);
        inputChannel.send(Buffer.from(JSON.stringify({ type: 'mouse_move', x, y })));
        inputSent++;
        // Once per ~second, a harmless key tap (shift, no side effects) + a
        // right-click-free scroll to exercise the never-coalesce path.
        if (tick % inputHz === 0) {
          inputChannel.send(Buffer.from(JSON.stringify({ type: 'key_down', key: 'shift' })));
          inputChannel.send(Buffer.from(JSON.stringify({ type: 'key_up', key: 'shift' })));
          inputChannel.send(Buffer.from(JSON.stringify({ type: 'mouse_scroll', x, y, delta: 40 })));
          inputSent += 3;
        }
        tick++;
      }, period);
      setTimeout(() => clearInterval(iv), durationSec * 1000);
    };
  }

  // ── Offer / ICE gather / answer (steps 5-7) ──────────────────────────────
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGathering(pc, 3000);

  const localSdp = pc.localDescription?.sdp;
  if (!localSdp) throw new Error('failed to generate local SDP offer');

  await postOffer(cfg, viewerToken, sessionId, localSdp);
  console.log('[node-peer] offer submitted, polling for answer...');
  const answerSdp = await pollForAnswer(cfg, viewerToken, sessionId, 15000);
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  console.log('[node-peer] answer applied, waiting for media...');

  // ── Capture loop: ~1Hz snapshots for durationSec ─────────────────────────
  const captureStart = Date.now();
  const captureEnd = captureStart + durationSec * 1000;
  while (Date.now() < captureEnd) {
    await new Promise((r) => setTimeout(r, 1000));
    const rtt = await readRttSec(pc);
    const sample = acc.sample(rtt);
    samples.push(sample);
    process.stdout.write(
      `\r[node-peer] t=${Math.round(sample.tMs / 1000)}s frames=${sample.framesReceived} ` +
        `fps=${sample.framesPerSecond?.toFixed(1) ?? '-'} ` +
        `kbps=${((acc.bytes * 8) / 1000 / Math.max(1, sample.tMs / 1000)).toFixed(0)} ` +
        `lost=${sample.packetsLost} freeze=${sample.freezeCount}   `,
    );
  }
  process.stdout.write('\n');

  await pc.close();

  // ── Result ───────────────────────────────────────────────────────────────
  const capturedLiveVideo = acc.hasVideo();
  if (!capturedLiveVideo) {
    notes.push('No inbound video RTP received — session established but no frames arrived.');
  }
  const pctLost = acc.packetsLostPct();
  if (pctLost != null) notes.push(`packetsLostPct=${pctLost.toFixed(3)}%`);
  notes.push(`Frames (marker bits) received: ${acc.frames}; total bytes: ${acc.bytes}`);
  notes.push('framesDropped is null: headless peer has no decoder, decode-drops are unobservable.');

  const result: PerfResult = {
    machine,
    label,
    timestamp,
    durationSec,
    deviceId: cfg.deviceId,
    viewerUrl: `node-peer://${cfg.deviceId}`,
    capturedLiveVideo,
    notes,
    samples,
    summary: summarize(samples, acc.frameArrivalSeries()),
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(result, null, 2));

  console.log('\n[node-peer] summary:', JSON.stringify(result.summary, null, 2));
  if (inputHz > 0) console.log(`[node-peer] input events sent: ${inputSent}`);
  console.log(`[node-peer] wrote ${outPath}`);

  // Non-zero exit if the plumbing worked but no frames arrived, so CI/A-B
  // scripts can distinguish a real capture from an empty one.
  process.exit(capturedLiveVideo ? 0 : 1);
}

function waitForIceGathering(pc: RTCPeerConnectionInstance, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeoutMs);
    pc.iceGatheringStateChange.subscribe((state) => {
      if (state === 'complete') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

main().catch((err) => {
  console.error('\n[node-peer] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
