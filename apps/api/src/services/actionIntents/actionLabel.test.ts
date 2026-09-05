import { describe, expect, it } from 'vitest';

import { buildActionLabel } from './actionLabel';

describe('buildActionLabel', () => {
  it('prefers the guardrail description and softens its shouted verb', () => {
    expect(
      buildActionLabel({
        toolName: 'manage_services',
        input: { deviceId: '6eae0f70-8da9-49ff-9e18-c241698975f3', action: 'restart', serviceName: 'Spooler' },
        reason: 'RESTART service "Spooler" on device 6eae0f70...',
      }),
    ).toBe('Restart service "Spooler" on device 6eae0f70...');
  });

  it('swaps the device-id stub for the hostname when known', () => {
    expect(
      buildActionLabel({
        toolName: 'execute_command',
        input: { commandType: 'restart_service' },
        reason: 'Execute "restart_service" command on device 6eae0f70...',
        deviceHostname: 'KIT',
      }),
    ).toBe('Execute "restart_service" command on KIT');
  });

  it('never returns the raw call signature when the reason is missing', () => {
    const label = buildActionLabel({
      toolName: 'manage_services',
      input: { deviceId: '6eae0f70-8da9-49ff-9e18-c241698975f3', action: 'restart', serviceName: 'Spooler' },
      reason: null,
    });
    expect(label).toBe('Manage services: restart Spooler');
    expect(label).not.toContain('deviceId=');
  });

  it('falls back to the tool name alone when nothing recognisable is present', () => {
    expect(buildActionLabel({ toolName: 'run_script', input: { scriptId: 'abc' } })).toBe('Run script');
  });

  it('leaves an already-human M365 summary untouched apart from whitespace', () => {
    expect(
      buildActionLabel({
        toolName: 'm365_reset_password',
        input: {},
        reason: '  Reset password for  jane@contoso.com  (Contoso Ltd)  ',
      }),
    ).toBe('Reset password for jane@contoso.com (Contoso Ltd)');
  });

  it('caps runaway descriptions', () => {
    const label = buildActionLabel({ toolName: 'x', input: {}, reason: 'a'.repeat(400) });
    expect(label.length).toBeLessThanOrEqual(140);
    expect(label.endsWith('…')).toBe(true);
  });
});
