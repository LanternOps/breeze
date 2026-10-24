import { describe, expect, it } from 'vitest';
import type { SoftwarePolicyViolation } from '../db/schema';
import { watchKey } from './monitoringActiveWatches';
import {
  applyServiceRules,
  MAX_DERIVED_SERVICE_WATCHES,
  SERVICE_STATE_FRESHNESS_MS,
  serviceNamesForOs,
  serviceObservationKey,
  type ServiceObservation,
} from './softwarePolicyServiceRules';

const NOW = new Date('2026-10-24T12:00:00.000Z');
const CATALOG = '11111111-1111-4111-8111-111111111111';
const RULE = { name: 'Control D', catalogId: CATALOG };

function missing(rule: { name: string; catalogId?: string; minVersion?: string } = RULE): SoftwarePolicyViolation {
  return {
    type: 'missing',
    rule: { name: rule.name, catalogId: rule.catalogId, minVersion: rule.minVersion },
    severity: 'high',
    detectedAt: '2026-10-24T11:00:00.000Z',
  };
}

function obs(status: ServiceObservation['status'], ageMs = 60_000, agentSupportsAbsence = true): ServiceObservation {
  return { status, observedAt: new Date(NOW.getTime() - ageMs), agentSupportsAbsence };
}

function run(input: {
  violations?: SoftwarePolicyViolation[];
  rules?: Array<{ name: string; catalogId?: string; vendor?: string; minVersion?: string; maxVersion?: string }>;
  matched?: string[];
  names?: string[];
  observations?: Record<string, ServiceObservation>;
  mode?: 'allowlist' | 'blocklist' | 'audit';
}): SoftwarePolicyViolation[] {
  const rules = input.rules ?? [RULE];
  return applyServiceRules({
    mode: input.mode ?? 'allowlist',
    violations: input.violations ?? [],
    rules,
    inventoryMatchedRuleNames: new Set(input.matched ?? []),
    serviceNamesByCatalogId: new Map([[CATALOG, input.names ?? ['ctrld']]]),
    observations: new Map(Object.entries(input.observations ?? {}).map(([name, o]) => [serviceObservationKey(name), o])),
    now: NOW,
  });
}

describe('constants', () => {
  it('pins the freshness window and the derived-watch cap', () => {
    expect(SERVICE_STATE_FRESHNESS_MS).toBe(60 * 60 * 1000);
    expect(MAX_DERIVED_SERVICE_WATCHES).toBe(50);
  });

  it('serviceObservationKey is exactly watchKey(\'service\', name)', () => {
    for (const name of ['ctrld', 'CtrlD', 'NextDNS Service']) {
      expect(serviceObservationKey(name)).toBe(watchKey('service', name));
    }
  });
});

describe('applyServiceRules — the D4 table (one test per row)', () => {
  it('row 1: no inventory + no fresh status → service_unverified (low), never missing (Review Focus 2)', () => {
    const out = run({ violations: [missing()] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: 'service_unverified',
      severity: 'low',
      rule: { name: 'Control D', catalogId: CATALOG },
      service: { name: 'ctrld', observedStatus: null, observedAt: null },
      detectedAt: NOW.toISOString(),
    });
  });

  it('row 1b: no inventory + `error` → service_unverified carrying observedStatus error', () => {
    const out = run({ violations: [missing()], observations: { ctrld: obs('error') } });
    expect(out).toEqual([expect.objectContaining({
      type: 'service_unverified',
      service: { name: 'ctrld', observedStatus: 'error', observedAt: new Date(NOW.getTime() - 60_000).toISOString() },
    })]);
  });

  it('row 2: no inventory + `not_found` → the existing missing violation is kept unchanged', () => {
    const original = missing();
    const out = run({ violations: [original], observations: { ctrld: obs('not_found') } });
    expect(out).toEqual([original]);
  });

  it('row 3: no inventory + `stopped` → not_running (high)', () => {
    const out = run({ violations: [missing()], observations: { ctrld: obs('stopped') } });
    expect(out).toEqual([expect.objectContaining({
      type: 'not_running', severity: 'high', service: expect.objectContaining({ name: 'ctrld', observedStatus: 'stopped' }),
    })]);
  });

  it('row 4: no inventory + `running` → compliant (the missing violation is removed)', () => {
    expect(run({ violations: [missing()], observations: { ctrld: obs('running') } })).toEqual([]);
  });

  it('row 4b: inventory match + `running` → compliant (nothing added)', () => {
    expect(run({ matched: ['Control D'], observations: { ctrld: obs('running') } })).toEqual([]);
  });

  it('row 5: inventory match + `stopped` → not_running', () => {
    const out = run({ matched: ['Control D'], observations: { ctrld: obs('stopped') } });
    expect(out).toEqual([expect.objectContaining({ type: 'not_running', severity: 'high' })]);
  });

  it('row 6: inventory match + `not_found` → not_running with observedStatus not_found', () => {
    const out = run({ matched: ['Control D'], observations: { ctrld: obs('not_found') } });
    expect(out).toEqual([expect.objectContaining({
      type: 'not_running', service: expect.objectContaining({ observedStatus: 'not_found' }),
    })]);
  });

  it('row 7: inventory match + no fresh status → service_unverified', () => {
    expect(run({ matched: ['Control D'] })).toEqual([expect.objectContaining({ type: 'service_unverified', severity: 'low' })]);
  });
});

describe('applyServiceRules — modes, constraints, freshness', () => {
  it.each(['audit', 'blocklist'] as const)('%s mode returns violations unchanged', (mode) => {
    const input = [missing()];
    expect(run({ mode, violations: input, observations: { ctrld: obs('running') } })).toBe(input);
  });

  it.each([
    ['minVersion', { minVersion: '1.5.0' }],
    ['maxVersion', { maxVersion: '9.0.0' }],
    ['vendor', { vendor: 'Control D Inc' }],
  ] as const)('a %s-constrained rule keeps its missing when the service is running (AND semantics)', (_label, extra) => {
    const rule = { ...RULE, ...extra };
    const original = missing(rule);
    expect(run({ rules: [rule], violations: [original], observations: { ctrld: obs('running') } })).toEqual([original]);
  });

  it('a constrained rule with no inventory still follows the table otherwise (stopped → not_running)', () => {
    const rule = { ...RULE, minVersion: '1.5.0' };
    const out = run({ rules: [rule], violations: [missing(rule)], observations: { ctrld: obs('stopped') } });
    expect(out).toEqual([expect.objectContaining({ type: 'not_running', rule: expect.objectContaining({ minVersion: '1.5.0' }) })]);
  });

  it('an observation older than 60 minutes counts as none', () => {
    const out = run({ violations: [missing()], observations: { ctrld: obs('running', SERVICE_STATE_FRESHNESS_MS + 60_000) } });
    expect(out).toEqual([expect.objectContaining({ type: 'service_unverified', service: expect.objectContaining({ observedStatus: null }) })]);
  });

  it('an observation exactly 60 minutes old still counts', () => {
    expect(run({ violations: [missing()], observations: { ctrld: obs('running', SERVICE_STATE_FRESHNESS_MS) } })).toEqual([]);
  });

  it('`not_found` from an agent without absence support reads as error → service_unverified', () => {
    const out = run({ violations: [missing()], observations: { ctrld: obs('not_found', 60_000, false) } });
    expect(out).toEqual([expect.objectContaining({ type: 'service_unverified', service: expect.objectContaining({ observedStatus: 'error' }) })]);
  });

  it('observation keys match case-insensitively', () => {
    expect(run({ violations: [missing()], names: ['CtrlD'], observations: { ctrld: obs('running') } })).toEqual([]);
  });

  it('a rule without a catalogId is unchanged', () => {
    const rule = { name: 'Control D' };
    const original = missing(rule);
    expect(run({ rules: [rule], violations: [original], observations: { ctrld: obs('stopped') } })).toEqual([original]);
  });

  it('a rule whose catalog maps to no names is unchanged', () => {
    const original = missing();
    expect(run({ violations: [original], names: [], observations: { ctrld: obs('stopped') } })).toEqual([original]);
  });

  it('a rule with no inventory match and no missing violation (dropped upstream) is left alone', () => {
    expect(run({ violations: [], observations: { ctrld: obs('stopped') } })).toEqual([]);
  });

  it('two names on one rule, one stopped one running → not_running naming the stopped one', () => {
    const out = run({ violations: [missing()], names: ['ctrld', 'ctrld-helper'], observations: { ctrld: obs('running'), 'ctrld-helper': obs('stopped') } });
    expect(out).toEqual([expect.objectContaining({ type: 'not_running', service: expect.objectContaining({ name: 'ctrld-helper' }) })]);
  });

  it('worst outcome wins: not_running > missing > service_unverified', () => {
    expect(run({ violations: [missing()], names: ['a', 'b'], observations: { a: obs('not_found'), b: obs('stopped') } }))
      .toEqual([expect.objectContaining({ type: 'not_running' })]);
    expect(run({ violations: [missing()], names: ['a', 'b'], observations: { a: obs('not_found') } }))
      .toEqual([expect.objectContaining({ type: 'missing' })]);
    expect(run({ violations: [missing()], names: ['a', 'b'], observations: { a: obs('running') } }))
      .toEqual([expect.objectContaining({ type: 'service_unverified', service: expect.objectContaining({ name: 'b' }) })]);
  });

  it('unrelated violations pass through untouched and in order', () => {
    const unauthorized: SoftwarePolicyViolation = {
      type: 'unauthorized', software: { name: 'Torrent' }, severity: 'medium', detectedAt: NOW.toISOString(),
    };
    const other = missing({ name: 'Other', catalogId: '22222222-2222-4222-8222-222222222222' });
    const out = run({
      rules: [RULE, { name: 'Other', catalogId: '22222222-2222-4222-8222-222222222222' }],
      violations: [unauthorized, missing(), other],
      observations: { ctrld: obs('running') },
    });
    expect(out).toEqual([unauthorized, other]);
  });

  it('two rules sharing a name are matched to their own missing violation by catalogId', () => {
    const otherCatalog = '33333333-3333-4333-8333-333333333333';
    const ruleB = { name: 'Control D', catalogId: otherCatalog };
    const missingB = missing(ruleB);
    const out = applyServiceRules({
      mode: 'allowlist',
      violations: [missing(), missingB],
      rules: [RULE, ruleB],
      inventoryMatchedRuleNames: new Set(),
      serviceNamesByCatalogId: new Map([[CATALOG, ['ctrld']]]),
      observations: new Map([[serviceObservationKey('ctrld'), obs('running')]]),
      now: NOW,
    });
    expect(out).toEqual([missingB]);
  });
});

describe('serviceNamesForOs', () => {
  const rules = [
    { type: 'file_exists', path: 'C:\\ControlD\\ctrld.exe' },
    { type: 'service_running', serviceName: 'ctrld' },
  ];

  it('returns the service_running names when supportedOs is null or empty', () => {
    expect(serviceNamesForOs(rules, null, 'windows')).toEqual(['ctrld']);
    expect(serviceNamesForOs(rules, [], 'macos')).toEqual(['ctrld']);
  });

  it('returns [] when supportedOs excludes the device OS', () => {
    expect(serviceNamesForOs(rules, ['windows'], 'macos')).toEqual([]);
  });

  it('matches the OS case-insensitively', () => {
    expect(serviceNamesForOs(rules, ['Windows'], 'windows')).toEqual(['ctrld']);
  });

  it('returns [] for unparseable rules', () => {
    expect(serviceNamesForOs([{ type: 'nope' }], null, 'windows')).toEqual([]);
    expect(serviceNamesForOs('garbage', null, 'windows')).toEqual([]);
    expect(serviceNamesForOs(null, null, 'windows')).toEqual([]);
  });

  it('dedupes case-insensitively, keeping the first spelling, in stable order', () => {
    expect(serviceNamesForOs([
      { type: 'service_running', serviceName: 'NextDNS' },
      { type: 'service_running', serviceName: 'ctrld' },
      { type: 'service_running', serviceName: 'nextdns' },
    ], null, 'windows')).toEqual(['NextDNS', 'ctrld']);
  });
});
