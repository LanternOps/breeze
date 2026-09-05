import { describe, expect, it, vi } from 'vitest';
import { WORKER_REGISTRY } from '../services/workerRegistry';
import { WORKER_READINESS_MANIFEST, declareExpectedConsumers } from './workerReadinessManifest';

const NON_CONSUMERS = [
  'desktopSessionOrphanRecovery',
  'oauthRevocationRetryWorker',
  'incidentCorrelationWorker',
  'incidentTimelineEnricher',
  'incidentSlaMonitor',
];

// The two consumers main starts OUTSIDE the registry, role-gated in
// index.ts (eventDispatch when role !== 'api'; agentCommandRelay when
// role !== 'worker') and worker.ts (eventDispatch only).
const OUT_OF_REGISTRY_INITIALIZERS = ['eventDispatch', 'agentCommandRelay'] as const;

function initializerKeys(): string[] {
  return [...WORKER_REGISTRY.map((entry) => entry.name), ...OUT_OF_REGISTRY_INITIALIZERS];
}

/** Consumer names the manifest declares, in manifest order. */
function declaredConsumerNames(): string[] {
  return WORKER_READINESS_MANIFEST.flatMap((e) => (e.kind === 'consumers' ? [...e.consumers] : []));
}

/**
 * Cross-check against the REGISTRY, not the manifest: every initializer is a
 * registry entry or one of the two out-of-registry starters; non-consumers
 * declare nothing; multi-Worker initializers add (consumers.length - 1) extras.
 */
function expectedDeclaredCount(): number {
  const extras = WORKER_READINESS_MANIFEST.reduce(
    (sum, e) => sum + (e.kind === 'consumers' ? e.consumers.length - 1 : 0),
    0,
  );
  return WORKER_REGISTRY.length + OUT_OF_REGISTRY_INITIALIZERS.length - NON_CONSUMERS.length + extras;
}

// ---------------------------------------------------------------------------
// Mirror of the declare-time rules (spec section 5, D3/D3a). Expectations are
// computed from WORKER_REGISTRY placements and the rules — NOT from
// selectWorkers — so they are independent of the implementation helper and
// do not rot when a placement flips. Keep this the single place the rules
// live in this file so the count tests cannot drift from the semantics tests.
// ---------------------------------------------------------------------------

type Role = 'all' | 'api' | 'worker';
interface Flags {
  partnerTrustEnabled: boolean;
  auditChainVerifyEnabled: boolean;
  abuseSignalsEnabled: boolean;
  eventDispatchEnabled: boolean;
  aiAgentsEnabled: boolean;
}
const ALL_ON: Flags = {
  partnerTrustEnabled: true, auditChainVerifyEnabled: true, abuseSignalsEnabled: true,
  eventDispatchEnabled: true, aiAgentsEnabled: true,
};
// Default configuration: opt-in flags off, audit verification on.
const DEFAULT_FLAGS: Flags = {
  partnerTrustEnabled: false, auditChainVerifyEnabled: true, abuseSignalsEnabled: false,
  eventDispatchEnabled: false, aiAgentsEnabled: false,
};

/** Initializers a process of `role` starts: registry entries by placement + the role-gated out-of-registry starters. */
function selectedInitializers(role: Role): Set<string> {
  const placement = role === 'api' ? 'socket-owner' : role === 'worker' ? 'global' : null;
  const names = new Set(
    WORKER_REGISTRY.filter((e) => placement === null || e.placement === placement).map((e) => e.name),
  );
  if (role !== 'api') names.add('eventDispatch');
  if (role !== 'worker') names.add('agentCommandRelay');
  return names;
}

function ruleIsOn(rule: string, flags: Flags): boolean {
  switch (rule) {
    case 'redis': return true;
    case 'abuse_or_partner_trust_enabled': return flags.abuseSignalsEnabled || flags.partnerTrustEnabled;
    case 'audit_chain_verify_enabled': return flags.auditChainVerifyEnabled;
    case 'event_dispatch_enabled': return flags.eventDispatchEnabled;
    case 'ai_agents_enabled': return flags.aiAgentsEnabled;
    default: throw new Error(`unknown rule ${rule}`);
  }
}

function isOptionalMarked(e: { optionalConsumers?: readonly string[] }, name: string): boolean {
  return e.optionalConsumers?.includes(name) ?? false;
}

/** { name -> required } for everything a process of `role` declares under `flags`. */
function expectedDeclarations(role: Role, flags: Flags): Map<string, boolean> {
  const selected = selectedInitializers(role);
  const out = new Map<string, boolean>();
  for (const e of WORKER_READINESS_MANIFEST) {
    if (e.kind !== 'consumers' || !selected.has(e.initializer)) continue;
    const on = ruleIsOn(e.requiredWhen, flags);
    for (const name of e.consumers) out.set(name, on && !isOptionalMarked(e, name));
  }
  return out;
}

/** Names a process of `role` disables (`feature_disabled`) under `flags`: rule off, not optional-marked. */
function expectedDisabled(role: Role, flags: Flags): string[] {
  const selected = selectedInitializers(role);
  return WORKER_READINESS_MANIFEST.flatMap((e) =>
    e.kind === 'consumers' && selected.has(e.initializer) && !ruleIsOn(e.requiredWhen, flags)
      ? e.consumers.filter((n) => !isOptionalMarked(e, n))
      : [],
  ).sort();
}

function expectedRequiredNames(role: Role, flags: Flags): string[] {
  return [...expectedDeclarations(role, flags).entries()].filter(([, r]) => r).map(([n]) => n).sort();
}

function fakeRegistry() {
  return {
    expect: vi.fn(),
    disable: vi.fn(),
    attach: vi.fn(),
    recordInitializationFailure: vi.fn(),
    snapshot: vi.fn(() => ({})),
    requiredConsumersRunnable: vi.fn(() => false),
  };
}

function declare(role: Role, flags: Flags) {
  const registry = fakeRegistry();
  declareExpectedConsumers({ role, redisAvailable: true, ...flags, registry });
  const declared = new Map(registry.expect.mock.calls.map(([n, r]) => [n as string, r as boolean]));
  const disabled = registry.disable.mock.calls.map(([n]) => n as string).sort();
  return { registry, declared, disabled };
}

describe('worker readiness manifest', () => {
  it('classifies every initializeWorkers group exactly once', () => {
    const keys = initializerKeys().sort();
    const declared = WORKER_READINESS_MANIFEST.map(({ initializer }) => initializer).sort();
    expect(declared).toEqual(keys);
    expect(new Set(declared).size).toBe(declared.length);
  });

  it('classifies only verified timer/subscriber initializers as non-consumers', () => {
    const actual = WORKER_READINESS_MANIFEST
      .filter(({ kind }) => kind === 'non_consumer')
      .map(({ initializer }) => initializer)
      .sort();
    expect(actual).toEqual([...NON_CONSUMERS].sort());
  });

  it('declares every stable consumer name exactly once', () => {
    const names = declaredConsumerNames();
    expect(names).toHaveLength(expectedDeclaredCount());
    expect(new Set(names).size).toBe(names.length);
  });

  it('does not reinterpret Redis startup failure as a feature disable', () => {
    const registry = fakeRegistry();
    declareExpectedConsumers({ role: 'all', redisAvailable: false, ...ALL_ON, registry });
    expect(registry.expect).not.toHaveBeenCalled();
    expect(registry.disable).not.toHaveBeenCalled();
  });

  it('declares Redis consumers required and abuse signals optional-disabled when configured off', () => {
    const registry = fakeRegistry();
    declareExpectedConsumers({ role: 'all', redisAvailable: true, ...DEFAULT_FLAGS, registry });
    expect(registry.expect.mock.calls.filter(([name]) => name === 'abuseSignalsWorker')).toEqual([['abuseSignalsWorker', false]]);
    expect(registry.disable).toHaveBeenCalledWith('abuseSignalsWorker', 'feature_disabled');
    const required = registry.expect.mock.calls.filter(([, r]) => r).map(([n]) => n as string).sort();
    expect(required).toEqual(expectedRequiredNames('all', DEFAULT_FLAGS));
    // Named, not numbered: exactly these consumers are optional on a default self-hosted box.
    const optional = declaredConsumerNames().filter((n) => !required.includes(n)).sort();
    expect(optional).toEqual(['abuseSignalsWorker', 'aiAgentRunner', 'eventDispatch', 'eventDispatchMaintenance']);
  });

  it('makes abuse signals required when configured on', () => {
    const registry = fakeRegistry();
    declareExpectedConsumers({ role: 'all', redisAvailable: true, ...ALL_ON, registry });
    expect(registry.expect).toHaveBeenCalledWith('abuseSignalsWorker', true);
    expect(registry.disable).not.toHaveBeenCalled();
    expect(registry.expect).toHaveBeenCalledTimes(declaredConsumerNames().length);
    expect(registry.expect.mock.calls.filter(([, r]) => r)).toHaveLength(expectedRequiredNames('all', ALL_ON).length);
  });
});

describe('role-scoped, rule-resolved declarations (spec section 5, D3/D3a)', () => {
  it.each<Role>(['api', 'worker', 'all'])(
    'role %s declares exactly the selected consumers with the required flag each rule yields',
    (role) => {
      for (const flags of [ALL_ON, DEFAULT_FLAGS]) {
        const { declared, disabled } = declare(role, flags);
        expect([...declared.entries()].sort()).toEqual([...expectedDeclarations(role, flags).entries()].sort());
        expect(disabled).toEqual(expectedDisabled(role, flags));
      }
    },
  );

  it('api declares agentCommandRelay and no global consumer; worker declares eventDispatch(+maintenance) and no socket-owner consumer', () => {
    const api = declare('api', ALL_ON).declared;
    expect(api.get('agentCommandRelay')).toBe(true);
    expect(api.has('offlineDetector')).toBe(false); // a global entry
    expect(api.has('eventDispatch')).toBe(false);
    const worker = declare('worker', ALL_ON).declared;
    expect(worker.get('eventDispatch')).toBe(true);
    expect(worker.get('eventDispatchMaintenance')).toBe(false); // optional marker, even with the flag on
    expect(worker.has('agentCommandRelay')).toBe(false);
    expect(worker.has('orgMerge')).toBe(false); // a socket-owner entry
  });

  it('api ∪ worker == all, with no name declared in both', () => {
    const api = [...declare('api', ALL_ON).declared.keys()];
    const worker = [...declare('worker', ALL_ON).declared.keys()];
    expect([...api, ...worker].sort()).toEqual([...declare('all', ALL_ON).declared.keys()].sort());
    expect(new Set([...api, ...worker]).size).toBe(api.length + worker.length);
  });

  it.each([
    ['event_dispatch_enabled', 'eventDispatch', 'worker', { ...ALL_ON, eventDispatchEnabled: false }],
    ['ai_agents_enabled', 'aiAgentRunner', 'api', { ...ALL_ON, aiAgentsEnabled: false }],
    ['abuse_or_partner_trust_enabled', 'abuseSignalsWorker', 'worker', { ...ALL_ON, abuseSignalsEnabled: false, partnerTrustEnabled: false }],
    ['audit_chain_verify_enabled', 'auditChainVerify', 'worker', { ...ALL_ON, auditChainVerifyEnabled: false }],
  ] as const)('%s off: %s is declared optional and disabled feature_disabled; on: required', (_rule, name, role, offFlags) => {
    const off = declare(role, offFlags);
    expect(off.declared.get(name)).toBe(false);
    expect(off.registry.disable).toHaveBeenCalledWith(name, 'feature_disabled');
    const on = declare(role, ALL_ON);
    expect(on.declared.get(name)).toBe(true);
    expect(on.registry.disable).not.toHaveBeenCalledWith(name, expect.anything());
  });

  it.each([
    [false, false, false],
    [false, true, true],
    [true, false, true],
    [true, true, true],
  ])('abuse=%s trust=%s makes the shared consumer required=%s', (abuseSignalsEnabled, partnerTrustEnabled, required) => {
    const { declared, registry } = declare('worker', { ...DEFAULT_FLAGS, abuseSignalsEnabled, partnerTrustEnabled });
    expect(declared.get('abuseSignalsWorker')).toBe(required);
    if (required) expect(registry.disable).not.toHaveBeenCalledWith('abuseSignalsWorker', expect.anything());
    else expect(registry.disable).toHaveBeenCalledWith('abuseSignalsWorker', 'feature_disabled');
  });

  it('a flag only matters where its consumer is selected: api never declares abuseSignalsWorker or eventDispatch', () => {
    const { declared, disabled } = declare('api', DEFAULT_FLAGS);
    expect(declared.has('abuseSignalsWorker')).toBe(false);
    expect(declared.has('eventDispatch')).toBe(false);
    expect(disabled).not.toContain('abuseSignalsWorker');
  });

  it('the maintenance consumer is optional but never disabled, whatever the dispatch flag', () => {
    const { declared, disabled } = declare('worker', { ...ALL_ON, eventDispatchEnabled: false });
    expect(declared.get('eventDispatchMaintenance')).toBe(false);
    expect(disabled).toEqual(['eventDispatch']);
  });

  it('on a default all box exactly four consumers are optional (names, not a number)', () => {
    const { declared } = declare('all', DEFAULT_FLAGS);
    const optional = [...declared.entries()].filter(([, r]) => !r).map(([n]) => n).sort();
    expect(optional).toEqual(['abuseSignalsWorker', 'aiAgentRunner', 'eventDispatch', 'eventDispatchMaintenance']);
    expect([...declared.values()].filter(Boolean)).toHaveLength(declared.size - optional.length);
  });

  it('every optionalConsumers entry is a subset of its own consumers', () => {
    for (const e of WORKER_READINESS_MANIFEST) {
      if (e.kind !== 'consumers') continue;
      for (const n of e.optionalConsumers ?? []) expect(e.consumers).toContain(n);
    }
  });
});
