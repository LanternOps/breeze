import { describe, it, expect } from 'vitest';
import { statsOverlayRows } from './statsOverlay';

const sample = {
  rttMs: 42,
  kbps: 2500,
  lossPct: 1.5,
  codec: 'H264',
  decoder: 'VideoToolbox',
  iceLocal: 'relay/udp',
  iceRemote: 'srflx',
};

describe('stats overlay rows', () => {
  it('WebRTC shows RTT, fps, bitrate, loss, codec + decoder and the ICE path', () => {
    expect(statsOverlayRows({ transport: 'webrtc', fps: 58, sample })).toEqual([
      ['Transport', 'WebRTC · relay/udp → srflx'],
      ['RTT', '42 ms'],
      ['FPS', '58'],
      ['Bitrate', '2.5 Mbps'],
      ['Loss', '1.5%'],
      ['Codec', 'H264 · VideoToolbox'],
    ]);
  });

  it('shows dashes, not zeros, before the first sample', () => {
    const rows = statsOverlayRows({ transport: 'webrtc', fps: 0, sample: null });
    expect(rows).toContainEqual(['RTT', '—']);
    expect(rows).toContainEqual(['Bitrate', '—']);
    expect(rows).toContainEqual(['Loss', '—']);
    expect(rows).toContainEqual(['Transport', 'WebRTC']);
  });

  it('formats low bitrates in kbps and unknown codec/decoder as a dash', () => {
    const rows = statsOverlayRows({ transport: 'webrtc', fps: 30, sample: { ...sample, kbps: 640, codec: '', decoder: '', lossPct: null } });
    expect(rows).toContainEqual(['Bitrate', '640 kbps']);
    expect(rows).toContainEqual(['Codec', '—']);
    expect(rows).toContainEqual(['Loss', '—']);
  });

  it('the fallback transports only have a frame rate to show', () => {
    expect(statsOverlayRows({ transport: 'websocket', fps: 12, sample: null })).toEqual([
      ['Transport', 'WebSocket (JPEG)'],
      ['FPS', '12'],
    ]);
    expect(statsOverlayRows({ transport: 'vnc', fps: 0, sample: null })).toEqual([
      ['Transport', 'VNC'],
    ]);
  });
});
