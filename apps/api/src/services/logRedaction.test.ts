import { describe, expect, it } from 'vitest';
import {
  redactAgentLogFields,
  redactAgentLogMessage,
  redactAgentLogRow,
  redactLogFields,
  redactLogMessage,
  redactSensitiveValueShapes,
} from './logRedaction';

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

// #3109. Key-name redaction blanked the `session` key while the SAME Windows
// identifier survived verbatim inside the `error` string of the same row.
// These cover the value-shape pass that closes it, and — just as importantly —
// pin the boundary that keeps it OFF the shared redactors.
describe('value-shape redaction on the agent-log path (#3109)', () => {
  it('scrubs the reported row: identifier redacted in `error`, not just `session`', () => {
    // Verbatim shape from the production agent_logs row in the issue.
    const row = {
      id: 'log-1',
      message: 'command dispatch failed',
      fields: {
        error: 'duplicate in-flight command id: "desk-abc" (session "helper-CONTOSO\\WKSTN-01$-65864")',
        attempt: 1,
        session: 'helper-CONTOSO\\WKSTN-01$-65864',
        component: 'heartbeat',
      },
    };

    const out = redactAgentLogRow(row);
    const fields = out.fields as Record<string, unknown>;

    // The key-name rule still blanks `session` outright.
    expect(fields.session).toBe('[REDACTED]');
    // The regression: the sibling free-text field must not carry it either.
    expect(fields.error).not.toContain('CONTOSO');
    expect(fields.error).not.toContain('WKSTN-01');
    // Non-identifying context survives, so the row stays diagnosable.
    expect(fields.error).toContain('duplicate in-flight command id');
    expect(fields.error).toContain('desk-abc');
    expect(fields.attempt).toBe(1);
    expect(fields.component).toBe('heartbeat');
  });

  it('fires regardless of which key carries the value', () => {
    const leak = 'ran as CONTOSO\\WKSTN-01$';
    for (const key of ['error', 'detail', 'component', 'anythingAtAll']) {
      const out = redactAgentLogFields({ [key]: leak }) as Record<string, string>;
      expect(out[key], `key ${key}`).not.toContain('CONTOSO');
    }
  });

  it('redacts the legacy helper/assist session-id grammar from un-upgraded agents', () => {
    // The Go agent now mints an opaque id, but deployed agents keep sending the
    // old grammar until the fleet rolls; the Tauri assist helper sends its own.
    expect(redactSensitiveValueShapes('(session "helper-jdoe-65864")')).toBe(
      '(session "helper-[REDACTED]")'
    );
    expect(redactSensitiveValueShapes('session assist-jdoe-12345 closed')).toBe(
      'session assist-[REDACTED] closed'
    );
  });

  it('leaves the new opaque helper id alone — it carries no identity to scrub', () => {
    const opaque = 'helper-a1b2c3d4e5f60718';
    expect(redactSensitiveValueShapes(`(session "${opaque}")`)).toContain(opaque);
  });

  it('drops the user segment from home directories but keeps the path', () => {
    expect(redactSensitiveValueShapes('openfdat C:\\Users\\jdoe\\AppData\\Local\\Breeze')).toBe(
      'openfdat C:\\Users\\[REDACTED]\\AppData\\Local\\Breeze'
    );
    expect(redactSensitiveValueShapes('stat /home/jdoe/.config/breeze: no such file')).toBe(
      'stat /home/[REDACTED]/.config/breeze: no such file'
    );
    expect(redactSensitiveValueShapes('/Users/jdoe/Library/Logs')).toBe(
      '/Users/[REDACTED]/Library/Logs'
    );
  });

  it('keeps machine-generic Windows paths intact', () => {
    // From the second-instance measurement in the issue: these are the highest
    // volume `error` values and carry no identity. Scrubbing them would cost
    // diagnostics for nothing.
    const generic = 'fork/exec C:\\WINDOWS\\system32\\dsregcmd.exe: The paging file is too small';
    expect(redactSensitiveValueShapes(generic)).toBe(generic);
    const programData = 'openfdat C:\\ProgramData\\Breeze\\sessions: The parameter is incorrect.';
    expect(redactSensitiveValueShapes(programData)).toBe(programData);
  });

  it('redacts the host out of a UNC path but keeps the share', () => {
    expect(redactSensitiveValueShapes('copy \\\\FILESRV01\\deploy\\agent.msi failed')).toBe(
      'copy \\\\[REDACTED]\\deploy\\agent.msi failed'
    );
  });

  it('redacts Windows machine accounts', () => {
    expect(redactSensitiveValueShapes('token owner CONTOSO\\WKSTN-01$ denied')).toBe(
      'token owner [REDACTED] denied'
    );
  });

  it('redacts username assignments inside free text', () => {
    expect(redactSensitiveValueShapes('spawn failed username=jdoe pid=4120')).toBe(
      'spawn failed username=[REDACTED] pid=4120'
    );
    expect(redactSensitiveValueShapes('upn: jdoe@contoso.com')).toBe('upn: [REDACTED]');
  });

  describe('IP literals — routable addresses only', () => {
    it('redacts a globally routable IPv4 address', () => {
      expect(redactSensitiveValueShapes('dial tcp 203.44.19.7:443: timeout')).toBe(
        'dial tcp [REDACTED]:443: timeout'
      );
    });

    it('keeps private, loopback, link-local and CGNAT addresses', () => {
      // Network discovery and connectivity logs are the highest-volume users of
      // this path; these addresses are internal topology the MSP already
      // administers and sees as first-class device data, so scrubbing them
      // would buy no privacy and cost the feature its diagnosability.
      for (const ip of ['10.0.1.5', '192.168.1.20', '172.16.4.9', '127.0.0.1', '0.0.0.0', '169.254.3.1', '100.64.0.7']) {
        expect(redactSensitiveValueShapes(`probe ${ip} ok`), ip).toBe(`probe ${ip} ok`);
      }
    });

    it('leaves version numbers and non-address dotted quads alone', () => {
      expect(redactSensitiveValueShapes('agent 0.109.0 build 4')).toBe('agent 0.109.0 build 4');
      expect(redactSensitiveValueShapes('schema 999.888.777.666')).toBe('schema 999.888.777.666');
    });

    it('redacts a global-unicast IPv6 address', () => {
      expect(redactSensitiveValueShapes('dial 2001:db8::42 refused')).toBe('dial [REDACTED] refused');
    });

    it('keeps link-local, ULA and loopback IPv6', () => {
      for (const ip of ['fe80::1c2d', 'fd00::5', '::1']) {
        expect(redactSensitiveValueShapes(`bind ${ip}`), ip).toBe(`bind ${ip}`);
      }
    });

    it('does not mistake clock times or MAC addresses for IPv6', () => {
      const withTime = 'started at 14:23:45 after 00:00:02';
      expect(redactSensitiveValueShapes(withTime)).toBe(withTime);
      const withMac = 'nic 00:1a:2b:3c:4d:5e up';
      expect(redactSensitiveValueShapes(withMac)).toBe(withMac);
      const iso = 'ts=2026-09-03T14:23:45.123Z level=info';
      expect(redactSensitiveValueShapes(iso)).toBe(iso);
    });
  });

  // The scoping decision, pinned. redactLogMessage/redactLogFields are shared
  // with services/aiToolOutput.ts (LLM tool output AND persisted
  // ai_messages.tool_input), services/auditPayloadSanitizer.ts, jobs/dnsSyncJob.ts,
  // jobs/s1Sync.ts and services/sentinelOne/actions.ts, where an address or a
  // path is the payload rather than a leak. Widening the shared redactors would
  // silently break those; this test fails if someone does.
  describe('scope boundary: the shared redactors are unchanged', () => {
    it('redactLogMessage does not apply value-shape rules', () => {
      const text = 'dial tcp 203.44.19.7:443 from C:\\Users\\jdoe failed';
      expect(redactLogMessage(text)).toBe(text);
    });

    it('redactLogFields does not apply value-shape rules', () => {
      const fields = { error: 'unreachable 203.44.19.7', path: '/home/jdoe/x' };
      expect(redactLogFields(fields)).toEqual(fields);
    });

    it('still redacts secret assignments on the agent path', () => {
      expect(redactAgentLogMessage('login password=hunter2')).toBe('login password=[REDACTED]');
    });
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

