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

