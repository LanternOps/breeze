import { describe, expect, it } from 'vitest';

import { canonicalizeArguments, computeArgumentDigest } from './canonicalize';
import { buildActionLabel, describePax8Submit, hasPatchInstallHeadline, hasTicketIdStub } from './actionLabel';
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

it('renders new subscriptions as new quantity on the Pax8 approval card', () => {
  const copy = describePax8Submit({ expectedCompany: { name: 'Fixture', pax8CompanyId: 'company' }, expectedLines: [{ action: 'new_subscription', productName: 'Seats', pax8ProductId: 'product', fromQuantity: null, quantity: '5', unitCost: '8.25', currency: 'USD', billingTerm: 'Monthly', commitmentTerm: 'Annual' }] });
  expect(copy).toContain('new → 5');
  expect(copy).not.toContain('? →');
});

// #11674: the /approvals queue and the mobile push read the stored label, which
// named a ticket by `ticket #<8 hex>...`. It now names it by number, and only
// where the stub is THIS call's ticket.
describe('buildActionLabel — ticket number (#11674)', () => {
  const TICKET_ID = '2aad0601-1111-4222-8333-444455556666';
  const OTHER_TICKET_ID = '7c1e9d02-aaaa-4bbb-8ccc-ddddeeeeffff';

  it('swaps this call\'s ticket stub for the ticket number, end-to-end from a real headline', () => {
    const input = { action: 'comment', ticketId: TICKET_ID, isPublic: true, content: 'Hello' };
    const reason = checkGuardrails('manage_tickets', input).description!;
    expect(reason).toContain('ticket #2aad0601...');
    expect(buildActionLabel({ toolName: 'manage_tickets', input, reason, ticketId: TICKET_ID, ticketNumber: 'T-2026-0001' }))
      .toBe('Post PUBLIC comment on ticket T-2026-0001 (customer-visible; emails the requester)');
  });

  it('leaves a stub naming a different ticket alone', () => {
    expect(buildActionLabel({
      toolName: 'manage_tickets',
      input: { action: 'comment', ticketId: TICKET_ID },
      reason: 'Post internal note on ticket #7c1e9d02...',
      ticketId: TICKET_ID,
      ticketNumber: 'T-2026-0001',
    })).toBe('Post internal note on ticket #7c1e9d02...');
  });

  it('keeps the stub when no number was resolved', () => {
    expect(buildActionLabel({
      toolName: 'manage_tickets',
      input: { action: 'comment', ticketId: TICKET_ID },
      reason: 'Post internal note on ticket #2aad0601...',
      ticketId: TICKET_ID,
      ticketNumber: null,
    })).toBe('Post internal note on ticket #2aad0601...');
  });

  it('substitutes before truncation, so a long headline still names the ticket', () => {
    const reason = `Update ticket #2aad0601... fields (${'x'.repeat(200)})`;
    const label = buildActionLabel({ toolName: 'manage_tickets', input: {}, reason, ticketId: TICKET_ID, ticketNumber: 'T-2026-0001' });
    expect(label.startsWith('Update ticket T-2026-0001 fields')).toBe(true);
    expect(label.length).toBeLessThanOrEqual(140);
  });

  it('hasTicketIdStub matches only this ticket\'s prefix', () => {
    expect(hasTicketIdStub('Set ticket #2aad0601... status to resolved', TICKET_ID)).toBe(true);
    expect(hasTicketIdStub('Set ticket #2AAD0601... status to resolved', TICKET_ID)).toBe(true);
    expect(hasTicketIdStub('Set ticket #2aad0601... status to resolved', OTHER_TICKET_ID)).toBe(false);
    expect(hasTicketIdStub('Manage tickets: merge', TICKET_ID)).toBe(false);
  });
});

// A supervised patch install read "Install 1 patch(es) on 1 device(s)": the
// approver could not see WHICH patch they were signing for. The intent
// service resolves the patches' names (approvalPatchNames.ts) and the label
// names them in place of the count. Counts always come from the arguments.
describe('buildActionLabel — patch names', () => {
  const DEVICE = '6eae0f70-1111-4222-8333-444455556666';
  const OTHER_DEVICE = '7eae0f70-1111-4222-8333-444455556666';
  const patchIds = (n: number) => Array.from({ length: n }, (_, i) => `${String(i).padStart(8, 'a')}-1111-4222-8333-444455556666`);
  const install = (patchCount: number, deviceIds: string[]) =>
    ({ action: 'install', patchIds: patchIds(patchCount), deviceIds });
  const label = (input: Record<string, unknown>, patchNames: string[] | null, deviceHostname?: string) =>
    buildActionLabel({
      toolName: 'manage_patches', input, reason: checkGuardrails('manage_patches', input).description, deviceHostname, patchNames,
    });

  it('names one patch on one device, end-to-end from a real headline', () => {
    expect(label(install(1, [DEVICE]), ['KB5034441'], 'KIT')).toBe('Install KB5034441 on KIT');
  });

  it('names the first two patches and counts the rest', () => {
    expect(label(install(5, [DEVICE, OTHER_DEVICE]), ['KB5034441', '"Google Chrome 120"']))
      .toBe('Install KB5034441, "Google Chrome 120" +3 more on 2 devices');
    expect(label(install(2, [DEVICE, OTHER_DEVICE]), ['KB5034441', 'KB5034122']))
      .toBe('Install KB5034441, KB5034122 on 2 devices');
  });

  it('counts from the arguments, not from how many names resolved', () => {
    expect(label(install(3, [DEVICE, OTHER_DEVICE]), ['KB5034441'])).toBe('Install KB5034441 +2 more on 2 devices');
  });

  it('keeps the counted headline when nothing resolved', () => {
    expect(label(install(2, [DEVICE, OTHER_DEVICE]), null)).toBe('Install 2 patches on 2 devices');
    expect(label(install(2, [DEVICE, OTHER_DEVICE]), [])).toBe('Install 2 patches on 2 devices');
    expect(label(install(1, [DEVICE]), null, 'KIT')).toBe('Install 1 patch on KIT');
  });

  it('only rewrites the exact leading headline for these arguments', () => {
    const input = install(2, [DEVICE, OTHER_DEVICE]);
    const base = { toolName: 'manage_patches', input, patchNames: ['KB5034441'] };
    // A count that does not match these arguments.
    expect(buildActionLabel({ ...base, reason: 'Install 3 patches on 2 devices' })).toBe('Install 3 patches on 2 devices');
    // Not leading: some other text carries it.
    expect(buildActionLabel({ ...base, reason: "Conflicts with a remembered instruction: 'x'. Install 2 patches on 2 devices" }))
      .toBe("Conflicts with a remembered instruction: 'x'. Install 2 patches on 2 devices");
    // Another action or tool.
    expect(buildActionLabel({ ...base, input: { ...input, action: 'rollback' }, reason: 'Install 2 patches on 2 devices' }))
      .toBe('Install 2 patches on 2 devices');
    expect(buildActionLabel({ ...base, toolName: 'run_script', reason: 'Install 2 patches on 2 devices' }))
      .toBe('Install 2 patches on 2 devices');
  });

  it('renames the device before inserting names, so a name carrying a device stub is never given the hostname', () => {
    expect(label(install(1, [DEVICE]), ['"Fix on device 6eae0f70..."'], 'KIT'))
      .toBe('Install "Fix on device 6eae0f70..." on KIT');
  });

  it('fits the 140-character cap without cutting the count or the hostname', () => {
    const title = `"${'T'.repeat(59)}…"`;
    const host = 'FRONT-DESK-WORKSTATION-01';
    const many = label(install(4, [DEVICE]), [title, title], host);
    expect(many.length).toBeLessThanOrEqual(140);
    expect(many.endsWith(' +3 more on FRONT-DESK-WORKSTATION-01')).toBe(true);
    expect(many.startsWith('Install "TTT')).toBe(true);

    const one = label(install(1, [DEVICE]), [title], 'H'.repeat(100));
    expect(one.length).toBeLessThanOrEqual(140);
    expect(one.endsWith(` on ${'H'.repeat(100)}`)).toBe(true);
    expect(one).toMatch(/^Install "T+…" on H+$/);
  });

  it('never cuts a KB number to fit: half of one names a different patch', () => {
    // Leaves 8 characters for the name: room for a cut-down quoted title, not for KB5034441.
    const host = 'H'.repeat(120);
    const result = label(install(1, [DEVICE]), ['KB5034441'], host);
    expect(result).toBe(`Install 1 patch on ${host}`);
    expect(result).not.toContain('KB');
  });

  it('keeps the counted headline when no name fits beside a very long hostname', () => {
    const host = 'H'.repeat(130);
    expect(label(install(1, [DEVICE]), ['"Some title"'], host).startsWith('Install 1 patch on HHH')).toBe(true);
  });

  it('hasPatchInstallHeadline matches only the leading headline of an install with these counts', () => {
    const input = install(2, [DEVICE, OTHER_DEVICE]);
    expect(hasPatchInstallHeadline('manage_patches', 'Install 2 patches on 2 devices', input)).toBe(true);
    expect(hasPatchInstallHeadline('manage_patches', 'Install 1 patch on device 6eae0f70...', install(1, [DEVICE]))).toBe(true);
    expect(hasPatchInstallHeadline('manage_patches', 'Install 1 patch on 2 devices', input)).toBe(false);
    expect(hasPatchInstallHeadline('manage_patches', 'Note. Install 2 patches on 2 devices', input)).toBe(false);
    expect(hasPatchInstallHeadline('manage_patches', 'Install 2 patches on 2 devices', { ...input, action: 'scan' })).toBe(false);
    expect(hasPatchInstallHeadline('run_script', 'Install 2 patches on 2 devices', input)).toBe(false);
  });
});
