import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { API_URL, authHeaders, defaultThresholds } from '../config.js';

// Custom metrics
const listFailRate = new Rate('device_list_failures');
const listDuration = new Trend('device_list_duration', true);

export const options = {
  stages: [
    { duration: '30s', target: 25 },   // Ramp to 25 VUs
    { duration: '30s', target: 100 },  // Ramp to 100 VUs
    { duration: '3m', target: 100 },   // Hold at 100 VUs for 3 minutes
    { duration: '30s', target: 0 },    // Ramp down
  ],
  thresholds: {
    ...defaultThresholds,
    http_req_duration: ['p(95)<1000'],  // p95 < 1s
    http_req_failed: ['rate<0.01'],     // < 1% error rate
    device_list_failures: ['rate<0.01'],
  },
};

export default function () {
  // Vary query parameters to avoid caching bias
  const page = Math.floor(Math.random() * 10) + 1;
  const limit = [25, 50, 100][Math.floor(Math.random() * 3)];
  const sortFields = ['hostname', 'lastSeen', 'status', 'os'];
  const sort = sortFields[Math.floor(Math.random() * sortFields.length)];
  const order = Math.random() > 0.5 ? 'asc' : 'desc';

  const url = `${API_URL}/devices?page=${page}&limit=${limit}&sort=${sort}&order=${order}`;

  const res = http.get(url, {
    headers: authHeaders(),
    tags: { name: 'device_list' },
    timeout: '10s',
  });

  listDuration.add(res.timings.duration);

  const success = check(res, {
    'status is 200': (r) => r.status === 200,
    'response is JSON': (r) => {
      try {
        JSON.parse(r.body);
        return true;
      } catch {
        return false;
      }
    },
    'response has data array': (r) => {
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body.data) || Array.isArray(body.devices) || Array.isArray(body);
      } catch {
        return false;
      }
    },
    'response time < 1s': (r) => r.timings.duration < 1000,
  });

  listFailRate.add(!success);

  // Simulate dashboard user browsing pages
  sleep(Math.random() * 3 + 1); // 1-4 seconds
}

export function handleSummary(data) {
  const p95 = data.metrics.http_req_duration.values['p(95)'];
  const errorRate = data.metrics.http_req_failed.values.rate;
  const totalReqs = data.metrics.http_reqs.values.count;

  console.log(`\n=== Device List Load Test Summary ===`);
  console.log(`Total requests:  ${totalReqs}`);
  console.log(`p95 latency:     ${p95.toFixed(2)}ms`);
  console.log(`Error rate:      ${(errorRate * 100).toFixed(3)}%`);
  console.log(`=====================================\n`);

  return {
    stdout: JSON.stringify(data, null, 2),
  };
}
