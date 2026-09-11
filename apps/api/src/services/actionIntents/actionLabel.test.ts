import { describe, expect, it } from 'vitest';

import { canonicalizeArguments, computeArgumentDigest } from './canonicalize';
import { buildActionLabel } from './actionLabel';
import { checkGuardrails } from '../aiGuardrails';

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
    // #5173: the underlying aiGuardrails headline is now command-type-aware
    // ('Restart service "Spooler" on device 6eae0f70...' instead of the raw
    // 'Execute "restart_service" command on device 6eae0f70...' signature) —
    // buildActionLabel's substitution must keep matching the SAME
    // "on device <id>..." stub regardless of what precedes it.
    expect(
      buildActionLabel({
        toolName: 'execute_command',
        input: { commandType: 'restart_service', payload: { name: 'Spooler' } },
        reason: 'Restart service "Spooler" on device 6eae0f70...',
        deviceHostname: 'KIT',
      }),
    ).toBe('Restart service "Spooler" on KIT');
  });

  it('swaps the device-id stub for the hostname end-to-end from a real checkGuardrails() headline (#5173)', () => {
    // Unlike the hand-written `reason` strings above, this derives `reason`
    // from the actual aiGuardrails headline builder, proving the new
    // command-type-aware text really does flow guardrail -> label, not just
    // that DEVICE_ID_STUB is prefix-agnostic.
    const deviceId = '6eae0f70-8da9-49ff-9e18-c241698975f3';
    const input = { deviceId, commandType: 'restart_service', payload: { name: 'Spooler' } };
    const guardrail = checkGuardrails('execute_command', input);
    expect(guardrail.description).toBe('Restart service "Spooler" on device 6eae0f70...');

    expect(
      buildActionLabel({
        toolName: 'execute_command',
        input,
        reason: guardrail.description,
        deviceHostname: 'KIT',
      }),
    ).toBe('Restart service "Spooler" on KIT');
  });

  it('still swaps the device-id stub for the hostname on the pre-existing generic signature (no regression)', () => {
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

  it.each([
    [{ name: 'Chosen', serviceName: 'Alternate' }, 'Restart service "Chosen" on KIT'],
    [{ name: '', serviceName: 'Alternate' }, 'Execute "restart_service" command on KIT'],
    [{ name: null, serviceName: 'Alternate' }, 'Execute "restart_service" command on KIT'],
    [{ name: false, serviceName: 'Alternate' }, 'Execute "restart_service" command on KIT'],
    [{ serviceName: 'Alternate' }, 'Restart service "Alternate" on KIT'],
    [{ name: 0, serviceName: 'Alternate' }, 'Restart service "0" on KIT'],
  ] as const)('keeps the dispatch-selected headline through hostname substitution for %j', (payload, expected) => {
    const input = Object.freeze({ deviceId: '6eae0f70-8da9-49ff-9e18-c241698975f3', commandType: 'restart_service', payload: Object.freeze(payload) });
    const canonical = canonicalizeArguments(input);
    const digest = computeArgumentDigest(canonical);
    const guardrail = checkGuardrails('execute_command', input);
    expect(buildActionLabel({ toolName: 'execute_command', input, reason: guardrail.description, deviceHostname: 'KIT' })).toBe(expected);
    expect(canonicalizeArguments(input)).toBe(canonical);
    expect(computeArgumentDigest(canonicalizeArguments(input))).toBe(digest);
    expect(JSON.parse(canonical).payload).toEqual(payload);
  });

  it('keeps both raw aliases digest-bound despite displaying only the selected name', () => {
    const input = { commandType: 'restart_service', payload: { name: 'Chosen', serviceName: 'Alternate' } };
    const before = canonicalizeArguments(input);
    checkGuardrails('execute_command', input);
    expect(canonicalizeArguments(input)).toBe(before);
    const digest = computeArgumentDigest(before);
    expect(digest).not.toBe(computeArgumentDigest(canonicalizeArguments({ ...input, payload: { name: 'Chosen' } })));
    expect(digest).not.toBe(computeArgumentDigest(canonicalizeArguments({ ...input, payload: { ...input.payload, serviceName: 'Changed' } })));
    expect(buildActionLabel({ toolName: 'execute_command', input })).toBe('Execute command: restart_service');
    expect(buildActionLabel({ toolName: 'execute_command', input, reason: 'Explicit caller label' })).toBe('Explicit caller label');
  });

});
