import { describe, expect, it } from 'vitest';
import { redactAgentLogRow, redactLogFields, redactLogMessage } from './logRedaction';

describe('log redaction', () => {
  it('redacts common secret assignments in messages', () => {
    expect(redactLogMessage('failed login password=hunter2 token="abc123"')).toBe(
      'failed login password=[REDACTED] token=[REDACTED]'
    );
  });

  it('redacts nested secret fields without dropping non-secret context', () => {
    expect(redactLogFields({
      command: 'install',
      env: {
        API_KEY: 'secret-key',
        path: '/opt/breeze',
      },
      output: 'Authorization: Bearer raw-token',
    })).toEqual({
      command: 'install',
      env: {
        API_KEY: '[REDACTED]',
        path: '/opt/breeze',
      },
      output: 'Authorization: Bearer [REDACTED]',
    });
  });

  it('redacts Pi-hole-style ?auth= URL query params (catches a real leak vector)', () => {
    // Pi-hole puts the API key in the URL query string. If a Node fetch
    // error echoes the URL, the API key ends up in dnsFilterIntegrations.
    // lastSyncError verbatim. The `auth` alternative in the assignment
    // pattern strips it before persistence.
    expect(redactLogMessage('fetch failed for http://pi.hole/admin/api.php?auth=brz_pihole_secret&getAllQueries=true')).toBe(
      'fetch failed for http://pi.hole/admin/api.php?auth=[REDACTED]&getAllQueries=true'
    );
  });

  // #3129. Plain assignment to the literal key `__proto__` hits the setter
  // inherited from Object.prototype, so the field silently disappears from the
  // output — and when the value is an object, the returned object's prototype is
  // replaced with it. These assert the field survives AND the prototype does not
  // move, because a fix that only restored the key could still reprototype.
  describe('__proto__ handling (#3129)', () => {
    it('preserves a __proto__ subtree instead of dropping it', () => {
      const out = redactLogFields(JSON.parse('{"__proto__":{"inner":"kept"},"other":1}')) as Record<string, unknown>;

      expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true);
      expect(Object.keys(out)).toContain('__proto__');
      expect((out as any).__proto__).toEqual({ inner: 'kept' });
      expect(out.other).toBe(1);
    });

    it('does not let a __proto__ value reprototype the redacted object', () => {
      const out = redactLogFields(JSON.parse('{"__proto__":{"polluted":"yes"}}')) as Record<string, unknown>;

      expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
      // The value must be readable as data, never inherited behaviour.
      expect(({} as any).polluted).toBeUndefined();
    });

    it('preserves a primitive __proto__ value, which the setter discards outright', () => {
      const out = redactLogFields(JSON.parse('{"__proto__":"just-a-string"}')) as Record<string, unknown>;

      expect((out as any).__proto__).toBe('just-a-string');
      expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    });

    it('still redacts a secret-named key nested under __proto__', () => {
      const out = redactLogFields(JSON.parse('{"__proto__":{"password":"hunter2"}}')) as Record<string, unknown>;

      expect((out as any).__proto__).toEqual({ password: '[REDACTED]' });
    });

    it('survives JSON round-trip with the key intact', () => {
      const out = redactLogFields(JSON.parse('{"__proto__":{"inner":"kept"}}'));
      const round = JSON.parse(JSON.stringify(out));

      expect(Object.prototype.hasOwnProperty.call(round, '__proto__')).toBe(true);
      expect(round.__proto__).toEqual({ inner: 'kept' });
    });
  });

  it('redacts row messages and fields defensively before returning logs', () => {
    expect(redactAgentLogRow({
      id: 'log-1',
      message: 'community=public',
      fields: { authPassword: 'snmp-auth', retries: 1 },
    })).toEqual({
      id: 'log-1',
      message: 'community=[REDACTED]',
      fields: { authPassword: '[REDACTED]', retries: 1 },
    });
  });
});

