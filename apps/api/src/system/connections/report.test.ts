/**
 * buildConnectionsReport + invariants 2 (secret canary, value-shape guard)
 * and 4 (reasons name vars, never values — reasons are part of the
 * serialized report the canary scans).
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CONNECTION_REGISTRY } from './registry';
import { buildConnectionsReport, displayableValue } from './report';
import { defineEntry } from './statusHelpers';
import { CONNECTION_GROUPS, type ConnectionsReport } from './types';

const secretVars = CONNECTION_REGISTRY.flatMap((e) => e.vars).filter((v) => v.secret !== false).map((v) => v.name);
const publicVars = CONNECTION_REGISTRY.flatMap((e) => e.vars).filter((v) => v.secret === false).map((v) => v.name);

/** Realistic non-secret values, chosen by name shape. */
function realisticValue(name: string): string {
  if (/_ENABLED$|^ENABLE_|_ENFORCED$|ALLOW_|TRUSTS_MFA$|^FORCE_HTTPS$|^TRUST_|INCLUDE_DEFAULT|_SECURE$/.test(name)) return 'true';
  if (/_PORT$/.test(name)) return '5349';
  if (/_URL$|_URI$|ENDPOINT|_ORIGIN$|^OAUTH_ISSUER$|^BREEZE_SERVER$|_ORIGINS$/.test(name)) return 'https://svc.example.test';
  if (/_ORG_IDS$|_USER_IDS$/.test(name)) return '11111111-1111-4111-8111-111111111111';
  if (/_CLIENT_ID$|_APP_ID$/.test(name)) return '22222222-2222-4222-8222-222222222222';
  if (/_FROM$|_EMAIL$|_ADDRESS$/.test(name)) return 'noreply@example.test';
  if (/_RATE$|MULTIPLIER$|_USD$/.test(name)) return '0.1';
  return 'example-value';
}

function canaryFor(name: string): string {
  return `CANARY_${name}_${randomUUID()}`;
}

/** Every secret var (and its NAME_FILE twin) gets a unique canary. */
function canaryEnv(style: 'bare' | 'embedded'): { env: Record<string, string>; canaries: string[] } {
  const env: Record<string, string> = {};
  const canaries: string[] = [];
  for (const name of secretVars) {
    const canary = canaryFor(name);
    const fileCanary = canaryFor(`${name}_FILE`);
    canaries.push(canary, fileCanary);
    env[name] = style === 'bare' ? canary : `postgresql://user:${canary}@db.example.test:5432/breeze`;
    env[`${name}_FILE`] = `/run/secrets/${fileCanary}`;
  }
  return { env, canaries };
}

function expectNoCanary(serialized: string, canaries: readonly string[]): void {
  const leaked = canaries.filter((c) => serialized.includes(c));
  expect(leaked).toEqual([]);
}

function allReportVars(report: ConnectionsReport) {
  return report.groups.flatMap((g) => g.entries.flatMap((e) => e.vars));
}

describe('buildConnectionsReport', () => {
  it('returns the spec §2 shape: every registry entry once, groups in CONNECTION_GROUPS order', () => {
    const report = buildConnectionsReport({ APP_VERSION: '0.116.0', IS_HOSTED: 'true' });
    expect(report.version).toBe('0.116.0');
    expect(report.deployMode).toBe('hosted');
    expect(report.scope).toBe('api');
    expect(report.groups.map((g) => g.group)).toEqual(CONNECTION_GROUPS.filter((g) => report.groups.some((x) => x.group === g)));
    const ids = report.groups.flatMap((g) => g.entries.map((e) => e.id));
    expect(ids.sort()).toEqual(CONNECTION_REGISTRY.map((e) => e.id).sort());
    const total = Object.values(report.summary).reduce((a, b) => a + b, 0);
    expect(total).toBe(CONNECTION_REGISTRY.length);
  });

  it('defaults version and deployMode from an empty env', () => {
    const report = buildConnectionsReport({});
    expect(report.version).toBe('unknown');
    expect(report.deployMode).toBe('self_host');
    expect(report.summary.required_missing).toBeGreaterThan(0); // database, redis, public URLs, email, keys
  });

  it('shows non-secret values and never a value for a secret var', () => {
    const env = Object.fromEntries(publicVars.map((name) => [name, realisticValue(name)]));
    const report = buildConnectionsReport(env);
    for (const v of allReportVars(report)) {
      if (v.secret) {
        expect('value' in v, v.name).toBe(false);
      } else {
        expect(v.value, v.name).toBe(realisticValue(v.name));
      }
    }
  });
});

describe('invariant 2: secret canary', () => {
  it.each(['bare', 'embedded'] as const)('no %s canary reaches the serialized report (public vars set too)', (style) => {
    const { env, canaries } = canaryEnv(style);
    for (const name of publicVars) env[name] = realisticValue(name);
    expectNoCanary(JSON.stringify(buildConnectionsReport(env)), canaries);
  });

  it('no canary reaches the report when only secrets are set (drives misconfigured reasons)', () => {
    const { env, canaries } = canaryEnv('bare');
    expectNoCanary(JSON.stringify(buildConnectionsReport(env)), canaries);
  });

  it('no canary reaches the report when every flag is on (drives flag-entry reasons)', () => {
    const { env, canaries } = canaryEnv('bare');
    for (const name of publicVars) env[name] = /_ENABLED$|^ENABLE_/.test(name) ? 'true' : '';
    expectNoCanary(JSON.stringify(buildConnectionsReport(env)), canaries);
  });
});

describe('invariant 2: value-shape guard', () => {
  it('realistic non-secret values carry no URL userinfo and no private_key JSON', () => {
    const env = Object.fromEntries(publicVars.map((name) => [name, realisticValue(name)]));
    for (const v of allReportVars(buildConnectionsReport(env))) {
      if (v.value === undefined) continue;
      expect(v.value, v.name).not.toMatch(/:\/\/[^/?#\s]*@/);
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(v.value);
      } catch {
        parsed = null;
      }
      expect(JSON.stringify(parsed ?? ''), v.name).not.toContain('private_key');
    }
  });

  it('refuses (renders set, no value) any non-secret value with URL userinfo', () => {
    const canaries: string[] = [];
    const env: Record<string, string> = {};
    for (const name of publicVars) {
      const canary = canaryFor(name);
      canaries.push(canary);
      env[name] = `https://operator:${canary}@host.example.test/path`;
    }
    const report = buildConnectionsReport(env);
    for (const v of allReportVars(report).filter((x) => !x.secret)) {
      expect(v.set, v.name).toBe(true);
      expect('value' in v, v.name).toBe(false);
    }
    expectNoCanary(JSON.stringify(report), canaries);
  });

  it('refuses scheme-less userinfo (S3 endpoints are coerced to https:// by coerceS3EndpointUrl)', () => {
    const canary = canaryFor('SCHEMELESS');
    expect(displayableValue(`AKIAEXAMPLE:${canary}@minio.local:9000`)).toBeUndefined();
    expect(displayableValue(`AKIAEXAMPLE@minio.local:9000`)).toBeUndefined();
    const report = buildConnectionsReport({ S3_ENDPOINT: `AKIAEXAMPLE:${canary}@minio.local:9000` });
    expectNoCanary(JSON.stringify(report), [canary]);
    // Plain hosts, host:port and email addresses still display.
    expect(displayableValue('minio.local:9000')).toBe('minio.local:9000');
    expect(displayableValue('noreply@example.test')).toBe('noreply@example.test');
    expect(displayableValue('Breeze Support <support@example.test>')).toBe('Breeze Support <support@example.test>');
  });

  it('refuses a non-secret URL value that carries a query string (keys ride in queries)', () => {
    const canary = canaryFor('QUERY');
    expect(displayableValue(`https://gateway.example.test/v1?key=${canary}`)).toBeUndefined();
    expect(displayableValue('https://gateway.example.test/v1')).toBe('https://gateway.example.test/v1');
  });

  it('refuses a non-secret value that carries service-account JSON or PEM key material', () => {
    const canary = canaryFor('JSON');
    expect(displayableValue(JSON.stringify({ type: 'service_account', private_key: canary }))).toBeUndefined();
    expect(displayableValue(`-----BEGIN PRIVATE KEY-----\n${canary}\n-----END PRIVATE KEY-----`)).toBeUndefined();
    expect(displayableValue('redis')).toBe('redis');
    expect(displayableValue('   ')).toBeUndefined();
  });

  it('never throws on hostile values', () => {
    const env = Object.fromEntries(
      [...secretVars, ...publicVars].map((name, i) => [name, ['%%%', '://@', '\u0000', 'postgres://a,b@', ' '][i % 5]!]),
    );
    expect(() => buildConnectionsReport(env)).not.toThrow();
  });
});

describe('a throwing status function', () => {
  it('marks only that entry misconfigured and never forwards the error text', () => {
    const canary = canaryFor('THROWN');
    const throwing = defineEntry({
      id: 'throws',
      group: 'integrations',
      label: 'Throws',
      vars: [{ name: 'THROWS_TOKEN' }],
      status: {
        kind: 'custom',
        fn: () => {
          throw new Error(`boom ${canary}`);
        },
      },
    });
    const fine = defineEntry({
      id: 'fine',
      group: 'integrations',
      label: 'Fine',
      vars: [{ name: 'FINE_TOKEN', required: true }],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const report = buildConnectionsReport({ FINE_TOKEN: 'x' }, [throwing, fine]);
      const entries = report.groups.flatMap((g) => g.entries);
      expect(entries.find((e) => e.id === 'throws')).toMatchObject({ status: 'misconfigured' });
      expect(entries.find((e) => e.id === 'fine')).toMatchObject({ status: 'enabled' });
      expectNoCanary(JSON.stringify(report), [canary]);
      expectNoCanary(JSON.stringify(warn.mock.calls), [canary]);
    } finally {
      warn.mockRestore();
    }
  });
});
