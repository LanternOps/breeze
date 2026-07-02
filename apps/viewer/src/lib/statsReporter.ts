// WebRTC stats reporter — polls RTCPeerConnection.getStats() and ships a
// viewer_stats message to the agent over the control DataChannel every tick.
// These messages are the ONLY input to the agent's adaptive bitrate
// controller: if they stop, the stream freezes at whatever bitrate it last
// had (a fresh session starts at 2.5 Mbps — visible artifacting/ghosting at
// 1440p60).
//
// The reporter reads the CURRENT connection from getConnection() on every
// tick instead of capturing pc/channel once. The previous inline effect in
// DesktopViewer captured them at effect-run time, so a viewer auto-reconnect
// (new RTCPeerConnection, same React deps) left it polling the dead pc with
// a silent catch — stats stopped for the rest of the session.

export interface StatsConnection {
  pc: RTCPeerConnection;
  controlChannel: RTCDataChannel;
}

export interface StatsReporterOptions {
  getConnection: () => StatsConnection | null | undefined;
  intervalMs?: number;
  /** Receives a one-line human-readable summary per tick (console logging). */
  log?: (summary: string) => void;
}

/** Starts polling; returns a stop() function that clears the interval. */
export function createStatsReporter(opts: StatsReporterOptions): () => void {
  const { getConnection, intervalMs = 1000, log } = opts;

  // Delta baselines, keyed to the pc identity they were read from. A new pc
  // starts its RTC counters from zero, so carrying baselines across a
  // reconnect would produce one garbage (negative) delta sample.
  let prevPc: RTCPeerConnection | null = null;
  let prevBytesReceived = 0;
  let prevTimestamp = 0;
  let prevPacketsLost = 0;
  let prevPacketsReceived = 0;
  let prevFramesDropped = 0;

  const interval = setInterval(async () => {
    const conn = getConnection();
    if (!conn) return;
    const { pc, controlChannel: ch } = conn;
    if (pc !== prevPc) {
      prevPc = pc;
      prevBytesReceived = 0;
      prevTimestamp = 0;
      prevPacketsLost = 0;
      prevPacketsReceived = 0;
      prevFramesDropped = 0;
    }
    try {
      const stats = await pc.getStats();
      let rttMs = 0;
      let localType = '', remoteType = '', protocol = '';
      let framesReceived = 0, framesDecoded = 0, framesDropped = 0;
      let jitterMs = 0, packetsLost = 0, packetsReceived = 0, kbps = 0;

      stats.forEach((report: Record<string, unknown>) => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          rttMs = typeof report.currentRoundTripTime === 'number'
            ? Math.round(report.currentRoundTripTime * 1000) : 0;
          const localId = report.localCandidateId as string;
          const remoteId = report.remoteCandidateId as string;
          stats.forEach((r: Record<string, unknown>) => {
            if (r.id === localId) { localType = r.candidateType as string; protocol = r.protocol as string; }
            if (r.id === remoteId) { remoteType = r.candidateType as string; }
          });
        }
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          const bytesNow = (report.bytesReceived as number) || 0;
          const tsNow = (report.timestamp as number) || 0;
          if (prevTimestamp > 0 && tsNow > prevTimestamp) {
            kbps = Math.round(((bytesNow - prevBytesReceived) * 8) / (tsNow - prevTimestamp));
          }
          prevBytesReceived = bytesNow;
          prevTimestamp = tsNow;
          framesReceived = (report.framesReceived as number) ?? 0;
          framesDecoded = (report.framesDecoded as number) ?? 0;
          framesDropped = (report.framesDropped as number) ?? 0;
          jitterMs = typeof report.jitter === 'number' ? Math.round(report.jitter * 1000) : 0;
          packetsLost = (report.packetsLost as number) ?? 0;
          packetsReceived = (report.packetsReceived as number) ?? 0;
        }
      });

      log?.(
        `local=${localType}/${protocol} remote=${remoteType} rtt=${rttMs}ms | ` +
        `frames=${framesReceived} decoded=${framesDecoded} dropped=${framesDropped} ` +
        `jitter=${jitterMs}ms pktLost=${packetsLost} kbps=${kbps}`
      );

      // Send to agent via control channel so stats appear in agent_logs
      // and drive the adaptive bitrate controller.
      if (ch && ch.readyState === 'open') {
        ch.send(JSON.stringify({
          type: 'viewer_stats',
          rttMs,
          jitterMs,
          packetsLost,
          packetsLostDelta: packetsLost - prevPacketsLost,
          packetsReceived,
          packetsReceivedDelta: packetsReceived - prevPacketsReceived,
          framesReceived,
          framesDecoded,
          framesDropped,
          framesDroppedDelta: framesDropped - prevFramesDropped,
          kbps,
          iceLocal: `${localType}/${protocol}`,
          iceRemote: remoteType,
        }));
      }
      prevPacketsLost = packetsLost;
      prevPacketsReceived = packetsReceived;
      prevFramesDropped = framesDropped;
    } catch {
      // pc might be closed mid-poll; next tick re-reads the current connection.
    }
  }, intervalMs);

  return () => clearInterval(interval);
}
