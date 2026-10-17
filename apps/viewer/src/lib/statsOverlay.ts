// Stats overlay (#8241): what the toggleable in-session overlay shows. The
// numbers come from the existing WebRTC stats reporter (lib/statsReporter.ts)
// and the frame counter; nothing new is measured or sent anywhere.

import type { StatsSample } from './statsReporter';

export type OverlayTransport = 'webrtc' | 'websocket' | 'vnc';

const DASH = '—';

function bitrate(kbps: number): string {
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`;
}

export function statsOverlayRows(input: {
  transport: OverlayTransport;
  fps: number;
  sample: StatsSample | null;
}): Array<[label: string, value: string]> {
  const { transport, fps, sample } = input;
  if (transport === 'vnc') {
    // noVNC draws frames itself; the viewer has no frame count for it.
    return [['Transport', 'VNC']];
  }
  if (transport === 'websocket') {
    return [['Transport', 'WebSocket (JPEG)'], ['FPS', String(fps)]];
  }
  const path = sample?.iceLocal ? ` · ${sample.iceLocal} → ${sample.iceRemote || DASH}` : '';
  const codec = [sample?.codec, sample?.decoder].filter(Boolean).join(' · ');
  return [
    ['Transport', `WebRTC${path}`],
    ['RTT', sample ? `${sample.rttMs} ms` : DASH],
    ['FPS', String(fps)],
    ['Bitrate', sample ? bitrate(sample.kbps) : DASH],
    ['Loss', sample && sample.lossPct !== null ? `${sample.lossPct}%` : DASH],
    ['Codec', codec || DASH],
  ];
}
