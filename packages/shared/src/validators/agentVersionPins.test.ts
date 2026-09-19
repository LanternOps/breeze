import { describe, expect, it } from 'vitest';
import {
  agentVersionPinsSchema,
  normalizeVersionPin,
  extractAgentVersionPins,
  resolveInheritedAgentVersionPins,
  PINNABLE_COMPONENTS,
} from './agentVersionPins';

describe('normalizeVersionPin', () => {
  it('maps the "latest" sentinel (any case), empty, whitespace, and non-strings to null', () => {
    expect(normalizeVersionPin('latest')).toBeNull();
    expect(normalizeVersionPin('LATEST')).toBeNull();
    expect(normalizeVersionPin('  Latest ')).toBeNull();
    expect(normalizeVersionPin('')).toBeNull();
    expect(normalizeVersionPin('   ')).toBeNull();
    expect(normalizeVersionPin(undefined)).toBeNull();
    expect(normalizeVersionPin(null)).toBeNull();
    expect(normalizeVersionPin(123)).toBeNull();
  });

  it('returns a trimmed concrete version string', () => {
    expect(normalizeVersionPin('0.88.0')).toBe('0.88.0');
    expect(normalizeVersionPin('  0.88.0 ')).toBe('0.88.0');
  });
});

describe('agentVersionPinsSchema', () => {
  it('accepts optional agent/watchdog strings', () => {
    expect(agentVersionPinsSchema.parse({})).toEqual({});
    expect(agentVersionPinsSchema.parse({ agent: '0.88.0' })).toEqual({ agent: '0.88.0' });
    expect(agentVersionPinsSchema.parse({ agent: 'latest', watchdog: '0.87.0' })).toEqual({
      agent: 'latest',
      watchdog: '0.87.0',
    });
  });

  it('rejects unknown keys and over-long values', () => {
    expect(() => agentVersionPinsSchema.parse({ helper: '0.1.0' })).toThrow();
    expect(() => agentVersionPinsSchema.parse({ agent: 'x'.repeat(21) })).toThrow();
    expect(() => agentVersionPinsSchema.parse({ agent: '' })).toThrow();
  });

  it('exposes exactly agent and watchdog as the pinnable components', () => {
    expect([...PINNABLE_COMPONENTS]).toEqual(['agent', 'watchdog']);
  });
});

describe('extractAgentVersionPins', () => {
  it('pulls normalized pins from a settings.defaults object', () => {
    expect(
      extractAgentVersionPins({ agentVersionPins: { agent: '0.88.0', watchdog: 'latest' } }),
    ).toEqual({ agent: '0.88.0', watchdog: null });
  });

  it('is null-safe for missing / malformed input', () => {
    expect(extractAgentVersionPins(undefined)).toEqual({ agent: null, watchdog: null });
    expect(extractAgentVersionPins(null)).toEqual({ agent: null, watchdog: null });
    expect(extractAgentVersionPins({})).toEqual({ agent: null, watchdog: null });
    expect(extractAgentVersionPins({ agentVersionPins: 'nope' })).toEqual({
      agent: null,
      watchdog: null,
    });
  });
});

// The SINGLE SOURCE for the org/partner inherit-with-override precedence
// (issue #2124) — both getOrgAgentUpdateConfig (routes/agents/helpers.ts) and
// getOrgAgentVersionPinsBatch (services/orgAgentVersionPins.ts, issue #5285)
// call this instead of re-deriving it, so the two callers can never drift.
describe('resolveInheritedAgentVersionPins', () => {
  it('no pin anywhere -> both components track global latest (null)', () => {
    expect(resolveInheritedAgentVersionPins({}, {})).toEqual({ agent: null, watchdog: null });
    expect(resolveInheritedAgentVersionPins(undefined, undefined)).toEqual({
      agent: null,
      watchdog: null,
    });
  });

  it('org pin only -> uses the org pin (no partner pin to inherit)', () => {
    expect(
      resolveInheritedAgentVersionPins({ agentVersionPins: { agent: '0.88.0' } }, {}),
    ).toEqual({ agent: '0.88.0', watchdog: null });
  });

  it('partner pin only -> org inherits the partner pin', () => {
    expect(
      resolveInheritedAgentVersionPins({}, { agentVersionPins: { watchdog: '0.87.0' } }),
    ).toEqual({ agent: null, watchdog: '0.87.0' });
  });

  it('org pin OVERRIDES the partner pin (inherit-with-override, not a lock)', () => {
    expect(
      resolveInheritedAgentVersionPins(
        { agentVersionPins: { agent: '0.80.0', watchdog: '0.80.0' } },
        { agentVersionPins: { agent: '0.88.0' } },
      ),
    ).toEqual({ agent: '0.80.0', watchdog: '0.80.0' });
  });

  it('org inherits the partner pin per component where the org has not set it', () => {
    expect(
      resolveInheritedAgentVersionPins(
        { agentVersionPins: { watchdog: '0.70.0' } },
        { agentVersionPins: { agent: '0.88.0' } },
      ),
    ).toEqual({ agent: '0.88.0', watchdog: '0.70.0' });
  });

  it("an org 'latest' deliberately overrides a partner pin back to global latest (presence-keyed, not truthiness)", () => {
    expect(
      resolveInheritedAgentVersionPins(
        { agentVersionPins: { agent: 'latest' } },
        { agentVersionPins: { agent: '0.88.0' } },
      ),
    ).toEqual({ agent: null, watchdog: null });
  });

  it('is null-safe for missing / malformed input on either side', () => {
    expect(resolveInheritedAgentVersionPins(null, null)).toEqual({ agent: null, watchdog: null });
    expect(resolveInheritedAgentVersionPins('nope', 42)).toEqual({ agent: null, watchdog: null });
  });
});
