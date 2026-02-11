import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { API_URL, authHeaders, defaultThresholds } from '../config.js';

// Custom metrics
const dispatchFailRate = new Rate('command_dispatch_failures');
const dispatchDuration = new Trend('command_dispatch_duration', true);
const dispatchCount = new Counter('commands_dispatched');

export const options = {
  stages: [
    { duration: '30s', target: 10 },   // Warm up
    { duration: '30s', target: 50 },   // Ramp to 50 VUs
    { duration: '2m', target: 50 },    // Hold at 50 concurrent command dispatchers
    { duration: '30s', target: 0 },    // Ramp down
  ],
  thresholds: {
    ...defaultThresholds,
    http_req_duration: ['p(95)<1000'],  // p95 < 1s
    http_req_failed: ['rate<0.01'],
    command_dispatch_failures: ['rate<0.01'],
  },
};

// Pre-defined device IDs. In a real test, populate this array with actual
// device IDs from your staging environment, or pass via DEVICE_IDS env var.
function getDeviceIds() {
  if (__ENV.DEVICE_IDS) {
    return __ENV.DEVICE_IDS.split(',');
  }
  if (__ENV.DEVICE_ID) {
    return [__ENV.DEVICE_ID];
  }
  // Fallback: generate synthetic IDs (will return 404 unless devices exist)
  return Array.from({ length: 20 }, (_, i) => `load-test-device-${i}`);
}

const deviceIds = getDeviceIds();

// Command types to rotate through
const commandTypes = [
  {
    type: 'shell',
    payload: { command: 'echo "heartbeat check"', shell: 'bash', timeout: 30 },
  },
  {
    type: 'shell',
    payload: { command: 'hostname', shell: 'bash', timeout: 10 },
  },
  {
    type: 'shell',
    payload: { command: 'uptime', shell: 'bash', timeout: 10 },
  },
  {
    type: 'shell',
    payload: { command: 'df -h', shell: 'bash', timeout: 15 },
  },
];

export default function () {
  // Pick a random device and command type
  const deviceId = deviceIds[Math.floor(Math.random() * deviceIds.length)];
  const cmd = commandTypes[Math.floor(Math.random() * commandTypes.length)];

  const payload = JSON.stringify({
    type: cmd.type,
    payload: cmd.payload,
  });

  const res = http.post(
    `${API_URL}/devices/${deviceId}/commands`,
    payload,
    {
      headers: authHeaders(),
      tags: { name: 'command_dispatch' },
      timeout: '10s',
    }
  );

  dispatchDuration.add(res.timings.duration);
  dispatchCount.add(1);

  const success = check(res, {
    'status is 200 or 201': (r) => r.status === 200 || r.status === 201,
    'response has command id': (r) => {
      try {
        const body = JSON.parse(r.body);
        return !!body.id || !!body.commandId;
      } catch {
        return false;
      }
    },
    'response time < 1s': (r) => r.timings.duration < 1000,
  });

  dispatchFailRate.add(!success);

  // Simulate operator cadence between commands
  sleep(Math.random() * 2 + 0.5); // 0.5-2.5 seconds
}

export function handleSummary(data) {
  const p95 = data.metrics.http_req_duration.values['p(95)'];
  const errorRate = data.metrics.http_req_failed.values.rate;
  const totalReqs = data.metrics.http_reqs.values.count;

  console.log(`\n=== Command Dispatch Load Test Summary ===`);
  console.log(`Total commands:  ${totalReqs}`);
  console.log(`p95 latency:     ${p95.toFixed(2)}ms`);
  console.log(`Error rate:      ${(errorRate * 100).toFixed(3)}%`);
  console.log(`==========================================\n`);

  return {
    stdout: JSON.stringify(data, null, 2),
  };
}
