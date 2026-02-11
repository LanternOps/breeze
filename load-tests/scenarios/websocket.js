import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { WS_API_URL } from '../config.js';

// Custom metrics
const wsConnectFailRate = new Rate('ws_connect_failures');
const wsConnectDuration = new Trend('ws_connect_duration', true);
const wsMessagesSent = new Counter('ws_messages_sent');
const wsMessagesReceived = new Counter('ws_messages_received');

export const options = {
  stages: [
    { duration: '1m', target: 100 },    // Ramp to 100 concurrent connections
    { duration: '1m', target: 500 },    // Ramp to 500 concurrent connections
    { duration: '5m', target: 500 },    // Hold 500 connections for 5 minutes
    { duration: '1m', target: 0 },      // Ramp down
  ],
  thresholds: {
    ws_connect_failures: ['rate<0.05'],  // < 5% connection failure rate
    ws_connect_duration: ['p(95)<5000'], // Connection established within 5s
  },
};

const AGENT_TOKEN = __ENV.AGENT_TOKEN || '';

export default function () {
  const agentId = __ENV.DEVICE_ID || `load-test-agent-${__VU}`;
  const url = `${WS_API_URL}/agent-ws/${agentId}/ws`;

  // Build headers — the agent WebSocket accepts Authorization header or
  // ?token= query param. We use the header approach.
  const params = {
    headers: {
      Authorization: `Bearer ${AGENT_TOKEN}`,
    },
    tags: { name: 'agent_ws' },
  };

  const startTime = Date.now();

  const res = ws.connect(url, params, function (socket) {
    const connectTime = Date.now() - startTime;
    wsConnectDuration.add(connectTime);

    socket.on('open', function () {
      // Wait for server "connected" message before sending data
      // (avoids race condition documented in MEMORY.md)
    });

    socket.on('message', function (msg) {
      wsMessagesReceived.add(1);

      try {
        const data = JSON.parse(msg);

        // If server sends "connected" acknowledgment, start sending heartbeats
        if (data.type === 'connected' || data.type === 'welcome') {
          // Send initial heartbeat over WebSocket
          const heartbeat = JSON.stringify({
            type: 'heartbeat',
            agentId: agentId,
            hostname: `agent-${__VU}.breeze.local`,
            os: 'linux',
            agentVersion: '1.0.0',
            cpuPercent: parseFloat((Math.random() * 100).toFixed(1)),
            memoryPercent: parseFloat((Math.random() * 100).toFixed(1)),
          });
          socket.send(heartbeat);
          wsMessagesSent.add(1);
        }

        // Handle command requests from server
        if (data.type === 'command') {
          const result = JSON.stringify({
            type: 'command_result',
            commandId: data.commandId || data.id,
            status: 'completed',
            output: 'load test response',
            exitCode: 0,
          });
          socket.send(result);
          wsMessagesSent.add(1);
        }
      } catch {
        // Non-JSON message, ignore
      }
    });

    socket.on('error', function (e) {
      console.error(`WS error for agent ${agentId}: ${e.error()}`);
    });

    // Send periodic heartbeats over the WebSocket connection for the hold duration.
    // k6 WS connections stay open until socket.close() or timeout.
    const heartbeatInterval = __ENV.WS_HEARTBEAT_INTERVAL
      ? parseInt(__ENV.WS_HEARTBEAT_INTERVAL, 10)
      : 60;

    // Keep connection open and send periodic heartbeats
    // setInterval equivalent: send heartbeats for ~5 minutes
    const iterations = Math.floor(300 / heartbeatInterval); // ~5 min of heartbeats
    for (let i = 0; i < iterations; i++) {
      socket.setTimeout(function () {
        const heartbeat = JSON.stringify({
          type: 'heartbeat',
          agentId: agentId,
          hostname: `agent-${__VU}.breeze.local`,
          os: 'linux',
          agentVersion: '1.0.0',
          cpuPercent: parseFloat((Math.random() * 100).toFixed(1)),
          memoryPercent: parseFloat((Math.random() * 100).toFixed(1)),
        });
        socket.send(heartbeat);
        wsMessagesSent.add(1);
      }, heartbeatInterval * 1000 * (i + 1));
    }

    // Close connection after the test period
    socket.setTimeout(function () {
      socket.close();
    }, (iterations + 1) * heartbeatInterval * 1000);
  });

  const connected = check(res, {
    'WS connection status is 101': (r) => r && r.status === 101,
  });

  wsConnectFailRate.add(!connected);

  // Small pause between reconnection attempts if the VU loops
  sleep(1);
}

export function handleSummary(data) {
  const connectP95 = data.metrics.ws_connect_duration
    ? data.metrics.ws_connect_duration.values['p(95)']
    : 'N/A';
  const failRate = data.metrics.ws_connect_failures
    ? data.metrics.ws_connect_failures.values.rate
    : 'N/A';
  const sent = data.metrics.ws_messages_sent
    ? data.metrics.ws_messages_sent.values.count
    : 0;
  const received = data.metrics.ws_messages_received
    ? data.metrics.ws_messages_received.values.count
    : 0;

  console.log(`\n=== WebSocket Load Test Summary ===`);
  console.log(`Connect p95:     ${typeof connectP95 === 'number' ? connectP95.toFixed(2) + 'ms' : connectP95}`);
  console.log(`Connect fail %:  ${typeof failRate === 'number' ? (failRate * 100).toFixed(3) + '%' : failRate}`);
  console.log(`Messages sent:   ${sent}`);
  console.log(`Messages recv:   ${received}`);
  console.log(`===================================\n`);

  return {
    stdout: JSON.stringify(data, null, 2),
  };
}
