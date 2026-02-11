import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { API_URL, defaultThresholds } from '../config.js';

// Custom metrics
const loginFailRate = new Rate('login_failures');
const loginDuration = new Trend('login_duration', true);

export const options = {
  stages: [
    { duration: '1m', target: 50 },   // Ramp up to 50 VUs over 1 minute
    { duration: '2m', target: 50 },   // Hold at 50 VUs for 2 minutes
    { duration: '30s', target: 0 },   // Ramp down over 30 seconds
  ],
  thresholds: {
    ...defaultThresholds,
    http_req_duration: ['p(95)<500'],  // p95 response time < 500ms
    http_req_failed: ['rate<0.01'],    // Error rate < 1%
    login_failures: ['rate<0.01'],
  },
};

const TEST_EMAIL = __ENV.TEST_EMAIL || 'loadtest@breeze.local';
const TEST_PASSWORD = __ENV.TEST_PASSWORD || 'LoadTest123!';

export default function () {
  const payload = JSON.stringify({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });

  const params = {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'login' },
  };

  const res = http.post(`${API_URL}/auth/login`, payload, params);

  loginDuration.add(res.timings.duration);

  const success = check(res, {
    'status is 200': (r) => r.status === 200,
    'response has token': (r) => {
      try {
        const body = JSON.parse(r.body);
        return !!body.token || !!body.accessToken;
      } catch {
        return false;
      }
    },
    'response time < 500ms': (r) => r.timings.duration < 500,
  });

  loginFailRate.add(!success);

  // Simulate realistic user think time between requests
  sleep(Math.random() * 2 + 1); // 1-3 seconds
}

export function handleSummary(data) {
  const p95 = data.metrics.http_req_duration.values['p(95)'];
  const errorRate = data.metrics.http_req_failed.values.rate;
  const totalReqs = data.metrics.http_reqs.values.count;

  console.log(`\n=== Auth Load Test Summary ===`);
  console.log(`Total requests:  ${totalReqs}`);
  console.log(`p95 latency:     ${p95.toFixed(2)}ms`);
  console.log(`Error rate:      ${(errorRate * 100).toFixed(3)}%`);
  console.log(`==============================\n`);

  return {
    stdout: JSON.stringify(data, null, 2),
  };
}
