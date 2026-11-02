import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_STATES,
  AGENT_REPORTABLE_STATES,
  ECH_DOH_ENDPOINT_URLS,
  ISOLATION_FAILURE_CODES,
  ISOLATION_RELEASE_KINDS,
  ISOLATION_STATES,
  NETWORK_ISOLATION_CAPABILITY,
  NETWORK_ISOLATION_MIN_AGENT_VERSION,
  NETWORK_ISOLATION_TTL,
  RESOLVED_TERMINAL_STATES,
  UNRESOLVED_TERMINAL_STATES,
  agentSupportsNetworkIsolation,
  isActiveIsolationState,
  isTerminalIsolationState, isUnresolvedTerminalIsolationState, isIsolationFailureCode, failureCodeFromJournalType, ISOLATION_RELEASE_JOURNAL_TYPES,
  isResolvedTerminalIsolationState,
  isUnresolvedIsolationState,
} from './networkIsolation';

describe('network isolation closed sets (plan "Closed sets")', () => {
  it('lists exactly the twelve episode states', () => {
    expect([...ISOLATION_STATES].sort()).toEqual([
      'applied', 'applying', 'dispatched', 'expired', 'failed', 'release_requested', 'released',
      'released_locally', 'requested', 'self_released', 'uninstalled', 'verified',
    ]);
  });

  it('partitions the states into active, unresolved-terminal and resolved-terminal', () => {
    const union = [...ACTIVE_STATES, ...UNRESOLVED_TERMINAL_STATES, ...RESOLVED_TERMINAL_STATES];
    expect(new Set(union).size).toBe(union.length);
    expect([...union].sort()).toEqual([...ISOLATION_STATES].sort());
    expect([...RESOLVED_TERMINAL_STATES].sort()).toEqual(['expired', 'failed', 'released', 'uninstalled']);
    expect([...UNRESOLVED_TERMINAL_STATES].sort()).toEqual(['released_locally', 'self_released']);
  });

  it('classifies each state through the predicates', () => {
    for (const s of ACTIVE_STATES) {
      expect(isActiveIsolationState(s)).toBe(true);
      expect(isUnresolvedIsolationState(s)).toBe(true);
      expect(isResolvedTerminalIsolationState(s)).toBe(false);
    }
    for (const s of UNRESOLVED_TERMINAL_STATES) {
      expect(isActiveIsolationState(s)).toBe(false);
      expect(isUnresolvedIsolationState(s)).toBe(true);
    }
    for (const s of RESOLVED_TERMINAL_STATES) {
      expect(isUnresolvedIsolationState(s)).toBe(false);
      expect(isResolvedTerminalIsolationState(s)).toBe(true);
    }
    expect(isUnresolvedIsolationState('quarantined')).toBe(false);
    expect(isResolvedTerminalIsolationState('quarantined')).toBe(false);
  });

  it('lets an agent report only the states it can observe', () => {
    expect([...AGENT_REPORTABLE_STATES].sort()).toEqual([
      'applied', 'applying', 'expired', 'failed', 'released', 'released_locally', 'self_released', 'verified',
    ]);
    for (const s of AGENT_REPORTABLE_STATES) expect(ISOLATION_STATES).toContain(s);
  });

  it('lists the seven failure codes and eight release kinds', () => {
    expect([...ISOLATION_FAILURE_CODES].sort()).toEqual([
      'agent_unsupported', 'apply_error', 'control_plane_unreachable', 'enforcement_not_observed',
      'mechanism_unavailable', 'not_delivered', 'unsupported_platform',
    ]);
    expect([...ISOLATION_RELEASE_KINDS].sort()).toEqual([
      'ai', 'console', 'dead_man', 'expired', 'local_code', 'local_forced', 'system', 'uninstall',
    ]);
  });

  it('pins the TTL and capability constants', () => {
    expect(NETWORK_ISOLATION_TTL).toEqual({ defaultHours: 72, maxHours: 720, expiringSoonHours: 12 });
    expect(NETWORK_ISOLATION_CAPABILITY).toEqual({ base: 1, deadMan: 2 });
  });
});

describe('agentSupportsNetworkIsolation (fails closed)', () => {
  it("is pinned to the '999.0.0' sentinel until W1g ships the capable agent (Gate B decision 6)", () => {
    expect(NETWORK_ISOLATION_MIN_AGENT_VERSION).toBe('999.0.0');
  });

  it('refuses every real version while the sentinel holds, even with capability 1', () => {
    for (const v of ['0.125.0', '0.200.0', '1.0.0', '10.4.2', '998.99.99']) {
      expect(agentSupportsNetworkIsolation(v, 1), v).toBe(false);
    }
  });

  it('refuses capability 0, null and anything non-integer, even at the gate version', () => {
    for (const cap of [0, null, undefined, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(agentSupportsNetworkIsolation(NETWORK_ISOLATION_MIN_AGENT_VERSION, cap as number | null), String(cap)).toBe(false);
    }
  });

  it('refuses a missing, empty, dev or unparseable version', () => {
    for (const v of [null, undefined, '', 'dev', 'not-a-version']) {
      expect(agentSupportsNetworkIsolation(v as string | null, 1), String(v)).toBe(false);
    }
  });

  it('accepts the gate version (and above) with capability >= 1', () => {
    expect(agentSupportsNetworkIsolation(NETWORK_ISOLATION_MIN_AGENT_VERSION, 1)).toBe(true);
    expect(agentSupportsNetworkIsolation('999.0.1', NETWORK_ISOLATION_CAPABILITY.deadMan)).toBe(true);
  });
});

describe('ECH_DOH_ENDPOINT_URLS parity with agent/internal/ech/doh.go', () => {
  it('matches DefaultEndpoints, in order', () => {
    const goFile = readFileSync(resolve(__dirname, '../../../../agent/internal/ech/doh.go'), 'utf8');
    const block = /var DefaultEndpoints = \[\]string\{([\s\S]*?)\}/.exec(goFile);
    expect(block, 'DefaultEndpoints not found in doh.go').not.toBeNull();
    const fromGo = [...block![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(fromGo.length).toBeGreaterThan(0);
    expect([...ECH_DOH_ENDPOINT_URLS]).toEqual(fromGo);
  });
});

describe('isolation typed classifiers', () => {
  it('classifies every terminal and failure code', () => {
    for (const state of ISOLATION_STATES) expect(isTerminalIsolationState(state)).toBe(!ACTIVE_STATES.includes(state as never));
    for (const state of UNRESOLVED_TERMINAL_STATES) expect(isUnresolvedTerminalIsolationState(state)).toBe(true);
    for (const code of ISOLATION_FAILURE_CODES) expect(isIsolationFailureCode(code)).toBe(true);
    expect(isIsolationFailureCode('made_up')).toBe(false);
  });
  it.each([['released_dead_man', 'dead_man'], ['released_local_code', 'local_code'], ['released_local_forced', 'local_forced']])('classifies %s as %s', (type, kind) => {
    expect(ISOLATION_RELEASE_JOURNAL_TYPES[type as keyof typeof ISOLATION_RELEASE_JOURNAL_TYPES]).toBe(kind);
  });
  it('classifies failure journals using the closed set', () => {
    expect(failureCodeFromJournalType('failed_apply_error')).toBe('apply_error');
    expect(failureCodeFromJournalType('failed_made_up')).toBeUndefined();
  });
});
