import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import { devices } from '../db/schema/devices';
import {
  SAFE_DEVICE_RESOURCE_FIELDS,
  buildSafeDeviceProjection,
} from './mcpServer';

// SR-008: breeze://devices/{id} must never serialize credential verifiers or
// mTLS material to an MCP/AI client. The projection is an explicit ALLOW-LIST
// so any future column is excluded by default (fail-safe), not opt-out.

const KNOWN_SENSITIVE_COLUMNS = [
  'agentTokenHash',
  'previousTokenHash',
  'watchdogTokenHash',
  'previousWatchdogTokenHash',
  'helperTokenHash',
  'previousHelperTokenHash',
  'mtlsCertSerialNumber',
  'mtlsCertCfId',
  'mtlsCertExpiresAt',
  'mtlsCertIssuedAt',
  'agentId',
];

describe('SR-008 — safe device resource projection', () => {
  const allColumns = Object.keys(getTableColumns(devices));

  it('never includes any known sensitive/credential column', () => {
    for (const sensitive of KNOWN_SENSITIVE_COLUMNS) {
      expect(allColumns).toContain(sensitive); // guards against schema renames
      expect(SAFE_DEVICE_RESOURCE_FIELDS).not.toContain(sensitive);
    }
  });

  it('is an allow-list of real device columns only (no typos, fail-safe)', () => {
    for (const field of SAFE_DEVICE_RESOURCE_FIELDS) {
      expect(allColumns).toContain(field);
    }
  });

  it('still exposes the operationally useful fields an AI client needs', () => {
    for (const safe of ['id', 'hostname', 'status', 'osType', 'osVersion', 'lastSeenAt']) {
      expect(SAFE_DEVICE_RESOURCE_FIELDS).toContain(safe);
    }
  });

  it('buildSafeDeviceProjection returns only allow-listed columns', () => {
    const projection = buildSafeDeviceProjection();
    const keys = Object.keys(projection);
    expect(new Set(keys)).toEqual(new Set(SAFE_DEVICE_RESOURCE_FIELDS));
    for (const sensitive of KNOWN_SENSITIVE_COLUMNS) {
      expect(keys).not.toContain(sensitive);
    }
  });
});

// #6086 — `deviceSiteDenied(auth, siteId, deviceId)` denies an EXACT-DEVICE
// caller (`auth.allowedDeviceIds`, set only by a resource-scoped agent run:
// services/aiAgents/agentAuthContext.ts) whenever the device id is missing,
// because a site alone cannot establish membership in an exact device scope.
// A 2-argument call therefore denies such a caller its OWN device. No caller
// reaches this route with `allowedDeviceIds` today, so the mistake is
// fail-closed and unreachable — which is exactly why only a source contract
// can hold the line for the next one.
describe('deviceSiteDenied call sites in mcpServer.ts', () => {
  it('always pass the device id as the third argument', () => {
    const source = readFileSync(join(__dirname, 'mcpServer.ts'), 'utf8');
    const calls = source.match(/deviceSiteDenied\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.split(',')).toHaveLength(3);
    }
  });
});
