import { describe, expect, it } from 'vitest';
import {
  agentVersionPinsSchema,
  normalizeVersionPin,
  extractAgentVersionPins,
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
