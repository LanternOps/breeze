import http from 'k6/http';
import { sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import {
  API_URL,
  INCREMENTAL_PAGE_LIMIT,
  INCREMENTAL_UPDATED_SINCE,
  PARTNER_API_CHECKPOINTS_JSON,
  PARTNER_API_EXPECTED_DEVICES,
  PARTNER_API_INCREMENTAL_EXPECTED_RECORDS,
  PARTNER_API_KEY,
  PARTNER_API_MAX_PAGES,
  PARTNER_API_MAX_RETRIES,
  PARTNER_API_MODE,
  PARTNER_API_PAGE_LIMIT,
  PARTNER_API_SUMMARY_FILE,
  partnerApiHeaders,
} from '../config.js';

const RESOURCES = Object.freeze([
  'organizations',
  'sites',
  'devices',
  'device-inventory',
  'device-software',
  'device-relationships',
  'configuration-policies',
  'configuration-assignments',
  'scripts',
  'automations',
  'backup-configurations',
  'custom-fields',
  'custom-field-values',
]);

const PAGE_LIMIT = boundedInteger(PARTNER_API_PAGE_LIMIT, 1, 500, 500);
const INCREMENTAL_LIMIT = boundedInteger(INCREMENTAL_PAGE_LIMIT, 1, 500, 500);
const EXPECTED_DEVICES = boundedInteger(PARTNER_API_EXPECTED_DEVICES, 1, 1000000, 10000);
const EXPECTED_INCREMENTAL_RECORDS = boundedInteger(
  PARTNER_API_INCREMENTAL_EXPECTED_RECORDS,
  0,
  1000000,
  0,
);
const MAX_RETRIES = boundedInteger(PARTNER_API_MAX_RETRIES, 0, 10, 5);
const MAX_PAGES = boundedInteger(PARTNER_API_MAX_PAGES, 1, 1000000, 100000);
const INCREMENTAL_BUDGET_MS = 15 * 60 * 1000;
const MODES = Object.freeze(['full', 'incremental', 'both']);
const MODE = MODES.includes(PARTNER_API_MODE) ? PARTNER_API_MODE : 'invalid';
const RUNS_FULL = MODE === 'full' || MODE === 'both';
const RUNS_INCREMENTAL = MODE === 'incremental' || MODE === 'both';
const SUMMARY_FILE = /^[A-Za-z0-9._-]+$/u.test(PARTNER_API_SUMMARY_FILE)
  ? PARTNER_API_SUMMARY_FILE
  : 'partner-api-export-summary.json';

const bytes = new Counter('partner_export_bytes');
const pages = new Counter('partner_export_pages');
const records = new Counter('partner_export_records');
const retries = new Counter('partner_export_retries');
const rateLimited = new Counter('partner_export_429');
const serverErrors = new Counter('partner_export_5xx');
const poolSaturation = new Counter('partner_export_pool_saturation');
const contractFailures = new Counter('partner_export_contract_failures');
const duplicateRecords = new Counter('partner_export_duplicate_records');
const snapshotChanges = new Counter('partner_export_snapshot_changes');
const traversalDuration = new Trend('partner_export_traversal_duration', true);
const pageDuration = new Trend('partner_export_page_duration', true);
const fullDuration = new Trend('partner_export_full_duration', true);
const incrementalDuration = new Trend('partner_export_incremental_duration', true);
const checkpointMetric = new Trend('partner_export_checkpoint', false);

const perResourceEvidenceThresholds = {};
for (const resource of RESOURCES) {
  for (const mode of ['full', 'incremental'].filter((candidate) => (
    candidate === 'full' ? RUNS_FULL : RUNS_INCREMENTAL
  ))) {
    const selector = `resource:${resource},mode:${mode}`;
    perResourceEvidenceThresholds[`partner_export_page_duration{${selector}}`] = ['max>=0'];
    perResourceEvidenceThresholds[`partner_export_traversal_duration{${selector}}`] = mode === 'incremental'
      ? ['max<900000']
      : ['max>=0'];
    perResourceEvidenceThresholds[`partner_export_pages{${selector}}`] = ['count>0'];
    perResourceEvidenceThresholds[`partner_export_records{${selector}}`] = mode === 'incremental'
      && EXPECTED_INCREMENTAL_RECORDS > 0
      ? [`count>=${EXPECTED_INCREMENTAL_RECORDS}`]
      : ['count>=0'];
  }
  if (RUNS_FULL) perResourceEvidenceThresholds[`partner_export_checkpoint{resource:${resource}}`] = ['max>0'];
}

const requiredThresholds = {
  partner_export_contract_failures: ['count==0'],
  partner_export_duplicate_records: ['count==0'],
  partner_export_snapshot_changes: ['count==0'],
  partner_export_pool_saturation: ['count==0'],
  dropped_iterations: ['count==0'],
  ...perResourceEvidenceThresholds,
};
if (RUNS_INCREMENTAL) requiredThresholds.partner_export_incremental_duration = ['max<900000'];

export const options = {
  setupTimeout: '30m',
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)'],
  scenarios: {
    incremental_export: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '15m',
      gracefulStop: '0s',
    },
  },
  thresholds: requiredThresholds,
};

function boundedInteger(value, minimum, maximum, fallback) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function metricTags(resource, mode) {
  return { resource, mode };
}

function utf8ByteLength(value) {
  // k6 response bodies are strings. Count UTF-8 bytes without depending on a
  // runtime-specific TextEncoder global.
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) length += 1;
    else if (code < 0x800) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      length += 4;
      index += 1;
    } else length += 3;
  }
  return length;
}

function responseSignalsPoolSaturation(response) {
  if (response.status === 503) return true;
  const signal = response.headers['X-Breeze-DB-Pool-Saturated']
    || response.headers['x-breeze-db-pool-saturated']
    || response.headers['X-DB-Pool-Saturated']
    || response.headers['x-db-pool-saturated'];
  if (String(signal).toLowerCase() === 'true') return true;
  return response.status >= 500
    && /(?:database|connection)[ _-]?pool[ _-]?(?:saturated|exhausted)/iu.test(response.body || '');
}

function retryDelaySeconds(response, attempt) {
  const retryAfter = Number.parseInt(response.headers['Retry-After'] || '', 10);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter, 30);
  return Math.min(0.25 * (2 ** attempt), 5) + Math.random() * 0.25;
}

function getPage(resource, mode, url) {
  const tags = metricTags(resource, mode);
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const response = http.get(url, {
      headers: partnerApiHeaders(),
      tags: { ...tags, name: 'partner_api_export_page' },
      timeout: '60s',
    });
    pageDuration.add(response.timings.duration, tags);

    if (response.status === 429) rateLimited.add(1, tags);
    if (response.status >= 500) serverErrors.add(1, tags);
    if (responseSignalsPoolSaturation(response)) poolSaturation.add(1, tags);

    if (response.status === 200) return response;
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === MAX_RETRIES) {
      throw new Error(`${mode} ${resource} failed with HTTP ${response.status} after ${attempt} retries`);
    }
    retries.add(1, tags);
    sleep(retryDelaySeconds(response, attempt));
  }
  throw new Error(`${mode} ${resource} exhausted its retry bound`);
}

function parseEnvelope(resource, mode, response, limit) {
  let body;
  try {
    body = JSON.parse(response.body);
  } catch {
    contractFailures.add(1, metricTags(resource, mode));
    throw new Error(`${mode} ${resource} returned non-JSON data`);
  }
  const valid = body
    && body.schemaVersion === '1'
    && typeof body.snapshotAt === 'string'
    && Number.isFinite(Date.parse(body.snapshotAt))
    && Array.isArray(body.data)
    && body.data.length <= limit
    && typeof body.hasMore === 'boolean'
    && (body.nextCursor === null || (typeof body.nextCursor === 'string' && body.nextCursor.length > 0))
    && body.hasMore === (body.nextCursor !== null)
    && (body.blocked === undefined || (Array.isArray(body.blocked) && body.blocked.length <= 500));
  if (!valid) {
    contractFailures.add(1, metricTags(resource, mode));
    throw new Error(`${mode} ${resource} returned an invalid v1 envelope`);
  }
  return body;
}

function assertUniqueRecords(resource, mode, envelope, seen) {
  const candidates = envelope.data.concat(envelope.blocked || []);
  for (const record of candidates) {
    const isBlocked = typeof record === 'object' && record !== null && 'reason' in record;
    if (!record || typeof record.id !== 'string' || typeof record.orgId !== 'string'
      || (isBlocked && record.resource !== resource)) {
      contractFailures.add(1, metricTags(resource, mode));
      throw new Error(`${mode} ${resource} returned a record with invalid identity`);
    }
    const key = `${resource}\u0000${record.id}\u0000${record.orgId}`;
    if (seen.has(key)) {
      duplicateRecords.add(1, metricTags(resource, mode));
      throw new Error(`${mode} ${resource} duplicated (${record.id}, ${record.orgId})`);
    }
    seen.add(key);
  }
}

function traverseResource(resource, mode, updatedSince, deadlineMs, limit) {
  const tags = metricTags(resource, mode);
  const seen = new Set();
  const seenCursors = new Set();
  let cursor = null;
  let snapshotAt = null;
  let pageCount = 0;
  let recordCount = 0;
  const startedAt = Date.now();

  do {
    if (Date.now() >= deadlineMs) {
      throw new Error(`${mode} traversal exceeded its time budget at ${resource}`);
    }
    if (pageCount >= MAX_PAGES) {
      throw new Error(`${mode} ${resource} exceeded the ${MAX_PAGES}-page safety bound`);
    }
    const query = [`limit=${limit}`];
    if (updatedSince) query.push(`updatedSince=${encodeURIComponent(updatedSince)}`);
    if (cursor) query.push(`cursor=${encodeURIComponent(cursor)}`);
    const response = getPage(resource, mode, `${API_URL}/partner-api/${resource}?${query.join('&')}`);
    const envelope = parseEnvelope(resource, mode, response, limit);

    if (snapshotAt === null) snapshotAt = envelope.snapshotAt;
    else if (envelope.snapshotAt !== snapshotAt) {
      snapshotChanges.add(1, tags);
      throw new Error(`${mode} ${resource} changed snapshotAt during pagination`);
    }
    assertUniqueRecords(resource, mode, envelope, seen);

    bytes.add(utf8ByteLength(response.body), tags);
    pages.add(1, tags);
    records.add(envelope.data.length, tags);
    pageCount += 1;
    recordCount += envelope.data.length;

    if (envelope.nextCursor && seenCursors.has(envelope.nextCursor)) {
      contractFailures.add(1, tags);
      throw new Error(`${mode} ${resource} returned a non-advancing cursor`);
    }
    cursor = envelope.nextCursor;
    if (cursor) seenCursors.add(cursor);
  } while (cursor !== null);

  const duration = Date.now() - startedAt;
  traversalDuration.add(duration, tags);
  return { snapshotAt, pageCount, recordCount, duration };
}

export function setup() {
  if (!PARTNER_API_KEY) throw new Error('PARTNER_API_KEY is required');
  if (MODE === 'invalid') throw new Error('PARTNER_API_MODE must be full, incremental, or both');
  if (!RUNS_FULL) return { checkpoints: parseExternalCheckpoints() };

  const capturedCheckpoints = {};
  const startedAt = Date.now();
  const fullDeadline = Date.now() + 30 * 60 * 1000;
  for (const resource of RESOURCES) {
    const result = traverseResource(resource, 'full', null, fullDeadline, PAGE_LIMIT);
    capturedCheckpoints[resource] = result.snapshotAt;
    checkpointMetric.add(Date.parse(result.snapshotAt), { resource });
    if (resource === 'devices' && result.recordCount < EXPECTED_DEVICES) {
      throw new Error(`seeded dataset has ${result.recordCount} devices; expected at least ${EXPECTED_DEVICES}`);
    }
  }
  fullDuration.add(Date.now() - startedAt, { mode: 'full' });
  return { checkpoints: capturedCheckpoints };
}

export default function (baseline) {
  if (!RUNS_INCREMENTAL) return;
  if (!baseline || !baseline.checkpoints) throw new Error('partner export checkpoints are missing');
  if (RUNS_FULL) {
    // Keep the incremental lower bound strictly behind the database-generated
    // first-page snapshot, even on a fast local stack with millisecond timestamps.
    sleep(0.01);
  }
  const startedAt = Date.now();
  const deadline = startedAt + INCREMENTAL_BUDGET_MS;
  for (const resource of RESOURCES) {
    const updatedSince = baseline.checkpoints[resource];
    if (!updatedSince) throw new Error(`missing full checkpoint for ${resource}`);
    const result = traverseResource(resource, 'incremental', updatedSince, deadline, INCREMENTAL_LIMIT);
    if (result.recordCount < EXPECTED_INCREMENTAL_RECORDS) {
      throw new Error(
        `${resource} returned ${result.recordCount} changed records; expected at least ${EXPECTED_INCREMENTAL_RECORDS}`,
      );
    }
    if (EXPECTED_INCREMENTAL_RECORDS >= 2 && INCREMENTAL_LIMIT === 1 && result.pageCount < 2) {
      throw new Error(`${resource} did not exercise a late incremental cursor page`);
    }
  }
  if (Date.now() - startedAt >= INCREMENTAL_BUDGET_MS) {
    throw new Error('incremental traversal exceeded the 15-minute cadence budget');
  }
  incrementalDuration.add(Date.now() - startedAt, { mode: 'incremental' });
}

function parseExternalCheckpoints() {
  let parsed = null;
  if (PARTNER_API_CHECKPOINTS_JSON) {
    try {
      parsed = JSON.parse(PARTNER_API_CHECKPOINTS_JSON);
    } catch {
      throw new Error('PARTNER_API_CHECKPOINTS_JSON must be valid JSON');
    }
  }
  const result = {};
  for (const resource of RESOURCES) {
    const value = parsed && typeof parsed === 'object'
      ? parsed[resource]
      : INCREMENTAL_UPDATED_SINCE;
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
      throw new Error(`missing or invalid incremental checkpoint for ${resource}`);
    }
    result[resource] = new Date(value).toISOString();
  }
  return result;
}

function metricValue(data, name, field) {
  return data.metrics[name] && data.metrics[name].values
    ? data.metrics[name].values[field] || 0
    : 0;
}

function durationDistribution(data, name) {
  const values = data.metrics[name] && data.metrics[name].values;
  if (!values) return null;
  return {
    avg: values.avg || 0,
    min: values.min || 0,
    med: values.med || 0,
    max: values.max || 0,
    p90: values['p(90)'] || 0,
    p95: values['p(95)'] || 0,
  };
}

export function handleSummary(data) {
  const resourceDurations = {};
  const resourceCounts = {};
  const capturedCheckpoints = {};
  for (const resource of RESOURCES) {
    resourceDurations[resource] = {};
    resourceCounts[resource] = {};
    for (const mode of ['full', 'incremental']) {
      const selector = `resource:${resource},mode:${mode}`;
      resourceDurations[resource][mode] = {
        pagesMs: durationDistribution(data, `partner_export_page_duration{${selector}}`),
        traversalMs: durationDistribution(data, `partner_export_traversal_duration{${selector}}`),
      };
      resourceCounts[resource][mode] = {
        pages: metricValue(data, `partner_export_pages{${selector}}`, 'count'),
        records: metricValue(data, `partner_export_records{${selector}}`, 'count'),
      };
    }
    const checkpointMs = metricValue(
      data,
      `partner_export_checkpoint{resource:${resource}}`,
      'max',
    );
    if (checkpointMs > 0) capturedCheckpoints[resource] = new Date(checkpointMs).toISOString();
  }
  const summaryCheckpoints = Object.keys(capturedCheckpoints).length > 0
    ? capturedCheckpoints
    : (RUNS_INCREMENTAL ? parseExternalCheckpoints() : {});
  const summary = {
    mode: MODE,
    pageLimits: { full: PAGE_LIMIT, incremental: INCREMENTAL_LIMIT },
    incrementalExpectedRecords: EXPECTED_INCREMENTAL_RECORDS,
    checkpoints: summaryCheckpoints,
    pages: metricValue(data, 'partner_export_pages', 'count'),
    records: metricValue(data, 'partner_export_records', 'count'),
    bytes: metricValue(data, 'partner_export_bytes', 'count'),
    retries: metricValue(data, 'partner_export_retries', 'count'),
    rateLimited429: metricValue(data, 'partner_export_429', 'count'),
    server5xx: metricValue(data, 'partner_export_5xx', 'count'),
    poolSaturation: metricValue(data, 'partner_export_pool_saturation', 'count'),
    contractFailures: metricValue(data, 'partner_export_contract_failures', 'count'),
    duplicateRecords: metricValue(data, 'partner_export_duplicate_records', 'count'),
    snapshotChanges: metricValue(data, 'partner_export_snapshot_changes', 'count'),
    fullDurationMs: metricValue(data, 'partner_export_full_duration', 'max'),
    incrementalDurationMs: metricValue(data, 'partner_export_incremental_duration', 'max'),
    resourceCounts,
    resourceDurations,
  };
  return {
    stdout: `\n=== Partner API export ===\n${JSON.stringify(summary, null, 2)}\n`,
    [SUMMARY_FILE]: JSON.stringify(summary, null, 2),
  };
}
