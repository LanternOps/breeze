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

  // The deferred human-fanout path
  // (intentService.ts) never threads the guardrail's `reason` — it always
  // rebuilds the label from tool + arguments alone, so the generic fallback
  // (which only reads action/commandType/serviceName/processName/scriptName/
  // name) previously showed the bare tool name for these mail/calendar
  // tools, with no destination address, on the mobile takeover/push surface.
  describe('Google external-destination fallback (no reason threaded)', () => {
    it('google_set_forwarding names the destination and flags a cross-domain one', () => {
      const label = buildActionLabel({
        toolName: 'google_set_forwarding',
        input: { userEmail: 'alice@acme.example', forwardTo: 'ext-recipient@foreign.example' },
      });
      expect(label).toContain('ext-recipient@foreign.example');
      expect(label).toContain('different domain from source mailbox');
    });

    it('google_set_forwarding to a same-domain destination has no domain-mismatch flag', () => {
      const label = buildActionLabel({
        toolName: 'google_set_forwarding',
        input: { userEmail: 'alice@acme.example', forwardTo: 'bob@acme.example' },
      });
      expect(label).toContain('bob@acme.example');
      expect(label).not.toContain('different domain from source mailbox');
    });

    it('google_add_mail_delegate names the delegate and flags a cross-domain one', () => {
      const label = buildActionLabel({
        toolName: 'google_add_mail_delegate',
        input: { userEmail: 'alice@acme.example', delegateEmail: 'ext-recipient@foreign.example' },
      });
      expect(label).toContain('ext-recipient@foreign.example');
      expect(label).toContain('different domain from source mailbox');
    });

    it('google_share_calendar names the share target and flags a cross-domain one', () => {
      const label = buildActionLabel({
        toolName: 'google_share_calendar',
        input: { ownerEmail: 'alice@acme.example', shareWithEmail: 'ext-recipient@foreign.example' },
      });
      expect(label).toContain('ext-recipient@foreign.example');
      expect(label).toContain('different domain from source mailbox');
    });

    it('google_disable_forwarding names and flags the removed address when removeAddress is set', () => {
      const label = buildActionLabel({
        toolName: 'google_disable_forwarding',
        input: {
          userEmail: 'alice@acme.example',
          forwardTo: 'ext-recipient@foreign.example',
          removeAddress: true,
        },
      });
      expect(label).toContain('ext-recipient@foreign.example');
      expect(label).toContain('different domain from source mailbox');
    });

    it('google_disable_forwarding without removeAddress falls back to the generic label, not a stale destination', () => {
      const label = buildActionLabel({
        toolName: 'google_disable_forwarding',
        input: { userEmail: 'alice@acme.example', forwardTo: 'ext-recipient@foreign.example' },
      });
      expect(label).not.toContain('ext-recipient@foreign.example');
    });
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
