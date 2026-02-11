import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { API_URL, agentHeaders, agentThresholds } from '../config.js';

// Custom metrics
const heartbeatFailRate = new Rate('heartbeat_failures');
const heartbeatDuration = new Trend('heartbeat_duration', true);
const heartbeatCount = new Counter('heartbeat_total');

// Detect stress mode: k6 run scenarios/heartbeat.js -e STRESS=true
const isStress = __ENV.STRESS === 'true';

export const options = {
  stages: isStress
    ? [
        // Stress profile — push beyond expected capacity
        { duration: '2m', target: 2000 },
        { duration: '5m', target: 5000 },
        { duration: '5m', target: 10000 },
        { duration: '5m', target: 15000 },
        { duration: '2m', target: 0 },
      ]
    : [
        // Standard load profile — simulate 10,000 agents
        { duration: '2m', target: 1000 },   // Ramp to 1,000 agents
        { duration: '5m', target: 1000 },   // Hold
        { duration: '2m', target: 5000 },   // Ramp to 5,000 agents
        { duration: '5m', target: 5000 },   // Hold
        { duration: '2m', target: 10000 },  // Ramp to 10,000 agents
        { duration: '5m', target: 10000 },  // Hold
        { duration: '2m', target: 0 },      // Ramp down
      ],
  thresholds: {
    ...agentThresholds,
    http_req_duration: ['p(99)<2000'],    // p99 < 2s
    http_req_failed: ['rate<0.001'],      // < 0.1% error rate
    heartbeat_failures: ['rate<0.001'],
  },
};

// Each VU simulates one agent. The VU number serves as a pseudo-agent ID.
// In a real test you would pre-seed device IDs and agent tokens.
export default function () {
  const agentId = __ENV.DEVICE_ID || `load-test-agent-${__VU}`;

  const payload = JSON.stringify({
    hostname: `agent-${__VU}.breeze.local`,
    os: 'linux',
    osVersion: 'Ubuntu 22.04',
    arch: 'amd64',
    agentVersion: '1.0.0',
    uptime: Math.floor(Math.random() * 864000),
    cpuPercent: parseFloat((Math.random() * 100).toFixed(1)),
    memoryPercent: parseFloat((Math.random() * 100).toFixed(1)),
    diskPercent: parseFloat((Math.random() * 100).toFixed(1)),
    publicIp: `10.0.${Math.floor(__VU / 256)}.${__VU % 256}`,
  });

  const res = http.post(
    `${API_URL}/agents/${agentId}/heartbeat`,
    payload,
    {
      headers: agentHeaders(),
      tags: { name: 'heartbeat' },
      timeout: '10s',
    }
  );

  heartbeatDuration.add(res.timings.duration);
  heartbeatCount.add(1);

  const success = check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 2s': (r) => r.timings.duration < 2000,
  });

  heartbeatFailRate.add(!success);

  // Agents send heartbeats every 60 seconds. Sleep to simulate this cadence.
  // In k6 each iteration is one heartbeat, so we sleep 60s minus the request
  // time to approximate real interval. For shorter test runs, reduce this.
  const interval = __ENV.HEARTBEAT_INTERVAL
    ? parseInt(__ENV.HEARTBEAT_INTERVAL, 10)
    : 60;
  sleep(Math.max(1, interval - res.timings.duration / 1000));
}

export function handleSummary(data) {
  const p99 = data.metrics.http_req_duration.values['p(99)'];
  const errorRate = data.metrics.http_req_failed.values.rate;
  const totalReqs = data.metrics.http_reqs.values.count;

  console.log(`\n=== Heartbeat Load Test Summary ===`);
  console.log(`Mode:            ${isStress ? 'STRESS' : 'LOAD'}`);
  console.log(`Total heartbeats: ${totalReqs}`);
  console.log(`p99 latency:     ${p99.toFixed(2)}ms`);
  console.log(`Error rate:      ${(errorRate * 100).toFixed(4)}%`);
  console.log(`===================================\n`);

  return {
    stdout: JSON.stringify(data, null, 2),
  };
}
